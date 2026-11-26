// A path: the line one aircraft follows across the airfield, with the speed it may hold along it
// and the ground its fuselage passes over on the way, tile by tile.

import type { TaxiNet } from './net.ts';

/** Metres of centreline either side of a node that a body near it blocks for crossing traffic. */
export const NODE_CLEARANCE = 14;
const ACCEL = 0.9;
const DECEL = 1.1;
/** Metres between the places along a path at which the fuselage's ground is worked out. */
const SWEEP_STEP = 2.5;

export interface Piece {
  /** x, y pairs in the direction of travel. */
  pts: readonly number[];
  speed: number;
  /** Block this piece lies on, if it is on the network. */
  block?: number;
  /** Arc this piece follows, when it follows one in the direction of travel. */
  arc?: number;
  /** Node at the end of the piece, if it ends on one. */
  endNode?: number;
}

/** The aircraft a path is for: how long it is, and whether it follows the path tail first. */
export interface Shape {
  length: number;
  /** Distance of the nose behind the lead point going forwards, or of the tail behind it going tail first. */
  front: number;
  reversing: boolean;
}

export interface Path {
  pts: number[];
  cum: number[];
  /** Speed limit on the segment that starts at each point. */
  limit: number[];
  total: number;
  /** Arcs followed, with the distance at which each starts. */
  arcs: number[];
  arcStart: number[];
  /** Nominal seconds from the start of the path to each point, for a run that does not stop on the way. */
  clock: number[];
  shape: Shape;
  /** Where along the path the aircraft is put on it; the ground is known from here on. */
  origin: number;
  /**
   * The ground the fuselage passes over: each tile once, in the order the lead point comes to them,
   * with the lead point's distance when the fuselage first covers the tile and when it has left it.
   */
  tiles: Int32Array;
  from: Float64Array;
  to: Float64Array;
  /** Indices into `tiles` in the order the tail leaves them. */
  byTo: Int32Array;
  /** Index into `tiles` of each tile on the path. */
  index: Map<number, number>;
}

export interface PathPoint {
  x: number;
  y: number;
  heading: number;
}

export interface Fuselage {
  /** Nose and tail. */
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  /** The point half a length behind the nose, and the way the aircraft faces. */
  x: number;
  y: number;
  heading: number;
  /** False when the path is too short behind the aircraft to give it a direction. */
  ok: boolean;
}

export function newFuselage(): Fuselage {
  return { nx: 0, ny: 0, tx: 0, ty: 0, x: 0, y: 0, heading: 0, ok: false };
}

/**
 * Join pieces into one path for an aircraft put on it with its lead point at `origin`, and work
 * out the ground it will pass over from there to the end.
 */
export function buildPath(net: TaxiNet, pieces: readonly Piece[], shape: Shape, origin: number): Path {
  const pts: number[] = [];
  const cum: number[] = [];
  const limit: number[] = [];
  const arcs: number[] = [];
  const arcStart: number[] = [];
  let s = 0;
  for (const piece of pieces) {
    const from = s;
    for (let i = 0; i < piece.pts.length; i += 2) {
      const x = piece.pts[i];
      const y = piece.pts[i + 1];
      if (pts.length) {
        const d = Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]);
        if (d < 0.02) continue;
        s += d;
        // The segment that ends at this point belongs to this piece.
        limit[limit.length - 1] = piece.speed;
      }
      pts.push(x, y);
      cum.push(s);
      limit.push(piece.speed);
    }
    if (piece.arc !== undefined) {
      arcs.push(piece.arc);
      arcStart.push(from);
    }
  }
  const path: Path = {
    pts,
    cum,
    limit,
    total: s,
    arcs,
    arcStart,
    clock: freeRun(cum, limit),
    shape,
    origin: Math.min(origin, s),
    tiles: new Int32Array(0),
    from: new Float64Array(0),
    to: new Float64Array(0),
    byTo: new Int32Array(0),
    index: new Map(),
  };
  sweep(net, path);
  return path;
}

/** Seconds to each point for a run from standstill at the start to a stop at the end. */
function freeRun(cum: readonly number[], limit: readonly number[]): number[] {
  const n = cum.length;
  const v = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) v[i] = Math.min(limit[i], limit[i - 1], Math.sqrt(v[i - 1] * v[i - 1] + 2 * ACCEL * (cum[i] - cum[i - 1])));
  v[n - 1] = 0;
  for (let i = n - 2; i >= 0; i -= 1) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * DECEL * (cum[i + 1] - cum[i])));
  const clock = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) clock[i] = clock[i - 1] + (cum[i] - cum[i - 1]) / Math.max(1.5, (v[i - 1] + v[i]) / 2);
  return clock;
}

/** Work out the tiles the fuselage covers from the path's origin to its end. */
function sweep(net: TaxiNet, path: Path): void {
  const grid = net.grid;
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  const body = newFuselage();
  const found: number[] = [];
  for (let s = path.origin; ; s = Math.min(path.total, s + SWEEP_STEP)) {
    fuselageAt(path, s, body);
    found.length = 0;
    grid.cover(body.nx, body.ny, body.tx, body.ty, found);
    for (const tile of found) {
      if (!first.has(tile)) first.set(tile, s);
      last.set(tile, s);
    }
    if (s >= path.total) break;
  }
  const n = first.size;
  const tiles = new Int32Array(n);
  const from = new Float64Array(n);
  const to = new Float64Array(n);
  // Map keeps the order the tiles were first met in, which is the order of `from`.
  let i = 0;
  for (const [tile, s] of first) {
    tiles[i] = tile;
    // What is covered where the aircraft is put on the path is covered from the start.
    from[i] = s <= path.origin ? -Infinity : s - SWEEP_STEP;
    // What is still covered at the end of the path is never left on this path.
    to[i] = last.get(tile)! >= path.total ? Infinity : last.get(tile)! + SWEEP_STEP;
    path.index.set(tile, i);
    i += 1;
  }
  path.tiles = tiles;
  path.from = from;
  path.to = to;
  path.byTo = Int32Array.from(Array.from({ length: n }, (_, k) => k).sort((p, q) => to[p] - to[q] || p - q));
}

/** Index of the segment containing distance s. */
function segmentAt(path: Path, s: number): number {
  const cum = path.cum;
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function pointAt(path: Path, s: number, out: PathPoint): PathPoint {
  const clamped = Math.max(0, Math.min(path.total, s));
  const i = segmentAt(path, clamped);
  const span = path.cum[i + 1] - path.cum[i] || 1;
  const t = (clamped - path.cum[i]) / span;
  const x0 = path.pts[i * 2];
  const y0 = path.pts[i * 2 + 1];
  const x1 = path.pts[i * 2 + 2];
  const y1 = path.pts[i * 2 + 3];
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  out.heading = Math.atan2(y1 - y0, x1 - x0);
  return out;
}

const scratchA: PathPoint = { x: 0, y: 0, heading: 0 };
const scratchB: PathPoint = { x: 0, y: 0, heading: 0 };

/**
 * Where the fuselage lies when the lead point is at s: nose wheel and main wheels on the line, the
 * rest of the aircraft straight through them.
 */
export function fuselageAt(path: Path, s: number, out: Fuselage): Fuselage {
  const { length, front, reversing } = path.shape;
  const nose = reversing ? s - front - length : s - front;
  const sign = reversing ? 1 : -1;
  const a = pointAt(path, nose + sign * 0.12 * length, scratchA);
  const b = pointAt(path, nose + sign * 0.55 * length, scratchB);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  out.ok = dx * dx + dy * dy > 0.01;
  // With no room behind it on the path the aircraft faces the way the path runs there.
  out.heading = out.ok ? Math.atan2(dy, dx) : a.heading + (reversing ? Math.PI : 0);
  // The middle of the aircraft is a little ahead of the main wheels.
  out.x = a.x + (b.x - a.x) * 0.88;
  out.y = a.y + (b.y - a.y) * 0.88;
  const ux = Math.cos(out.heading);
  const uy = Math.sin(out.heading);
  out.nx = out.x + (ux * length) / 2;
  out.ny = out.y + (uy * length) / 2;
  out.tx = out.x - (ux * length) / 2;
  out.ty = out.y - (uy * length) / 2;
  return out;
}

/** Nominal seconds for the lead point to run from distance a to distance b without stopping. */
export function runSeconds(path: Path, a: number, b: number): number {
  return clockAt(path, b) - clockAt(path, a);
}

function clockAt(path: Path, s: number): number {
  const clamped = Math.max(0, Math.min(path.total, s));
  const i = segmentAt(path, clamped);
  const span = path.cum[i + 1] - path.cum[i] || 1;
  return path.clock[i] + (path.clock[i + 1] - path.clock[i]) * ((clamped - path.cum[i]) / span);
}

export function limitAt(path: Path, s: number): number {
  return path.limit[segmentAt(path, Math.max(0, Math.min(path.total, s)))];
}

/**
 * The speed that still lets the lead point stop at `stop` and meet every lower limit ahead,
 * braking at `decel`.
 */
export function speedFor(path: Path, s: number, stop: number, decel: number): number {
  let allowed = Math.min(limitAt(path, s), Math.sqrt(2 * decel * Math.max(0, stop - s)));
  const from = segmentAt(path, s) + 1;
  for (let i = from; i < path.cum.length - 1; i += 1) {
    const gap = path.cum[i] - s;
    if (gap > 260 || path.cum[i] >= stop) break;
    const v = path.limit[i];
    allowed = Math.min(allowed, Math.sqrt(v * v + 2 * decel * gap));
  }
  return allowed;
}

/** The path's points from distance a to distance b as x, y pairs; reversed when b is less than a. */
export function slice(path: Path, a: number, b: number): number[] {
  const p: PathPoint = { x: 0, y: 0, heading: 0 };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  pointAt(path, lo, p);
  const forward: number[] = [p.x, p.y];
  for (let i = 0; i < path.cum.length; i += 1) {
    if (path.cum[i] > lo + 0.05 && path.cum[i] < hi - 0.05) forward.push(path.pts[i * 2], path.pts[i * 2 + 1]);
  }
  pointAt(path, hi, p);
  forward.push(p.x, p.y);
  if (b >= a) return forward;
  const out: number[] = [];
  for (let i = forward.length - 2; i >= 0; i -= 2) out.push(forward[i], forward[i + 1]);
  return out;
}

/** One piece per arc, for a route on the network. */
export function arcPieces(net: TaxiNet, arcs: readonly number[]): Piece[] {
  return arcs.map((arc) => {
    const block = net.arcBlock(arc);
    return { pts: net.arcPoints(arc), speed: block.speed, block: block.id, arc, endNode: net.arcTo(arc) };
  });
}

/**
 * The pieces of `path` that lie between distances a and b, keeping which block each is on, so a
 * new path can start with the ground a body already covers. With b less than a they run backwards.
 */
export function coveredPieces(net: TaxiNet, path: Path, a: number, b: number, speed: number): Piece[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const pieces: Piece[] = [];
  let cursor = lo;
  for (let i = 0; i < path.arcs.length; i += 1) {
    const from = path.arcStart[i];
    const to = i + 1 < path.arcs.length ? path.arcStart[i + 1] : path.total;
    if (to <= lo || from >= hi) continue;
    if (from > cursor + 0.05) pieces.push({ pts: slice(path, cursor, from), speed });
    const startS = Math.max(lo, from);
    const endS = Math.min(hi, to);
    const piece: Piece = { pts: slice(path, startS, endS), speed, block: net.arcBlock(path.arcs[i]).id };
    if (endS >= to - 0.05) piece.endNode = net.arcTo(path.arcs[i]);
    pieces.push(piece);
    cursor = endS;
  }
  if (cursor < hi - 0.05) pieces.push({ pts: slice(path, cursor, hi), speed });
  if (b >= a) return pieces;
  // Backwards: reverse the order and each piece, and move each node to the piece that now ends on it.
  const reversed: Piece[] = [];
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const source = pieces[i];
    const pts: number[] = [];
    for (let k = source.pts.length - 2; k >= 0; k -= 2) pts.push(source.pts[k], source.pts[k + 1]);
    const piece: Piece = { pts, speed };
    if (source.block !== undefined) piece.block = source.block;
    const before = i > 0 ? pieces[i - 1] : null;
    if (before?.endNode !== undefined) piece.endNode = before.endNode;
    reversed.push(piece);
  }
  return reversed;
}
