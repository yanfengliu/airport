// The furniture and equipment inside the terminals, as data: desks, bag belts and the walls
// behind them at check-in; tables, x-ray machines, body scanners and rollers in the security
// lanes; passport booths; podiums and banks of seats at the gates; carousels in the claim halls;
// and shelves, tills, tables, chairs and armchairs in the mapped shops, cafés and lounges.
//
// The simulation uses it: people sit in the seats, browse the aisles and wait round the
// carousels, and walkers going elsewhere keep out of the way. The renderer draws it. Only the
// rooms come from the map; what stands in them is laid out here by rule, the same every time.

import type { AreaKind, Layout, PolygonData } from '../../shared/layout.ts';
import type { NavGrid } from './grid.ts';
import { FLOOR, type Place, type TerminalPlan } from './plan.ts';
import type { ServiceQueue } from './queue.ts';

export type FittingKind =
  | 'desk'
  | 'backwall'
  | 'kiosk'
  | 'board'
  | 'xray'
  | 'scanner'
  | 'arch'
  | 'bins'
  | 'booth'
  | 'podium'
  | 'reader'
  | 'shelf'
  | 'gondola'
  | 'till'
  | 'newsstand'
  | 'counter'
  | 'kitchen'
  | 'table'
  | 'lowtable'
  | 'plant'
  | 'bin'
  | 'trolleys';

/**
 * A piece of furniture or equipment. Its length runs along `heading` and its front faces a
 * quarter turn clockwise from that, as the models it is drawn with face: a desk's front is where
 * the passenger stands.
 */
export interface Fitting {
  kind: FittingKind;
  floor: number;
  x: number;
  y: number;
  /** The way its length runs, radians from east; it faces `heading - PI / 2`. */
  heading: number;
  length: number;
  /** Its depth, front to back. */
  width: number;
  height: number;
  /** Picks a look: the kind of shop; at a check-in wall, the airline (index into BRANDS, -1 for none). */
  tint: number;
}

/**
 * Sizes of the furniture, metres: length (across its front), depth and height. These are the
 * sizes of the models it is drawn with (see public/models/index.json), so that people stand,
 * queue and sit where the drawn desks, lanes and seats are.
 */
export const SIZE: Record<FittingKind, readonly [number, number, number]> = {
  desk: [2.0, 2.51, 1.43],
  backwall: [2.0, 0.3, 1.6],
  kiosk: [0.6, 0.57, 1.6],
  board: [1.78, 0.45, 2.9],
  xray: [7.5, 1.24, 1.5],
  scanner: [1.6, 1.4, 2.3],
  arch: [1.7, 1.6, 2.32],
  bins: [0.6, 0.45, 0.85],
  booth: [2.74, 2.43, 3.34],
  podium: [2.07, 1.17, 2.44],
  reader: [0.3, 0.3, 1.1],
  shelf: [2.0, 0.66, 2.4],
  gondola: [2.0, 0.88, 2.0],
  till: [2.0, 0.62, 1.46],
  newsstand: [2.5, 1.65, 2.3],
  counter: [2.0, 1.0, 1.4],
  kitchen: [2.0, 0.66, 2.4],
  table: [1.65, 1.19, 0.85],
  lowtable: [0.6, 0.6, 0.55],
  plant: [0.82, 0.75, 1.5],
  bin: [0.59, 0.58, 0.9],
  trolleys: [0.57, 3.0, 1.1],
};

/** Airlines with their own check-in halls, in the order the check-in walls' tints refer to. */
export const BRANDS = ['UA', 'AA', 'B6', 'WN', 'AS', 'DL'] as const;

export type SeatKind = 'gate' | 'food' | 'lounge';

/** A row of seats side by side, or the chairs round a table: where one party or more sit. */
export interface SeatGroup {
  kind: SeatKind;
  floor: number;
  /** The place it belongs to, by id. */
  place: number;
  /** Its seats: `count` of them from `first`, in `Fittings.seats`. */
  first: number;
  count: number;
  /** Where to walk to before taking a seat in it, so as to come along the row rather than over it. */
  ax: number;
  ay: number;
}

/**
 * A baggage carousel: two straight runs of belt back to back, facing out, an island between
 * them and a half circle of belt at each end.
 */
export interface Carousel {
  /** The claim hall it stands in, by place id. */
  place: number;
  floor: number;
  x: number;
  y: number;
  heading: number;
  length: number;
  width: number;
}

/** Edges of a walled room: a solid wall, a glass front, or the way in. */
export const EDGE = { solid: 0, glass: 1, door: 2 } as const;

/** A mapped room drawn with walls. */
export interface WalledRoom {
  /** Index into the layout's indoor areas. */
  room: number;
  kind: AreaKind;
  /** Per edge of the outer ring, from corner i to corner i + 1: an EDGE. */
  edges: number[];
}

export interface Fittings {
  items: Fitting[];
  /** Seats and chairs: x, y and the way the sitter faces, three numbers each. */
  seats: Float32Array;
  groups: SeatGroup[];
  /** Seat groups by place id. */
  groupsOf: Map<number, number[]>;
  carousels: Carousel[];
  /** Carousels by claim place id. */
  carouselsOf: Map<number, number[]>;
  /** Where people wait for their bags round each carousel: x, y and the way they face, by carousel. */
  claimSpots: number[][];
  /** Where people stand at the shelves or the counter of each shop, café and lounge, by place id: x, y, facing. */
  aisles: Map<number, number[]>;
  /** The stanchion lines of the queues, as polylines of x, y pairs. */
  ropes: { floor: number; pts: number[] }[];
  rooms: WalledRoom[];
}

/** Width of one seat at the gates, metres, centre to centre: four to a 2.47 m module. */
export const SEAT_PITCH = 2.47 / 4;
/** Seats in a row at the gates: two modules of four. */
export const SEATS_IN_ROW = 8;
/** Extra cost for a walker to step into a cell with furniture in it, as the grid counts. */
const FURNISHED = 40;
/** A carousel, metres: four 4 m modules of belt on each side, and the half circles at the ends. */
export const CAROUSEL_STRAIGHT = 16;
export const CAROUSEL_WIDTH = 5;
const CAROUSEL_LENGTH = CAROUSEL_STRAIGHT + CAROUSEL_WIDTH;
/** Resolution of the record of what floor is taken, metres. */
const TAKEN_CELL = 0.5;

/** A rectangle's frame: its middle, the unit vector its length runs along, and its half sizes. */
interface Frame {
  x: number;
  y: number;
  ux: number;
  uy: number;
  halfL: number;
  halfW: number;
}

/** Seen from its way in: `u` points from the front into the room; the origin is the middle of the front. */
interface Front {
  x: number;
  y: number;
  ux: number;
  uy: number;
  depth: number;
  width: number;
}

function insideRing(r: readonly number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i + 1];
    const yj = r[j + 1];
    if (yi > y !== yj > y && x < r[i] + ((y - yi) / (yj - yi)) * (r[j] - r[i])) c = !c;
  }
  return c;
}

export function insidePolygon(p: PolygonData, x: number, y: number): boolean {
  return insideRing(p.outer, x, y) && !(p.holes ?? []).some((h) => insideRing(h, x, y));
}

/** Whether a point stands within any of some outlines, each first judged by its box. */
export function withinAny(polys: readonly PolygonData[]): (x: number, y: number) => boolean {
  const boxed = polys.map((poly) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < poly.outer.length; i += 2) {
      [x0, x1] = [Math.min(x0, poly.outer[i]), Math.max(x1, poly.outer[i])];
      [y0, y1] = [Math.min(y0, poly.outer[i + 1]), Math.max(y1, poly.outer[i + 1])];
    }
    return { poly, x0, y0, x1, y1 };
  });
  return (x, y) => boxed.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && insidePolygon(b.poly, x, y));
}

function signedArea(r: readonly number[]): number {
  let twice = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) twice += r[j] * r[i + 1] - r[i] * r[j + 1];
  return twice / 2;
}

/** Convex hull of a flat list of points, as a flat list, counter-clockwise. */
function hull(flat: readonly number[]): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts.flat();
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/** The smallest rectangle round a polygon, its length the longer side. */
export function orient(poly: PolygonData): Frame {
  const pts = hull(poly.outer);
  let best: Frame | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    const dx = pts[j] - pts[i];
    const dy = pts[j + 1] - pts[i + 1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const a = pts[k] * ux + pts[k + 1] * uy;
      const b = -pts[k] * uy + pts[k + 1] * ux;
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area >= bestArea) continue;
    bestArea = area;
    const ca = (minA + maxA) / 2;
    const cb = (minB + maxB) / 2;
    const frame: Frame = { x: ca * ux - cb * uy, y: ca * uy + cb * ux, ux, uy, halfL: (maxA - minA) / 2, halfW: (maxB - minB) / 2 };
    best = frame.halfW > frame.halfL ? { x: frame.x, y: frame.y, ux: -uy, uy: ux, halfL: frame.halfW, halfW: frame.halfL } : frame;
  }
  if (best) return best;
  return { x: poly.outer[0] ?? 0, y: poly.outer[1] ?? 0, ux: 1, uy: 0, halfL: 1, halfW: 1 };
}

const headingOf = (ux: number, uy: number): number => Math.atan2(uy, ux);

class Layouter {
  readonly items: Fitting[] = [];
  readonly seats: number[] = [];
  readonly groups: SeatGroup[] = [];
  readonly groupsOf = new Map<number, number[]>();
  readonly carousels: Carousel[] = [];
  readonly carouselsOf = new Map<number, number[]>();
  readonly claimSpots: number[][] = [];
  readonly aisles = new Map<number, number[]>();
  readonly ropes: { floor: number; pts: number[] }[] = [];
  readonly rooms: WalledRoom[] = [];
  private readonly taken = new Set<number>();
  private readonly grids: NavGrid[];
  /** The terminals' outside walls, as drawn: nothing stands beyond them. */
  private readonly walls: ((x: number, y: number) => boolean) | null;

  constructor(grids: NavGrid[], walls: readonly PolygonData[] = []) {
    this.grids = grids;
    this.walls = walls.length ? withinAny(walls) : null;
  }

  /** Within the terminals' walls (true when they are not given). */
  withinWalls(x: number, y: number): boolean {
    return !this.walls || this.walls(x, y);
  }

  /** The grids of the level a floor is on: the arrivals level, or both halves of the departures level. */
  private gridsOf(floor: number): NavGrid[] {
    return floor === FLOOR.arrivals ? [this.grids[FLOOR.arrivals]] : [this.grids[FLOOR.landside], this.grids[FLOOR.airside]];
  }

  private key(floor: number, x: number, y: number): number {
    const level = floor === FLOOR.arrivals ? 0 : 1;
    return level * 1e12 + (Math.floor(y / TAKEN_CELL) + 50_000) * 1e6 + (Math.floor(x / TAKEN_CELL) + 50_000);
  }

  /** Points over a rectangle, about `step` apart, corners and edges included. */
  private samples(x: number, y: number, heading: number, halfL: number, halfW: number, step: number): number[] {
    const ux = Math.cos(heading);
    const uy = Math.sin(heading);
    const nl = Math.max(1, Math.ceil((2 * halfL) / step));
    const nw = Math.max(1, Math.ceil((2 * halfW) / step));
    const out: number[] = [];
    for (let i = 0; i <= nl; i += 1) {
      const a = -halfL + (2 * halfL * i) / nl;
      for (let j = 0; j <= nw; j += 1) {
        const b = -halfW + (2 * halfW * j) / nw;
        out.push(x + ux * a - uy * b, y + uy * a + ux * b);
      }
    }
    return out;
  }

  /** Floor anyone can stand on, on this level; `inner` asks for a cell not against a wall. */
  walkable(floor: number, x: number, y: number, inner = false): boolean {
    for (const grid of this.gridsOf(floor)) {
      const cell = grid.cellAt(x, y);
      if (cell >= 0 && (!inner || !grid.edge[cell])) return true;
    }
    return false;
  }

  /** The share of a room's floor already taken by what stands there. */
  takenShare(floor: number, poly: PolygonData): number {
    const f = orient(poly);
    let inside = 0;
    let taken = 0;
    for (let s = -f.halfL; s <= f.halfL; s += 1) {
      for (let t = -f.halfW; t <= f.halfW; t += 1) {
        const [x, y] = at(f, s, t);
        if (!insidePolygon(poly, x, y)) continue;
        inside += 1;
        if (this.taken.has(this.key(floor, x, y))) taken += 1;
      }
    }
    return inside ? taken / inside : 0;
  }

  /** True when the rectangle is all on open floor of the level and nothing else stands there. */
  fits(floor: number, x: number, y: number, heading: number, halfL: number, halfW: number, inner: boolean, room?: PolygonData): boolean {
    const pts = this.samples(x, y, heading, halfL, halfW, 0.6);
    for (let i = 0; i < pts.length; i += 2) {
      if (this.taken.has(this.key(floor, pts[i], pts[i + 1]))) return false;
      if (!this.withinWalls(pts[i], pts[i + 1])) return false;
      if (room ? !insidePolygon(room, pts[i], pts[i + 1]) : !this.walkable(floor, pts[i], pts[i + 1], inner)) return false;
    }
    return true;
  }

  /** Mark a rectangle as taken, and the cells under it as furnished for walkers. */
  claim(floor: number, x: number, y: number, heading: number, halfL: number, halfW: number, furnish: boolean): void {
    const pts = this.samples(x, y, heading, halfL, halfW, TAKEN_CELL * 0.8);
    for (let i = 0; i < pts.length; i += 2) this.taken.add(this.key(floor, pts[i], pts[i + 1]));
    if (!furnish) return;
    const ux = Math.cos(heading);
    const uy = Math.sin(heading);
    const reach = Math.hypot(halfL, halfW) + 0.5;
    for (const grid of this.gridsOf(floor)) {
      const c0 = Math.floor((x - reach - grid.x0) / grid.cell);
      const c1 = Math.floor((x + reach - grid.x0) / grid.cell);
      const r0 = Math.floor((y - reach - grid.y0) / grid.cell);
      const r1 = Math.floor((y + reach - grid.y0) / grid.cell);
      for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r += 1) {
        for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c += 1) {
          const id = grid.index[r * grid.cols + c];
          if (id < 0) continue;
          const dx = grid.cx[id] - x;
          const dy = grid.cy[id] - y;
          if (Math.abs(dx * ux + dy * uy) <= halfL + 0.4 && Math.abs(-dx * uy + dy * ux) <= halfW + 0.4) grid.extra[id] = FURNISHED;
        }
      }
    }
  }

  add(f: Fitting, furnish = true): void {
    this.items.push(f);
    this.claim(f.floor, f.x, f.y, f.heading, f.length / 2, f.width / 2, furnish);
  }

  /** A fitting of its own size, of a kind, at a point, facing a way. */
  put(kind: FittingKind, floor: number, x: number, y: number, facing: number, tint = 0, furnish = true): Fitting {
    const [length, width, height] = SIZE[kind];
    const f: Fitting = { kind, floor, x, y, heading: facing + Math.PI / 2, length, width, height, tint };
    this.add(f, furnish);
    return f;
  }

  /** A group of seats; returns its index. */
  group(kind: SeatKind, floor: number, place: number, seats: readonly number[], ax: number, ay: number): void {
    const first = this.seats.length / 3;
    this.seats.push(...seats);
    const index = this.groups.length;
    this.groups.push({ kind, floor, place, first, count: seats.length / 3, ax, ay });
    const list = this.groupsOf.get(place) ?? [];
    list.push(index);
    this.groupsOf.set(place, list);
  }

  spots(place: number, spots: readonly number[]): void {
    if (!spots.length) return;
    this.aisles.set(place, [...(this.aisles.get(place) ?? []), ...spots]);
  }

  done(): Fittings {
    return {
      items: this.items,
      seats: Float32Array.from(this.seats),
      groups: this.groups,
      groupsOf: this.groupsOf,
      carousels: this.carousels,
      carouselsOf: this.carouselsOf,
      claimSpots: this.claimSpots,
      aisles: this.aisles,
      ropes: this.ropes,
      rooms: this.rooms,
    };
  }
}

/** A point `along` the frame's length and `across` it, from its middle. */
function at(f: { x: number; y: number; ux: number; uy: number }, along: number, across: number): [number, number] {
  return [f.x + f.ux * along - f.uy * across, f.y + f.uy * along + f.ux * across];
}

/** Everything inside the terminals, laid out from the plan, its queues and the mapped rooms. */
export function buildFittings(layout: Layout, plan: TerminalPlan, queues: ReadonlyMap<number, ServiceQueue>, brandOf: (place: Place) => number, island: (place: Place) => boolean = () => false): Fittings {
  const out = new Layouter(plan.grids, layout.terminals.buildings.map((b) => b.poly));
  const span = new Map(layout.airfield.stands.map((s) => [s.id, s.span] as const));
  const gateSpan = new Map<number, number>();
  for (const [stand, place] of plan.holdroom) gateSpan.set(place.id, Math.max(gateSpan.get(place.id) ?? 0, span.get(stand) ?? 36));

  // The lines themselves: nothing else stands between their ropes.
  const ids = [...queues.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const { x, y, heading, length, width } = queues.get(id)!.shape;
    out.claim(plan.places[id].floor, x, y, heading, length / 2, width / 2, false);
  }
  // The counters, lanes, booths and gates: they are where the queues say.
  for (const id of ids) {
    const place = plan.places[id];
    const queue = queues.get(id)!;
    for (const pts of queue.ropes()) out.ropes.push({ floor: place.floor, pts });
    if (place.kind === 'checkin') checkin(out, place, queue, brandOf(place), island(place));
    else if (place.kind === 'checkpoint') checkpoint(out, place, queue);
    else if (place.kind === 'customs') customs(out, place, queue);
    else if (place.kind === 'holdroom') podium(out, place, queue);
  }
  // Then what stands about them, where there is room left: kiosks, and boards where lines are joined.
  for (const id of ids) {
    const place = plan.places[id];
    const queue = queues.get(id)!;
    if (place.kind === 'checkin') kiosks(out, place, queue);
    if (place.kind === 'checkin' || place.kind === 'checkpoint') boardAt(out, place, queue);
  }
  // Seats at the gates, the biggest aircraft's gates first, each as many as its aircraft needs.
  const gates = ids.map((id) => plan.places[id]).filter((p) => p.kind === 'holdroom');
  gates.sort((a, b) => (gateSpan.get(b.id) ?? 0) - (gateSpan.get(a.id) ?? 0) || a.id - b.id);
  for (const gate of gates) {
    const s = gateSpan.get(gate.id) ?? 36;
    gateSeats(out, layout, gate, s >= 64 ? 170 : s >= 50 ? 130 : s >= 34 ? 96 : 60);
  }
  // Claim halls.
  const claims = [...new Set([...plan.claim.values()].flatMap((c) => [c.domestic, c.international]))].sort((a, b) => a.id - b.id);
  for (const claim of claims) carousels(out, layout, claim);
  // Shops, cafés, lounges and toilets: the mapped rooms, each with walls and what is inside, where
  // rooms mapped on different levels do not lie over one another.
  const kept = keptRooms(layout);
  const byRoom = new Map<number, Place>();
  for (const p of plan.places) if (p.room >= 0 && (p.kind === 'shop' || p.kind === 'food' || p.kind === 'lounge')) byRoom.set(p.room, p);
  for (const room of kept) {
    const area = layout.terminals.areas[room];
    const place = byRoom.get(room);
    const floor = place?.floor ?? FLOOR.airside;
    // A room the desks or lanes already stand in is not a room any more: no walls, no fittings.
    if (out.takenShare(floor, area.poly) > 0.05) continue;
    const front = frontOf(out, area.poly, floor);
    out.rooms.push({ room, kind: area.kind, edges: walls(out, area.poly, floor) });
    if (!place) continue;
    if (place.kind === 'shop') shop(out, place, area.poly, front);
    else if (place.kind === 'food') food(out, place, area.poly, front);
    else lounge(out, place, area.poly, front);
  }
  return out.done();
}

/** The rooms that get walls and furniture: shops, cafés, lounges and toilets, upper levels first, none over another. */
function keptRooms(layout: Layout): number[] {
  const kinds = new Set<AreaKind>(['shop', 'food', 'lounge', 'toilets']);
  const order = layout.terminals.areas
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => kinds.has(a.kind))
    .sort((p, q) => q.a.level - p.a.level || p.i - q.i);
  const covered = new Set<number>();
  const key = (x: number, y: number): number => Math.floor(y / 2 + 10_000) * 100_000 + Math.floor(x / 2 + 10_000);
  const kept: number[] = [];
  for (const { a, i } of order) {
    const f = orient(a.poly);
    const cells: number[] = [];
    let overlap = 0;
    for (let s = -f.halfL; s <= f.halfL; s += 1) {
      for (let t = -f.halfW; t <= f.halfW; t += 1) {
        const [x, y] = at(f, s, t);
        if (!insidePolygon(a.poly, x, y)) continue;
        const k = key(x, y);
        cells.push(k);
        if (covered.has(k)) overlap += 1;
      }
    }
    if (!cells.length || overlap > cells.length * 0.25) continue;
    for (const k of cells) covered.add(k);
    kept.push(i);
  }
  return kept.sort((p, q) => p - q);
}

/**
 * Which side of a room is its front, open to the concourse: of the four sides of the rectangle
 * round it, the one with most open floor just outside.
 */
function frontOf(out: Layouter, poly: PolygonData, floor: number): Front {
  const f = orient(poly);
  const sides = [
    { nx: f.ux, ny: f.uy, half: f.halfL, span: f.halfW },
    { nx: -f.ux, ny: -f.uy, half: f.halfL, span: f.halfW },
    { nx: -f.uy, ny: f.ux, half: f.halfW, span: f.halfL },
    { nx: f.uy, ny: -f.ux, half: f.halfW, span: f.halfL },
  ];
  let best = sides[0];
  let bestScore = -1;
  for (const s of sides) {
    let score = 0;
    for (const t of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const x = f.x + s.nx * (s.half + 2.2) + -s.ny * t * s.span;
      const y = f.y + s.ny * (s.half + 2.2) + s.nx * t * s.span;
      if (out.walkable(floor, x, y) && !insidePolygon(poly, x, y)) score += 1;
    }
    // A longer side wins a tie: shops face the concourse along their length.
    const total = score + s.span * 0.001;
    if (total > bestScore) {
      bestScore = total;
      best = s;
    }
  }
  return { x: f.x + best.nx * best.half, y: f.y + best.ny * best.half, ux: -best.nx, uy: -best.ny, depth: 2 * best.half, width: 2 * best.span };
}

/** Each edge of a room's outline: glass where open floor lies outside it, the longest of those the way in. */
function walls(out: Layouter, poly: PolygonData, floor: number): number[] {
  const r = poly.outer;
  const ccw = signedArea(r) > 0;
  const edges: number[] = [];
  let door = -1;
  let doorLength = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const dx = r[j * 2] - r[i * 2];
    const dy = r[j * 2 + 1] - r[i * 2 + 1];
    const len = Math.hypot(dx, dy) || 1;
    // Outward: to the right of the edge when the ring runs counter-clockwise.
    const ox = (ccw ? dy : -dy) / len;
    const oy = (ccw ? -dx : dx) / len;
    const mx = (r[i * 2] + r[j * 2]) / 2 + ox * 1.6;
    const my = (r[i * 2 + 1] + r[j * 2 + 1]) / 2 + oy * 1.6;
    const open = out.walkable(floor, mx, my) && !insidePolygon(poly, mx, my);
    edges.push(open ? EDGE.glass : EDGE.solid);
    if (open && len > doorLength && len >= 2.4) {
      doorLength = len;
      door = i;
    }
  }
  if (door >= 0) edges[door] = EDGE.door;
  return edges;
}

/** A frame at a point, its length along `heading`: `at(f, along, across)` gives points in it. */
const frameAt = (x: number, y: number, heading: number): { x: number; y: number; ux: number; uy: number } => ({ x, y, ux: Math.cos(heading), uy: Math.sin(heading) });

/**
 * Check-in: a desk module at each server, each with its scale and the belt that takes bags back;
 * the modules stand side by side as an island, the airline's wall behind them, and kiosks beside
 * the line. Where the desk stands relative to the passenger is the module's own: the counter on
 * the passenger's left half of it, the scale and belt on the right.
 */
function checkin(out: Layouter, place: Place, queue: ServiceQueue, brand: number, island: boolean): void {
  const h = place.heading;
  const floor = place.floor;
  for (const s of queue.servers) {
    const [x, y] = at(frameAt(s.x, s.y, h), DESK_FROM_PASSENGER, -0.5);
    out.put('desk', floor, x, y, h + Math.PI, brand);
  }
  const n = queue.servers.length;
  const row = n * SIZE.desk[0];
  // The middle of the row of servers: the row may stand back from the place, clear of another hall's.
  const cx = queue.servers.reduce((sum, s) => sum + s.x, 0) / n;
  const cy = queue.servers.reduce((sum, s) => sum + s.y, 0) / n;
  const [wx, wy] = at(frameAt(cx, cy, h), DESK_FROM_PASSENGER + SIZE.desk[1] / 2 + 0.35, -0.5);
  // The airline's wall behind the desks; at an island the two rows of desks meet back to back
  // and there is none.
  const shared = island || out.items.some((i) => {
    if (i.kind !== 'backwall') return false;
    const dx = i.x - wx;
    const dy = i.y - wy;
    const along = Math.abs(dx * Math.cos(h + Math.PI / 2) + dy * Math.sin(h + Math.PI / 2));
    const across = Math.abs(-dx * Math.sin(h + Math.PI / 2) + dy * Math.cos(h + Math.PI / 2));
    return across < 1.5 && along < (row + i.length) / 2;
  });
  if (!shared) {
    out.add({ kind: 'backwall', floor, x: wx, y: wy, heading: h + Math.PI / 2 + Math.PI, length: row + 1, width: SIZE.backwall[1], height: SIZE.backwall[2], tint: brand });
  }
}

/** Kiosks beside a check-in line, on whichever side has floor and room, and the departures board. */
function kiosks(out: Layouter, place: Place, queue: ServiceQueue): void {
  const h = place.heading;
  const floor = place.floor;
  const n = queue.servers.length;
  const shape = queue.shape;
  const q = frameAt(shape.x, shape.y, h);
  const count = Math.min(8, Math.ceil(n / 2));
  for (const side of [-1, 1]) {
    const spots: [number, number][] = [];
    for (let k = 0; k < count; k += 1) spots.push(at(q, shape.length / 2 - 1 - k * 1.1, side * (shape.width / 2 + 1.4)));
    if (!spots.every(([x, y]) => out.walkable(floor, x, y) && out.fits(floor, x, y, h, 0.35, 0.35, false))) continue;
    for (const [x, y] of spots) out.put('kiosk', floor, x, y, h - side * (Math.PI / 2));
    break;
  }
}

/** Metres from where a passenger stands at a check-in desk to the middle of the desk module. */
export const DESK_FROM_PASSENGER = 0.45 + SIZE.desk[1] / 2;

/** A departures board where the line is joined, facing those joining it. */
function boardAt(out: Layouter, place: Place, queue: ServiceQueue): void {
  const e = queue.entrance;
  const { x: qx, y: qy, heading, length, width } = queue.shape;
  const q = frameAt(qx, qy, heading);
  // Where the line is joined, along and across its ropes: the back of them, or the front.
  const along = (e.x - qx) * q.ux + (e.y - qy) * q.uy;
  const across = -(e.x - qx) * q.uy + (e.y - qy) * q.ux;
  // Behind where it is joined, or beside the ropes there, or behind them: outside them, anyway.
  const spots = [at(q, along - 2.2, across - 1.6), at(q, along, (Math.sign(across) || -1) * (width / 2 + 1.2)), at(q, -length / 2 - 2.2, across)];
  for (const [x, y] of spots) {
    if (!out.walkable(place.floor, x, y) || !out.fits(place.floor, x, y, place.heading, 1.0, 0.4, false)) continue;
    out.put('board', place.floor, x, y, place.heading, 0, false);
    return;
  }
}

/** Across a security lane from its server: the belt with its x-ray on one side, the scanner on the other. */
export const LANE = { belt: -0.75, scanner: 0.8, beltAlong: 2.9, scannerAlong: 3.2 } as const;

/** Security: each lane's x-ray belt and bins on one side, a body scanner or an arch on the other. */
function checkpoint(out: Layouter, place: Place, queue: ServiceQueue): void {
  const h = place.heading;
  const floor = place.floor;
  queue.servers.forEach((s, i) => {
    const g = frameAt(s.x, s.y, h);
    const [bx, by] = at(g, LANE.beltAlong, LANE.belt);
    out.put('xray', floor, bx, by, h - Math.PI / 2);
    const [nx, ny] = at(g, -1.75, LANE.belt);
    out.put('bins', floor, nx, ny, h + Math.PI);
    // Every third lane has a plain arch instead of a body scanner.
    const [sx, sy] = at(g, LANE.scannerAlong, LANE.scanner);
    out.put(i % 3 === 2 ? 'arch' : 'scanner', floor, sx, sy, h + Math.PI);
  });
}

/** Passport control: a booth to each pair of servers, an officer at each of its windows. */
function customs(out: Layouter, place: Place, queue: ServiceQueue): void {
  const h = place.heading;
  for (let i = 0; i < queue.servers.length; i += 2) {
    const a = queue.servers[i];
    const b = queue.servers[Math.min(i + 1, queue.servers.length - 1)];
    const [x, y] = at(frameAt((a.x + b.x) / 2, (a.y + b.y) / 2, h), BOOTH_FROM_PASSENGER, 0);
    out.put('booth', place.floor, x, y, h + Math.PI);
  }
}

/** Metres from where a passenger stands at passport control to the middle of the booth. */
export const BOOTH_FROM_PASSENGER = 0.4 + SIZE.booth[1] / 2;

/** The gate: a reader at each boarding lane, the podium beside them. */
function podium(out: Layouter, place: Place, queue: ServiceQueue): void {
  const h = place.heading;
  const f = frameAt(place.x, place.y, h);
  for (const s of queue.servers) {
    const side = Math.sign((s.x - place.x) * -f.uy + (s.y - place.y) * f.ux) || 1;
    // Beside the lane, at the door or as near it as is inside the glass.
    const g = frameAt(s.x, s.y, h);
    const along = [0.35, 0, -0.35, -0.7, -1.05].find((a) => out.withinWalls(...at(g, a, side * 0.42))) ?? -1.05;
    const [x, y] = at(g, along, side * 0.42);
    out.put('reader', place.floor, x, y, h + Math.PI, 0, false);
  }
  // A metre into the hall from the door, on whichever side of the lanes there is floor for it.
  const [pl, pw] = SIZE.podium;
  const sides = [[-1.0, 3.4], [-1.0, -3.4], [-2.6, 3.4], [-2.6, -3.4], [-1.0, 5.2], [-1.0, -5.2], [-4.2, 3.4], [-4.2, -3.4], [-5.8, 3.4], [-5.8, -3.4], [-2.6, 6.5], [-2.6, -6.5]].map(([a, side]) => at(f, a, side));
  // Two gates sharing a door share a desk: the second finds no room and has none of its own.
  const side = sides.find(([x, y]) => out.fits(place.floor, x, y, h + Math.PI / 2, pl / 2, pw / 2, false));
  if (side) out.put('podium', place.floor, side[0], side[1], h + Math.PI);
}

/**
 * Banks of seats at a gate: pairs of rows back to back, one facing the windows and one the hall,
 * in the half of the concourse on the gate's side, clear of the boarding line, nearest first.
 */
/**
 * The building's outside wall nearest a point, within `reach` metres: the way it runs, as a unit
 * vector, or null when there is none so near.
 */
function wallNear(layout: Layout, x: number, y: number, reach: number): [number, number] | null {
  let best = reach;
  let dir: [number, number] | null = null;
  for (const b of layout.terminals.buildings) {
    for (const ring of [b.poly.outer, ...(b.poly.holes ?? [])]) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const dx = ring[i] - ring[j];
        const dy = ring[i + 1] - ring[j + 1];
        const len2 = dx * dx + dy * dy;
        // A wall of some length: the short jags of an outline round a door or a corner do not say which way the hall runs.
        if (len2 < 144) continue;
        const t = Math.max(0, Math.min(1, ((x - ring[j]) * dx + (y - ring[j + 1]) * dy) / len2));
        const d = Math.hypot(x - ring[j] - dx * t, y - ring[j + 1] - dy * t);
        if (d < best) {
          best = d;
          const len = Math.sqrt(len2);
          dir = [dx / len, dy / len];
        }
      }
    }
  }
  return dir;
}

function gateSeats(out: Layouter, layout: Layout, place: Place, wanted: number): void {
  // How deep the hall is from the door, one way or another.
  const depthTowards = (angle: number): number => {
    let depth = 0;
    for (let d = 1; d <= 120; d += 1) {
      if (!out.walkable(place.floor, place.x + Math.cos(angle) * d, place.y + Math.sin(angle) * d)) break;
      depth = d;
    }
    return depth;
  };
  // Into the hall, square to the wall the gate's door is in where there is one, so the rows run
  // along the windows; else straight back from the door; else whichever way the hall is deepest.
  let inward = place.heading + Math.PI;
  const wall = wallNear(layout, place.x, place.y, 15);
  if (wall) {
    const across = Math.atan2(wall[0], -wall[1]);
    const sides = [across, across + Math.PI];
    // Of the two ways square to the wall, the one into the hall, nearer the way back from the door.
    sides.sort((a, b) => depthTowards(b) - depthTowards(a) || Math.cos(b - inward) - Math.cos(a - inward));
    inward = sides[0];
  }
  let depth = depthTowards(inward);
  if (depth < 8) {
    let best = depth * 2;
    for (let k = 1; k < 8; k += 1) {
      const angle = place.heading + Math.PI + (k * Math.PI) / 4;
      const d = depthTowards(angle);
      if (d * (1 + Math.cos((k * Math.PI) / 4)) > best) {
        best = d * (1 + Math.cos((k * Math.PI) / 4));
        inward = angle;
        depth = d;
      }
    }
  }
  const h = inward + Math.PI;
  const f = { x: place.x, y: place.y, ux: Math.cos(h), uy: Math.sin(h) };
  // Seats keep to the gate's half of a wide hall and leave the middle to walk along; a narrow one
  // keeps a walkway of a few metres.
  const reach = Math.min(22, Math.max(depth / 2 - 2.5, Math.min(depth - 4.5, 9)));
  const halfL = (SEATS_IN_ROW * SEAT_PITCH) / 2 + 0.15;
  // Two rows of seats and the legroom in front of each.
  const halfW = 0.32 + 0.3 + 0.6;
  const candidates: { a: number; b: number }[] = [];
  for (let a = 3.4 + halfW; a + halfW <= reach; a += 2 * halfW + 0.8) {
    for (let k = 0; k < 8; k += 1) {
      for (const side of [-1, 1]) candidates.push({ a, b: side * (2.8 + halfL + k * (2 * halfL + 1.7)) });
    }
  }
  candidates.sort((p, q) => p.a + Math.abs(p.b) * 0.6 - (q.a + Math.abs(q.b) * 0.6) || p.b - q.b);
  let seats = 0;
  let banks = 0;
  const across = h + Math.PI / 2;
  for (const c of candidates) {
    if (seats >= wanted) break;
    const [x, y] = at(f, -c.a, c.b);
    if (!out.fits(place.floor, x, y, across, halfL, halfW, true)) continue;
    out.claim(place.floor, x, y, across, halfL, halfW - 0.55, true);
    out.claim(place.floor, x, y, across, halfL, halfW, false);
    // The end of the rows nearer the boarding line is where people come in.
    const near = -Math.sign(c.b);
    for (const row of [1, -1]) {
      const list: number[] = [];
      const facing = row > 0 ? h : h + Math.PI;
      for (let i = 0; i < SEATS_IN_ROW; i += 1) {
        const [sx, sy] = at(f, -c.a + row * 0.32, c.b + (i - (SEATS_IN_ROW - 1) / 2) * SEAT_PITCH);
        list.push(sx, sy, facing);
      }
      const [ax, ay] = at(f, -c.a + row * 0.95, c.b + near * (halfL + 0.4));
      out.group('gate', place.floor, place.id, list, ax, ay);
      seats += SEATS_IN_ROW;
    }
    // A plant at the far end of every other bank, a bin at the near end of every third.
    banks += 1;
    const ends: [FittingKind, number][] = [];
    if (banks % 2 === 1) ends.push(['plant', -near]);
    if (banks % 3 === 2) ends.push(['bin', near]);
    for (const [kind, end] of ends) {
      const [ex, ey] = at(f, -c.a, c.b + end * (halfL + 0.55));
      if (out.fits(place.floor, ex, ey, across, 0.4, 0.4, true)) out.put(kind, place.floor, ex, ey, h);
    }
  }
  if (seats >= 18) return;
  // A shallow hall, or one already full of its neighbours' seats: single rows facing the windows,
  // nearer the door, wherever there is floor.
  const single = 0.32 + 0.6;
  for (let a = 2.6 + single; a + single <= Math.max(reach, 2.6 + 2 * single); a += 2 * single + 0.8) {
    for (let k = 0; k < 10 && seats < wanted; k += 1) {
      for (const side of [-1, 1]) {
        const b = side * (2.8 + halfL + k * (2 * halfL + 1.2));
        const [x, y] = at(f, -a, b);
        if (seats >= wanted || !out.fits(place.floor, x, y, across, halfL, single, false)) continue;
        out.claim(place.floor, x, y, across, halfL, 0.4, true);
        out.claim(place.floor, x, y, across, halfL, single, false);
        const list: number[] = [];
        for (let i = 0; i < SEATS_IN_ROW; i += 1) {
          const [sx, sy] = at(f, -a - 0.1, b + (i - (SEATS_IN_ROW - 1) / 2) * SEAT_PITCH);
          list.push(sx, sy, h);
        }
        const [ax, ay] = at(f, -a + 0.55, b - side * (halfL + 0.4));
        out.group('gate', place.floor, place.id, list, ax, ay);
        seats += SEATS_IN_ROW;
      }
    }
  }
}

/**
 * Carousels in a claim hall, as many as fit with room to stand round them, up to four; and the
 * places round each where people wait for their bags, facing the belt.
 */
function carousels(out: Layouter, layout: Layout, claim: Place): void {
  const room = claim.room >= 0 ? layout.terminals.areas[claim.room].poly : null;
  const floor = claim.floor;
  const list: number[] = [];
  const put = (x: number, y: number, heading: number, length: number, width: number): void => {
    const index = out.carousels.length;
    out.carousels.push({ place: claim.id, floor, x, y, heading, length, width });
    out.claim(floor, x, y, heading, length / 2, width / 2, true);
    list.push(index);
  };
  if (room) {
    const f = orient(room);
    const along = Math.max(1, Math.floor((2 * f.halfL - 6) / (CAROUSEL_LENGTH + 9)));
    const rows = Math.max(1, Math.floor((2 * f.halfW - 6) / (CAROUSEL_WIDTH + 9)));
    for (let i = 0; i < along && list.length < 4; i += 1) {
      for (let j = 0; j < rows && list.length < 4; j += 1) {
        const [x, y] = at(f, (i - (along - 1) / 2) * (CAROUSEL_LENGTH + 9), (j - (rows - 1) / 2) * (CAROUSEL_WIDTH + 9));
        const heading = headingOf(f.ux, f.uy);
        if (out.fits(floor, x, y, heading, CAROUSEL_LENGTH / 2 + 2.5, CAROUSEL_WIDTH / 2 + 2.5, false, room)) put(x, y, heading, CAROUSEL_LENGTH, CAROUSEL_WIDTH);
      }
    }
    if (!list.length) {
      const heading = headingOf(f.ux, f.uy);
      if (out.fits(floor, f.x, f.y, heading, CAROUSEL_LENGTH / 2, CAROUSEL_WIDTH / 2, false)) put(f.x, f.y, heading, CAROUSEL_LENGTH, CAROUSEL_WIDTH);
    }
    // Rows of luggage trolleys along the long walls.
    for (const side of [-1, 1]) {
      for (const along of [-0.6, 0.6]) {
        const [x, y] = at(f, along * f.halfL, side * (f.halfW - 1.2));
        const heading = headingOf(f.ux, f.uy) + (side > 0 ? Math.PI : 0);
        if (out.fits(floor, x, y, heading + Math.PI / 2, SIZE.trolleys[0] / 2 + 0.2, SIZE.trolleys[1] / 2 + 0.2, false, room)) out.put('trolleys', floor, x, y, heading);
      }
    }
  }
  if (!list.length) {
    // With no room drawn for it, or none it fits in, the hall's walls give it its way: as near the
    // claim as there is floor for it and those round it, within the walls.
    const wall = wallNear(layout, claim.x, claim.y, 80);
    const along = wall ? headingOf(wall[0], wall[1]) : 0;
    search: for (const margin of [2.5, 1]) {
      for (let r = 0; r <= 40; r += 2.5) {
        const n = r ? Math.ceil((2 * Math.PI * r) / 2.5) : 1;
        for (let k = 0; k < n; k += 1) {
          const [x, y] = [claim.x + r * Math.cos((k / n) * 2 * Math.PI), claim.y + r * Math.sin((k / n) * 2 * Math.PI)];
          for (const heading of [along, along + Math.PI / 2]) {
            if (!out.fits(floor, x, y, heading, CAROUSEL_LENGTH / 2 + margin, CAROUSEL_WIDTH / 2 + margin, false)) continue;
            put(x, y, heading, CAROUSEL_LENGTH, CAROUSEL_WIDTH);
            break search;
          }
        }
      }
    }
  }
  if (!list.length) put(claim.x, claim.y, 0, CAROUSEL_LENGTH, CAROUSEL_WIDTH);
  out.carouselsOf.set(claim.id, list);
  for (const index of list) out.claimSpots[index] = standRound(out, out.carousels[index]);
}

/** Places to stand round a carousel's loop, a step back from its edge, facing it. */
function standRound(out: Layouter, c: Carousel): number[] {
  const spots: number[] = [];
  const straight = c.length - c.width;
  const ux = Math.cos(c.heading);
  const uy = Math.sin(c.heading);
  for (const back of [1.1, 1.9]) {
    const r = c.width / 2 + back;
    const perimeter = 2 * straight + 2 * Math.PI * r;
    const count = Math.floor(perimeter / 1.15);
    for (let k = 0; k < count; k += 1) {
      let s = ((k + (back > 1.5 ? 0.5 : 0)) / count) * perimeter;
      let u: number;
      let v: number;
      let nu: number;
      let nv: number;
      if (s < straight) {
        u = -straight / 2 + s;
        v = r;
        nu = 0;
        nv = 1;
      } else if ((s -= straight) < Math.PI * r) {
        const a = s / r;
        u = straight / 2 + Math.sin(a) * r;
        v = Math.cos(a) * r;
        nu = Math.sin(a);
        nv = Math.cos(a);
      } else if ((s -= Math.PI * r) < straight) {
        u = straight / 2 - s;
        v = -r;
        nu = 0;
        nv = -1;
      } else {
        const a = (s - straight) / r;
        u = -straight / 2 - Math.sin(a) * r;
        v = -Math.cos(a) * r;
        nu = -Math.sin(a);
        nv = -Math.cos(a);
      }
      const x = c.x + ux * u - uy * v;
      const y = c.y + uy * u + ux * v;
      if (!out.walkable(c.floor, x, y)) continue;
      // Facing in towards the belt.
      spots.push(x, y, Math.atan2(-(uy * nu + ux * nv), -(ux * nu - uy * nv)));
    }
  }
  return spots;
}

/** In the room's front frame, whether a rectangle lies inside the room. */
function within(poly: PolygonData, fr: Front, d: number, c: number, alongDepth: boolean, length: number, width: number): boolean {
  const hl = length / 2;
  const hw = width / 2;
  for (const [p, q] of [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [0, 0]] as const) {
    const [x, y] = alongDepth ? at(fr, d + p, c + q) : at(fr, d + q, c + p);
    if (!insidePolygon(poly, x, y)) return false;
  }
  return true;
}

/**
 * Modules of a kind side by side along a line in a room's front frame, as many whole ones as fit
 * between `from` and `to`, centred; each must lie inside the room. Returns how many were placed.
 */
function modules(out: Layouter, place: Place, poly: PolygonData, fr: Front, kind: FittingKind, d: number, from: number, to: number, alongDepth: boolean, facing: number, tint: number): number {
  const [length, width] = SIZE[kind];
  const count = Math.floor((to - from) / length);
  let placed = 0;
  for (let k = 0; k < count; k += 1) {
    const mid = (from + to) / 2 + (k - (count - 1) / 2) * length;
    const [dd, cc] = alongDepth ? [mid, d] : [d, mid];
    if (!within(poly, fr, dd, cc, alongDepth, length, width)) continue;
    const [x, y] = at(fr, dd, cc);
    if (!out.fits(place.floor, x, y, facing + Math.PI / 2, length / 2, width / 2, false, poly)) continue;
    out.put(kind, place.floor, x, y, facing, tint);
    placed += 1;
  }
  return placed;
}

/**
 * Shops: shelves along the walls, rows of shelves down the middle with the aisles between, a till
 * by the way in; a small one is a newsstand.
 */
function shop(out: Layouter, place: Place, poly: PolygonData, fr: Front): void {
  const D = fr.depth;
  const W = fr.width;
  const tint = (place.id * 7 + place.room * 3) % 5;
  const alongFront = Math.atan2(fr.ux, -fr.uy);
  const intoRoom = headingOf(fr.ux, fr.uy);
  const spots: number[] = [];
  const spot = (d: number, c: number, facing: number): void => {
    const [x, y] = at(fr, d, c);
    if (insidePolygon(poly, x, y) && out.withinWalls(x, y)) spots.push(x, y, facing);
  };
  if (D < 4.5 || W < 5) {
    const d = Math.max(SIZE.newsstand[1] / 2 + 0.2, D / 2);
    const [nx, ny] = at(fr, d, 0);
    if (within(poly, fr, d, 0, false, SIZE.newsstand[0], SIZE.newsstand[1]) && out.fits(place.floor, nx, ny, intoRoom + Math.PI / 2, SIZE.newsstand[0] / 2, SIZE.newsstand[1] / 2, false, poly)) {
      out.put('newsstand', place.floor, nx, ny, intoRoom + Math.PI, tint);
      spot(d - SIZE.newsstand[1] / 2 - 0.8, 0.6, intoRoom);
      spot(d - SIZE.newsstand[1] / 2 - 0.8, -0.6, intoRoom);
    }
    out.spots(place.id, spots);
    return;
  }
  // The till, to one side of the way in, facing into the shop.
  const tillAt = Math.min(1.6, D / 3);
  if (modules(out, place, poly, fr, 'till', tillAt, -W / 2 + 0.6, -W / 2 + 2.8, false, intoRoom, tint)) spot(tillAt + 1.0, -W / 2 + 1.7, intoRoom + Math.PI);
  // Shelves along the back wall and down the sides.
  if (modules(out, place, poly, fr, 'shelf', D - SIZE.shelf[1] / 2 - 0.05, -W / 2 + 0.5, W / 2 - 0.5, false, intoRoom + Math.PI, tint)) {
    for (let c = -W / 2 + 1.5; c <= W / 2 - 1.5; c += 1.8) spot(D - 1.5, c, intoRoom);
  }
  if (D > 6) {
    for (const side of [-1, 1]) {
      const c = side * (W / 2 - SIZE.shelf[1] / 2 - 0.05);
      if (modules(out, place, poly, fr, 'shelf', c, 3, D - 1.2, true, alongFront + (side > 0 ? Math.PI : 0), tint)) {
        for (let d = 3.4; d <= D - 1.8; d += 1.7) spot(d, side * (W / 2 - 1.5), side > 0 ? alongFront : alongFront + Math.PI);
      }
    }
  }
  // Rows of shelving down the middle, the aisles between them.
  if (D > 7 && W > 6.5) {
    const rows: number[] = [];
    for (let c = -W / 2 + 2.6; c <= W / 2 - 2.6 + 1e-6; c += 2.5) rows.push(c);
    for (const c of rows) modules(out, place, poly, fr, 'gondola', c, 3.2, D - 2.0, true, alongFront, tint);
    for (let i = 0; i + 1 < rows.length; i += 1) {
      for (let d = 3.6; d <= D - 2.4; d += 1.6) spot(d, (rows[i] + rows[i + 1]) / 2, i % 2 ? alongFront : alongFront + Math.PI);
    }
  }
  if (spots.length < 6) spot(D / 2, 0, intoRoom);
  out.spots(place.id, spots);
}

/** Cafés: shelves and the counter at the back, tables with chairs in front, and room to queue at the counter. */
function food(out: Layouter, place: Place, poly: PolygonData, fr: Front): void {
  const D = fr.depth;
  const W = fr.width;
  const alongFront = Math.atan2(fr.ux, -fr.uy);
  const intoRoom = headingOf(fr.ux, fr.uy);
  const tint = (place.id * 5 + 1) % 4;
  const spots: number[] = [];
  let counterAt = D - SIZE.counter[1] / 2 - 0.1;
  if (D >= 7) {
    modules(out, place, poly, fr, 'kitchen', D - SIZE.kitchen[1] / 2 - 0.05, -W / 2 + 0.4, W / 2 - 0.4, false, intoRoom + Math.PI, tint);
    counterAt = D - SIZE.kitchen[1] - 1.1 - SIZE.counter[1] / 2;
  }
  const span = Math.min(W - 1.2, 6.2);
  if (modules(out, place, poly, fr, 'counter', counterAt, -span / 2, span / 2, false, intoRoom + Math.PI, tint)) {
    for (let c = -Math.min(W / 2 - 1, 2.4); c <= Math.min(W / 2 - 1, 2.4); c += 0.9) {
      const [x, y] = at(fr, counterAt - SIZE.counter[1] / 2 - 0.8, c);
      if (insidePolygon(poly, x, y) && out.withinWalls(x, y)) spots.push(x, y, intoRoom);
    }
  }
  // Tables in a grid: a set of a table and two chairs, or two sets pushed together for four.
  const last = counterAt - SIZE.counter[1] / 2 - 2.0;
  const [tl, tw] = SIZE.table;
  let k = 0;
  for (let d = 1.0 + tw; d <= last - tw / 2; d += 2 * tw + 0.9) {
    for (let c = -W / 2 + tl / 2 + 0.5; c <= W / 2 - tl / 2 - 0.5; c += tl + 0.9) {
      k += 1;
      const four = k % 3 !== 0;
      const offsets = four ? [-tw / 2, tw / 2] : [0];
      if (!offsets.every((o) => within(poly, fr, d + o, c, false, tl, tw))) continue;
      const [x, y] = at(fr, d, c);
      if (!out.fits(place.floor, x, y, alongFront, tl / 2 + 0.1, (offsets.length * tw) / 2 + 0.1, false, poly)) continue;
      const chairs: number[] = [];
      for (const o of offsets) {
        const [tx, ty] = at(fr, d + o, c);
        out.put('table', place.floor, tx, ty, alongFront - Math.PI / 2, tint);
        // The set's chairs stand at each end of its table, facing it.
        for (const end of [-1, 1]) {
          const [cx, cy] = at(fr, d + o, c + end * CHAIR_OUT);
          chairs.push(cx, cy, alongFront + (end > 0 ? Math.PI : 0));
        }
      }
      out.group('food', place.floor, place.id, chairs, chairs[0], chairs[1]);
    }
  }
  if (!spots.length) {
    const [x, y] = at(fr, D / 2, 0);
    if (out.withinWalls(x, y)) spots.push(x, y, intoRoom);
  }
  out.spots(place.id, spots);
}

/** How far from the middle of a café table set its chairs' seats are, metres. */
export const CHAIR_OUT = 0.58;

/** Lounges: a bar along the back and armchairs round low tables. */
function lounge(out: Layouter, place: Place, poly: PolygonData, fr: Front): void {
  const D = fr.depth;
  const W = fr.width;
  const floor = place.floor;
  const alongFront = Math.atan2(fr.ux, -fr.uy);
  const intoRoom = headingOf(fr.ux, fr.uy);
  // A bar along the back.
  modules(out, place, poly, fr, 'counter', D - SIZE.counter[1] / 2 - 0.1, -W / 2 + 0.6, W / 2 - 0.6, false, intoRoom + Math.PI, 4);
  for (let d = 2.2; d <= D - 2.6; d += 3.3) {
    for (let c = -W / 2 + 1.8; c <= W / 2 - 1.8; c += 3.3) {
      if (!within(poly, fr, d, c, false, 2.9, 2.9)) continue;
      const [x, y] = at(fr, d, c);
      if (!out.fits(floor, x, y, alongFront, 1.4, 1.4, false, poly)) continue;
      out.put('lowtable', floor, x, y, alongFront, 0, false);
      const chairs: number[] = [];
      for (const [dd, cc] of [[-0.95, 0], [0.95, 0], [0, -0.95], [0, 0.95]] as const) {
        const [cx, cy] = at(fr, d + dd, c + cc);
        chairs.push(cx, cy, Math.atan2(y - cy, x - cx));
      }
      out.claim(floor, x, y, alongFront, 1.4, 1.4, true);
      out.group('lounge', floor, place.id, chairs, chairs[0], chairs[1]);
    }
  }
  const [x, y] = at(fr, D / 2, 0);
  out.spots(place.id, [x, y, intoRoom]);
}
