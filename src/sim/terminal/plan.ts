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

import type { Layout, PolygonData } from '../../shared/layout.ts';
import { NavGrid, UNREACHABLE } from './grid.ts';

/** The walkable floors, by index into `grids`. */
export const FLOOR = { arrivals: 0, landside: 1, airside: 2 } as const;
/** Height of each floor above the ground, metres: the arrivals level, then the departures level. */
export const FLOOR_HEIGHT = [0.6, 7.2, 7.2] as const;

/** Size of a grid cell, metres. */
const CELL = 2.5;
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
  /** Direction people face when queuing here, radians from east. */
  heading: number;
}

export interface TerminalPlan {
  grids: NavGrid[];
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
  const grids: NavGrid[] = [];
  grids[FLOOR.arrivals] = new NavGrid(buildings, CELL, landside);
  grids[FLOOR.landside] = new NavGrid(buildings, CELL, landside);
  grids[FLOOR.airside] = new NavGrid(buildings, CELL, (x, y) => !landside(x, y));
  const whole = new NavGrid(buildings, CELL);

  const places: Place[] = [];
  const add = (kind: PlaceKind, name: string, floor: number, x: number, y: number, extra: Partial<Place> = {}): Place | null => {
    const grid = grids[floor];
    const cell = grid.nearestCell(x, y, 60);
    if (cell < 0) return null;
    const place: Place = { id: places.length, kind, name, floor, x: grid.cx[cell], y: grid.cy[cell], cell, area: '', size: 0, heading: 0, ...extra };
    places.push(place);
    return place;
  };

  // ---- concourses: where each boarding area's route from its hall crosses into it --------------
  const doorsByArea = new Map<string, Vec[]>();
  for (const s of layout.airfield.stands) {
    if (!s.contact || !s.door || !/^[A-G]$/.test(s.area)) continue;
    const list = doorsByArea.get(s.area) ?? [];
    list.push(s.door);
    doorsByArea.set(s.area, list);
  }
  const securityRooms = layout.terminals.areas.filter((a) => a.kind === 'security').map((a) => ({ at: centroid(a.poly), size: area(a.poly) }));
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
    // A mapped checkpoint nearby is the real one.
    const mapped = securityRooms.filter((r) => Math.hypot(r.at[0] - x, r.at[1] - y) < SNAP).sort((a, b) => Math.hypot(a.at[0] - x, a.at[1] - y) - Math.hypot(b.at[0] - x, b.at[1] - y))[0];
    if (mapped) {
      [x, y] = mapped.at;
      size = mapped.size;
    }
    // Two concourses entered from one spot share a checkpoint.
    const shared = [...checkpoint.values()].find((c) => Math.hypot(c.x - x, c.y - y) < 30);
    const heading = Math.atan2(into[1], into[0]);
    const cp = shared ?? add('checkpoint', `Checkpoint ${letter}`, FLOOR.landside, x, y, { area: letter, size, heading });
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
    const place = add('holdroom', `Gate ${s.id}`, FLOOR.airside, s.door[0], s.door[1], { area: s.area });
    if (place) holdroom.set(s.id, place);
  }

  // ---- customs, for arrivals at the international gates ----------------------------------------
  const customs = new Map<string, Place>();
  for (const a of layout.terminals.areas) {
    const m = a.kind === 'customs' && a.name ? /Primary screening ([A-G])/i.exec(a.name) : null;
    if (!m) continue;
    const [x, y] = centroid(a.poly);
    const place = add('customs', `Customs ${m[1]}`, FLOOR.airside, x, y, { area: m[1], size: area(a.poly) });
    if (place) customs.set(m[1], place);
  }

  // ---- baggage claim -------------------------------------------------------------------------
  const claimRooms = layout.terminals.areas
    .filter((a) => a.kind === 'claim')
    .map((a) => {
      const [x, y] = centroid(a.poly);
      return add('claim', a.name ?? 'Baggage claim', FLOOR.arrivals, x, y, { size: area(a.poly) });
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
    .filter((a) => a.kind === 'checkin' && !/re-check/i.test(a.name ?? ''))
    .map((a) => {
      const [x, y] = centroid(a.poly);
      const place = add('checkin', a.name ?? 'Check-in', FLOOR.landside, x, y, { size: area(a.poly) });
      return place && { place, code: CHECKIN_NAMES.find(([re]) => re.test(a.name ?? ''))?.[1] ?? '' };
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
  for (const s of layout.rail.stations) {
    if (s.kind === 'caltrain') continue;
    const grid = grids[FLOOR.landside];
    if (grid.nearestCell(s.x, s.y, 140) < 0) continue;
    pushWay(add(s.kind === 'bart' ? 'bart' : 'airtrain', s.name, FLOOR.landside, s.x, s.y));
  }
  for (const b of layout.buildings.buildings) {
    if (b.kind !== 'garage' || !b.name) continue;
    const [x, y] = centroid(b.poly);
    if (grids[FLOOR.landside].nearestCell(x, y, 160) < 0) continue;
    pushWay(add('garage', b.name, FLOOR.landside, x, y));
  }

  // ---- shops, places to eat, lounges ---------------------------------------------------------
  for (const a of layout.terminals.areas) {
    if (a.kind !== 'shop' && a.kind !== 'food' && a.kind !== 'lounge') continue;
    const [x, y] = centroid(a.poly);
    // Mostly beyond security; a few in the halls.
    const air = grids[FLOOR.airside].nearestCell(x, y, 25);
    const floor = air >= 0 ? FLOOR.airside : FLOOR.landside;
    add(a.kind, a.name ?? (a.kind === 'food' ? 'Café' : a.kind === 'shop' ? 'Shop' : 'Lounge'), floor, x, y, { size: area(a.poly) });
  }

  const fields = new Map<number, Uint16Array>();
  return {
    grids,
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
