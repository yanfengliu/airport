// The terminals as people use them: three walkable floors cut from the building footprints, and
// the places on them that passengers make for.
//
// The map gives the buildings and some of the rooms inside (check-in halls, a few checkpoints,
// claim halls, customs, shops), not a floor plan. So the plan is made from what SFO is like: each
// terminal is a hall along the roadway loop, with check-in on the departures level and baggage
// claim below it, and concourses running out from the hall to the gates. The landside hall is the
// part of a building within reach of the departures road; the rest of the departures level is
// airside. A concourse's checkpoint is where its walking route from the hall crosses into it.
// Rooms the map does have are used where they are; the rest are placed by those rules.

import { mappedFloors } from './mapped-floors.ts';
import { courtyard3 } from '../../shared/courtyard3.ts';
import type { ClosedRoom, IndoorFloor, Layout, PolygonData } from '../../shared/layout.ts';
import { CONFIG } from '../config.ts';
import { insidePolygon, withinAny } from './fittings.ts';
import { NavGrid, UNREACHABLE } from './grid.ts';

/** The walkable floors, by index into `grids`. */
export const FLOOR = { arrivals: 0, landside: 1, airside: 2 } as const;
/** Height of each floor above the ground, metres: the arrivals level, then the departures level. */
export const FLOOR_HEIGHT = [0.6, 7.2, 7.2] as const;

/** Size of a grid cell, metres. */
const CELL = 2.5;
/**
 * What a step through a mapped wall adds to the way, in tenths of a cell: going round a wall up
 * to 30 m is shorter. Kept small enough that a long way through many walls drawn without their
 * doors still fits the field's sixteen bits.
 */
const WALL_THROUGH = 120;

/** The closed rooms that stay closed, by map. */
const STAY_CLOSED = new WeakMap<Layout, ClosedRoom[]>();

/** Each cell's part of the floor: cells that can be walked between share a number. */
function components(grid: NavGrid): Int32Array {
  const label = new Int32Array(grid.count).fill(-1);
  let next = 0;
  for (let c = 0; c < grid.count; c += 1) {
    if (label[c] >= 0) continue;
    const stack = [c];
    label[c] = next;
    while (stack.length) {
      const id = stack.pop()!;
      for (let k = 0; k < 8; k += 1) {
        const n = grid.neighbours[id * 8 + k];
        if (n >= 0 && label[n] < 0) {
          label[n] = next;
          stack.push(n);
        }
      }
    }
    next += 1;
  }
  return label;
}

/** Whether a point is within `reach` of a ring's edges. */
function nearRing(ring: readonly number[], x: number, y: number, reach: number): boolean {
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const [ax, ay, dx, dy] = [ring[j], ring[j + 1], ring[i] - ring[j], ring[i + 1] - ring[j + 1]];
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - ax - dx * t, y - ay - dy * t) <= reach) return true;
  }
  return false;
}
/** How far into a building from the departures road the landside hall reaches, metres. */
const HALL_DEPTH = 95;
/** A mapped room this close to where a rule would put something is used instead. */
const SNAP = 70;

export type PlaceKind = 'checkin' | 'checkpoint' | 'exit' | 'holdroom' | 'claim' | 'customs' | 'curb' | 'pickup' | 'airtrain' | 'bart' | 'garage' | 'shop' | 'food' | 'lounge';

export interface Place {
  id: number;
  kind: PlaceKind;
  name: string;
  floor: number;
  /** A point on the floor: the centre of its cell. */
  x: number;
  y: number;
  cell: number;
  /** Boarding area letter the place serves, or ''. */
  area: string;
  /** Size of the mapped room, square metres; 0 when the place was put there by rule. */
  size: number;
  /** The mapped room, by index into the layout's indoor areas; -1 when the place was put there by rule. */
  room: number;
  /** Direction people face when queuing here, radians from east. */
  heading: number;
}

export interface TerminalPlan {
  mappedFloors: ReturnType<typeof mappedFloors>;
  grids: NavGrid[];
  /** The rooms closed to travellers that stay closed: none of them cuts off floor that could be walked to without it. */
  closed: ClosedRoom[];
  places: Place[];
  /** Checkpoint, exit lane and customs of each boarding area; holdroom of each contact stand. */
  checkpoint: Map<string, Place>;
  exit: Map<string, Place>;
  customs: Map<string, Place>;
  holdroom: Map<string, Place>;
  /** Baggage claim by boarding area, for domestic and for international arrivals. */
  claim: Map<string, { domestic: Place; international: Place }>;
  /** Check-in halls by airline code. */
  checkin: Map<string, Place[]>;
  /** Ways in and out of the terminals by kind, with the terminal area each is nearest. */
  ways: Place[];
  /** Walking distance field to a place, on its own floor; worked out the first time it is asked for. */
  field(place: Place): Uint16Array;
}

type Vec = [number, number];

function centroid(p: PolygonData): Vec {
  let x = 0;
  let y = 0;
  const n = p.outer.length / 2;
  for (let i = 0; i < p.outer.length; i += 2) {
    x += p.outer[i];
    y += p.outer[i + 1];
  }
  return [x / n, y / n];
}

function area(p: PolygonData): number {
  let twice = 0;
  const r = p.outer;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) twice += r[j] * r[i + 1] - r[i] * r[j + 1];
  return Math.abs(twice / 2);
}

/** Distance from a point to the nearest of many segments, with the segments bucketed by place. */
class SegmentIndex {
  private readonly buckets = new Map<string, number[]>();
  private readonly size: number;

  constructor(segments: readonly number[], size: number) {
    this.size = size;
    for (let i = 0; i < segments.length; i += 4) {
      const [x0, y0, x1, y1] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]];
      for (let bx = Math.floor(Math.min(x0, x1) / size) - 1; bx <= Math.floor(Math.max(x0, x1) / size) + 1; bx += 1) {
        for (let by = Math.floor(Math.min(y0, y1) / size) - 1; by <= Math.floor(Math.max(y0, y1) / size) + 1; by += 1) {
          const key = `${bx},${by}`;
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(x0, y0, x1, y1);
        }
      }
    }
  }

  /** Distance to the nearest segment, or Infinity beyond one bucket. */
  distance(x: number, y: number): number {
    const list = this.buckets.get(`${Math.floor(x / this.size)},${Math.floor(y / this.size)}`);
    if (!list) return Infinity;
    let best = Infinity;
    for (let i = 0; i < list.length; i += 4) {
      const dx = list[i + 2] - list[i];
      const dy = list[i + 3] - list[i + 1];
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - list[i]) * dx + (y - list[i + 1]) * dy) / len2));
      best = Math.min(best, Math.hypot(x - (list[i] + dx * t), y - (list[i + 1] + dy * t)));
    }
    return best;
  }
}

/** Airline codes for the names of check-in halls on the map. */
const CHECKIN_NAMES: [RegExp, string][] = [
  [/united/i, 'UA'],
  [/american/i, 'AA'],
  [/jetblue/i, 'B6'],
  [/southwest/i, 'WN'],
  [/alaska/i, 'AS'],
  [/delta/i, 'DL'],
];

/**
 * Longest walkway from a station, and from the middle of a garage, to the hall it serves, metres:
 * SFO's BART station is about 100 m from the International Terminal's hall, and the garages'
 * middles up to about 230 m from theirs.
 */
const STATION_WALK = 160;
const GARAGE_WALK = 260;

/** Boarding areas in the order they stand round the ring of terminals, each joined to the next after security. */
const RING = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
/** Longest connector, metres: farther apart than this, two concourses are not joined. */
const CONNECTOR_LONGEST = 900;

/**
 * Cells of `whole` (the terminals with no landside or airside) on the ways after security from
 * each concourse to the next round the ring, as SFO's terminals are joined: the shortest walk
 * through the buildings from one concourse's ground to the next one's, three cells wide. The
 * concourses alone, cut off from the halls along the road, are islands; these join them up.
 */
function postSecurityConnectors(whole: NavGrid, airside: NavGrid, doorsByArea: ReadonlyMap<string, Vec[]>): Set<number> {
  const cells = new Set<number>();
  /** Join two pieces of ground, as cells of the whole buildings, by the shortest walk between them, if it is short enough. */
  const join = (from: readonly number[], to: readonly number[]): void => {
    const field = whole.field(to);
    let at = -1;
    for (const c of from) if (at < 0 || field[c] < field[at]) at = c;
    if (at < 0 || field[at] === UNREACHABLE || (field[at] / 10) * CELL > CONNECTOR_LONGEST) return;
    // Downhill to the other piece, with the cells either side.
    for (let guard = 0; field[at] > 0 && guard < 4000; guard += 1) {
      cells.add(at);
      let next = -1;
      for (let k = 0; k < 8; k += 1) {
        const n = whole.neighbours[at * 8 + k];
        if (n < 0) continue;
        cells.add(n);
        if (next < 0 || field[n] < field[next]) next = n;
      }
      if (next < 0 || field[next] >= field[at]) break;
      at = next;
    }
  };
  // Each concourse's ground after security comes in one piece or more, each with some of its gates.
  const seen = new Int32Array(airside.count).fill(-1);
  const ground = new Map<string, number[]>();
  for (const letter of RING) {
    const pieces: { gates: number; cells: number[] }[] = [];
    for (const [x, y] of doorsByArea.get(letter) ?? []) {
      const seed = airside.nearestCell(x, y, 40);
      if (seed < 0) continue;
      if (seen[seed] >= 0) {
        const piece = pieces.find((p) => p.cells[0] === seen[seed]);
        if (piece) piece.gates += 1;
        continue;
      }
      const queue = [seed];
      seen[seed] = seed;
      for (let i = 0; i < queue.length; i += 1) {
        for (let k = 0; k < 8; k += 1) {
          const n = airside.neighbours[queue[i] * 8 + k];
          if (n >= 0 && seen[n] < 0) {
            seen[n] = seed;
            queue.push(n);
          }
        }
      }
      pieces.push({ gates: 1, cells: queue });
    }
    if (!pieces.length) continue;
    const inWhole = (piece: { cells: number[] }): number[] => piece.cells.map((id) => whole.cellAt(airside.cx[id], airside.cy[id])).filter((c) => c >= 0);
    // The pieces of one concourse are joined to the one with most gates.
    pieces.sort((p, q) => q.gates - p.gates);
    const main = inWhole(pieces[0]);
    for (const piece of pieces.slice(1)) join(inWhole(piece), main);
    ground.set(letter, pieces.flatMap(inWhole));
  }
  for (let i = 0; i + 1 < RING.length; i += 1) {
    const from = ground.get(RING[i]);
    const to = ground.get(RING[i + 1]);
    if (from && to) join(from, to);
  }
  return cells;
}

export function buildTerminalPlan(layout: Layout, airlines: readonly { code: string; areas: readonly string[]; internationalAreas: readonly string[] }[] = []): TerminalPlan {
  const buildings = layout.terminals.buildings.map((b) => b.poly);
  // The departures road along the front of every hall.
  const segments: number[] = [];
  for (const e of layout.roads.edges) {
    if (e.name !== 'Departures') continue;
    for (let i = 3; i < e.pts.length; i += 3) segments.push(e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]);
  }
  const road = new SegmentIndex(segments, HALL_DEPTH);
  const landside = (x: number, y: number): boolean => road.distance(x, y) < HALL_DEPTH;
  // Courtyard 3 is a departures-level gallery, mapped separately from the two terminal shells.
  // Only passengers already on the gate side may use its floor outside those shells.
  const gallery = courtyard3(layout.terminals);
  const departures = gallery ? [...buildings, gallery] : buildings;
  const floorPolygons = [buildings, buildings, departures];
  const whole = new NavGrid(departures, CELL);
  const doorsByArea = new Map<string, Vec[]>();
  for (const s of layout.airfield.stands) {
    if (!s.contact || !s.door || !/^[A-G]$/.test(s.area)) continue;
    const list = doorsByArea.get(s.area) ?? [];
    list.push(s.door);
    doorsByArea.set(s.area, list);
  }
  const connectors = postSecurityConnectors(whole, new NavGrid(departures, CELL, (x, y) => !landside(x, y)), doorsByArea);
  // The floors people walk: the halls as mapped, without the rooms closed to travellers in them.
  // A closed room at a gate's door is open after all, and so is one whose closing would split
  // floor that could be walked across without it, as a corridor mapped as a room would.
  const keep = [landside, landside, (x: number, y: number): boolean => !landside(x, y) || connectors.has(whole.cellAt(x, y))];
  const floorOf = (floor: number): IndoorFloor => (floor === FLOOR.arrivals ? 'arrivals' : 'departures');
  const doors = layout.airfield.stands.filter((s) => s.contact && s.door).map((s) => s.door!);
  const known = STAY_CLOSED.get(layout);
  let closed = known ?? (layout.terminals.closed ?? []).filter((r) => !doors.some(([x, y]) => insidePolygon(r.poly, x, y) || nearRing(r.poly.outer, x, y, 6)));
  const grids: NavGrid[] = [];
  // Which stay closed is the same for every simulation of a map: worked out for its first.
  if (known) {
    for (const floor of [FLOOR.arrivals, FLOOR.landside, FLOOR.airside]) {
      const inRoom = withinAny(closed.filter((r) => r.floor === floorOf(floor)).map((r) => r.poly));
      grids[floor] = new NavGrid(floorPolygons[floor], CELL, (x, y) => keep[floor](x, y) && !inRoom(x, y));
    }
  }
  for (let round = 0; round < 6 && !known; round += 1) {
    const reopen = new Set<ClosedRoom>();
    for (const floor of [FLOOR.arrivals, FLOOR.landside, FLOOR.airside]) {
      const rooms = closed.filter((r) => r.floor === floorOf(floor));
      const inRoom = withinAny(rooms.map((r) => r.poly));
      const grid = new NavGrid(floorPolygons[floor], CELL, (x, y) => keep[floor](x, y) && !inRoom(x, y));
      grids[floor] = grid;
      const open = new NavGrid(floorPolygons[floor], CELL, keep[floor]);
      const was = components(open);
      const is = components(grid);
      // Within each stretch of floor that was one, the parts it now falls into, by size.
      const parts = new Map<number, Map<number, number>>();
      for (let c = 0; c < grid.count; c += 1) {
        const before = was[open.cellAt(grid.cx[c], grid.cy[c])];
        const m = parts.get(before) ?? parts.set(before, new Map()).get(before)!;
        m.set(is[c], (m.get(is[c]) ?? 0) + 1);
      }
      for (let c = 0; c < grid.count; c += 1) {
        const m = parts.get(was[open.cellAt(grid.cx[c], grid.cy[c])])!;
        if (m.size < 2) continue;
        const biggest = [...m].sort((p, q) => q[1] - p[1])[0][0];
        if (is[c] === biggest) continue;
        // Cut off from the rest of what it was part of: open the closed rooms beside it.
        for (const r of rooms) if (nearRing(r.poly.outer, grid.cx[c], grid.cy[c], CELL * 1.5)) reopen.add(r);
      }
    }
    if (!reopen.size) break;
    closed = closed.filter((r) => !reopen.has(r));
  }
  STAY_CLOSED.set(layout, closed);
  // The walls drawn inside: a step across one costs a long way round.
  for (const w of layout.terminals.walls ?? []) {
    for (const floor of w.floor === 'arrivals' ? [FLOOR.arrivals] : [FLOOR.landside, FLOOR.airside]) {
      for (let i = 2; i < w.pts.length; i += 2) grids[floor].addWall(w.pts[i - 2], w.pts[i - 1], w.pts[i], w.pts[i + 1], WALL_THROUGH);
    }
  }

  const places: Place[] = [];
  const add = (kind: PlaceKind, name: string, floor: number, x: number, y: number, extra: Partial<Place> = {}): Place | null => {
    const grid = grids[floor];
    const cell = grid.nearestCell(x, y, 60);
    if (cell < 0) return null;
    const place: Place = { id: places.length, kind, name, floor, x: grid.cx[cell], y: grid.cy[cell], cell, area: '', size: 0, room: -1, heading: 0, ...extra };
    places.push(place);
    return place;
  };

  // ---- concourses: where each boarding area's route from its hall crosses into it --------------
  const securityRooms = layout.terminals.areas.flatMap((a, room) => (a.kind === 'security' ? [{ at: centroid(a.poly), size: area(a.poly), room }] : []));
  const checkpoint = new Map<string, Place>();
  const exit = new Map<string, Place>();
  for (const [letter, doors] of [...doorsByArea.entries()].sort()) {
    const goals = doors.map(([x, y]) => whole.nearestCell(x, y, 40)).filter((c) => c >= 0);
    const toGates = whole.field(goals);
    // The landside cell next to an airside cell that is nearest these gates on foot.
    let best = -1;
    let bestCost = UNREACHABLE;
    let into: Vec = [0, 0];
    for (let id = 0; id < whole.count; id += 1) {
      const x = whole.cx[id];
      const y = whole.cy[id];
      if (!landside(x, y) || toGates[id] >= bestCost) continue;
      for (let k = 0; k < 8; k += 1) {
        const n = whole.neighbours[id * 8 + k];
        if (n < 0 || landside(whole.cx[n], whole.cy[n])) continue;
        best = id;
        bestCost = toGates[id];
        into = [whole.cx[n] - x, whole.cy[n] - y];
        break;
      }
    }
    if (best < 0) continue;
    let [x, y] = [whole.cx[best], whole.cy[best]];
    let size = 0;
    let room = -1;
    // A mapped checkpoint nearby is the real one.
    const mapped = securityRooms.filter((r) => Math.hypot(r.at[0] - x, r.at[1] - y) < SNAP).sort((a, b) => Math.hypot(a.at[0] - x, a.at[1] - y) - Math.hypot(b.at[0] - x, b.at[1] - y))[0];
    if (mapped) {
      [x, y] = mapped.at;
      size = mapped.size;
      room = mapped.room;
    }
    // Two concourses entered from one spot share a checkpoint.
    const shared = [...checkpoint.values()].find((c) => Math.hypot(c.x - x, c.y - y) < 30);
    const heading = Math.atan2(into[1], into[0]);
    const cp = shared ?? add('checkpoint', `Checkpoint ${letter}`, FLOOR.landside, x, y, { area: letter, size, room, heading });
    if (!cp) continue;
    if (shared) cp.name += `/${letter}`;
    checkpoint.set(letter, cp);
    const out = add('exit', `Exit ${letter}`, FLOOR.airside, x + into[0] * 4, y + into[1] * 4, { area: letter, heading: heading + Math.PI });
    if (out) exit.set(letter, out);
  }

  // ---- holdrooms: inside the concourse at each gate's door ------------------------------------
  const holdroom = new Map<string, Place>();
  for (const s of layout.airfield.stands) {
    if (!s.contact || !s.door) continue;
    // People boarding face the jet bridge: away from the terminal, the way the aircraft's nose points back.
    const place = add('holdroom', `Gate ${s.id}`, FLOOR.airside, s.door[0], s.door[1], { area: s.area, heading: s.heading + Math.PI });
    if (place) holdroom.set(s.id, place);
  }

  // ---- customs, for arrivals at the international gates ----------------------------------------
  const customs = new Map<string, Place>();
  layout.terminals.areas.forEach((a, room) => {
    const m = a.kind === 'customs' && a.name ? /Primary screening ([A-G])/i.exec(a.name) : null;
    if (!m) return;
    const [x, y] = centroid(a.poly);
    const place = add('customs', `Customs ${m[1]}`, FLOOR.airside, x, y, { area: m[1], size: area(a.poly), room });
    if (place) customs.set(m[1], place);
  });

  // ---- baggage claim -------------------------------------------------------------------------
  const claimRooms = layout.terminals.areas
    .flatMap((a, room) => {
      if (a.kind !== 'claim') return [];
      const [x, y] = centroid(a.poly);
      return [add('claim', a.name ?? 'Baggage claim', FLOOR.arrivals, x, y, { size: area(a.poly), room })];
    })
    .filter((p): p is Place => p !== null);
  const claim = new Map<string, { domestic: Place; international: Place }>();
  for (const [letter, out] of exit) {
    const named = (re: RegExp): Place | undefined => claimRooms.find((c) => re.test(c.name));
    const nearest = [...claimRooms].sort((a, b) => Math.hypot(a.x - out.x, a.y - out.y) - Math.hypot(b.x - out.x, b.y - out.y))[0];
    const fallback = nearest ?? add('claim', `Baggage claim ${letter}`, FLOOR.arrivals, out.x, out.y);
    if (!fallback) continue;
    const domestic = named(new RegExp(`^Domestic baggage claim ${letter}$`, 'i')) ?? named(new RegExp(`^Baggage claim ${letter}$`, 'i')) ?? fallback;
    const international = named(new RegExp(`^Baggage claim ${letter}$`, 'i')) ?? domestic;
    claim.set(letter, { domestic, international });
  }

  // ---- check-in: named halls for the airlines that have them, the nearest hall for the rest ----
  const checkinRooms = layout.terminals.areas
    .flatMap((a, room) => {
      if (a.kind !== 'checkin' || /re-check/i.test(a.name ?? '')) return [];
      const [x, y] = centroid(a.poly);
      const place = add('checkin', a.name ?? 'Check-in', FLOOR.landside, x, y, { size: area(a.poly), room });
      return [place && { place, code: CHECKIN_NAMES.find(([re]) => re.test(a.name ?? ''))?.[1] ?? '' }];
    })
    .filter((p): p is { place: Place; code: string } => p !== null);
  const checkin = new Map<string, Place[]>();
  for (const airline of airlines) {
    // Every hall named for the airline: a big carrier has several.
    const own = checkinRooms.filter((r) => r.code === airline.code).map((r) => r.place);
    if (own.length) {
      checkin.set(airline.code, own);
      continue;
    }
    // Otherwise the two unnamed halls nearest the checkpoint of the airline's first boarding area.
    const cp = checkpoint.get(airline.internationalAreas[0] ?? '') ?? checkpoint.get(airline.areas[0] ?? '');
    if (!cp) continue;
    const near = checkinRooms
      .filter((r) => !r.code && Math.hypot(r.place.x - cp.x, r.place.y - cp.y) < 400)
      .sort((a, b) => Math.hypot(a.place.x - cp.x, a.place.y - cp.y) - Math.hypot(b.place.x - cp.x, b.place.y - cp.y))
      .slice(0, 2)
      .map((r) => r.place);
    if (near.length) checkin.set(airline.code, near);
    else {
      const made = add('checkin', `${airline.code} check-in`, FLOOR.landside, cp.x - Math.cos(cp.heading) * 40, cp.y - Math.sin(cp.heading) * 40, { area: cp.area });
      if (made) checkin.set(airline.code, [made]);
    }
  }

  // ---- ways in and out ---------------------------------------------------------------------
  const ways: Place[] = [];
  const pushWay = (place: Place | null): void => {
    if (place) ways.push(place);
  };
  for (const e of layout.roads.edges) {
    if ((e.name !== 'Departures' && e.name !== 'Arrivals') || e.len < 45) continue;
    const mid = Math.floor(e.pts.length / 6) * 3;
    const floor = e.name === 'Departures' ? FLOOR.landside : FLOOR.arrivals;
    pushWay(add(e.name === 'Departures' ? 'curb' : 'pickup', `${e.name} curb`, floor, e.pts[mid], e.pts[mid + 1]));
  }
  // Stations and garages stand apart from the halls, joined to them by walkways and skybridges:
  // people from them come in where the walkway meets the nearest hall.
  const viaWalkway = (kind: PlaceKind, name: string, x: number, y: number, reach: number): void => {
    const grid = grids[FLOOR.landside];
    const cell = grid.nearestCell(x, y, reach);
    if (cell >= 0) pushWay(add(kind, name, FLOOR.landside, grid.cx[cell], grid.cy[cell]));
  };
  for (const s of layout.rail.stations) {
    if (s.kind === 'caltrain' || (s.kind === 'airtrain' && s.name === CONFIG.transit.closedAirTrainStation)) continue;
    viaWalkway(s.kind === 'bart' ? 'bart' : 'airtrain', s.name, s.x, s.y, STATION_WALK);
  }
  for (const b of layout.buildings.buildings) {
    if (b.kind !== 'garage' || !b.name) continue;
    const [x, y] = centroid(b.poly);
    viaWalkway('garage', b.name, x, y, GARAGE_WALK);
  }

  // ---- shops, places to eat, lounges ---------------------------------------------------------
  layout.terminals.areas.forEach((a, room) => {
    if (a.kind !== 'shop' && a.kind !== 'food' && a.kind !== 'lounge') return;
    const [x, y] = centroid(a.poly);
    // Mostly beyond security; a few in the halls.
    const air = grids[FLOOR.airside].nearestCell(x, y, 25);
    const floor = air >= 0 ? FLOOR.airside : FLOOR.landside;
    add(a.kind, a.name ?? (a.kind === 'food' ? 'Café' : a.kind === 'shop' ? 'Shop' : 'Lounge'), floor, x, y, { size: area(a.poly), room });
  });

  const fields = new Map<number, Uint16Array>();
  return {
    mappedFloors: mappedFloors(layout.terminals, places),
    grids,
    closed,
    places,
    checkpoint,
    exit,
    customs,
    holdroom,
    claim,
    checkin,
    ways,
    field(place: Place): Uint16Array {
      let f = fields.get(place.id);
      if (!f) {
        f = grids[place.floor].field([place.cell]);
        fields.set(place.id, f);
      }
      return f;
    },
  };
}
