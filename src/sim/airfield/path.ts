// A path: the line one aircraft follows across the airfield, with the speed it may hold along it
// and the blocks and nodes its body covers on the way. The aircraft is cleared along a path a
// stretch at a time; `end` is where it must next stop.

import type { TaxiNet } from './net.ts';

/** Metres of centreline either side of a node that a body near it blocks for crossing traffic. */
export const NODE_CLEARANCE = 14;
const ACCEL = 0.9;
const DECEL = 1.1;

export interface Span {
  /** Resource id: a block id, or blockCount + node id. */
  res: number;
  /** Distance of the lead point along the path at which the body starts to cover the resource. */
  from: number;
  /** Distance of the lead point at which the tail has cleared it. */
  to: number;
}

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

export interface Path {
  pts: number[];
  cum: number[];
  /** Speed limit on the segment that starts at each point. */
  limit: number[];
  total: number;
  /** Resources along the path, ordered by `from`. */
  spans: Span[];
  /** Arcs followed, with the distance at which each starts. */
  arcs: number[];
  arcStart: number[];
  /** Nominal seconds from `start` to each point, for a run that stops at `end`. */
  time: number[];
  start: number;
  end: number;
  bodyLength: number;
}

/** Join pieces into one path for a body that reaches `bodyLength` behind its lead point. */
export function buildPath(net: TaxiNet, pieces: readonly Piece[], bodyLength: number): Path {
  const pts: number[] = [];
  const cum: number[] = [];
  const limit: number[] = [];
  const arcs: number[] = [];
  const arcStart: number[] = [];
  const blockSpan = new Map<number, Span>();
  const spans: Span[] = [];
  const nodeBase = net.blocks.length;
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
    if (piece.block !== undefined) {
      const existing = blockSpan.get(piece.block);
      if (existing && existing.to >= from - 2) existing.to = s + bodyLength + 1;
      else {
        const span: Span = { res: piece.block, from: from - 1, to: s + bodyLength + 1 };
        blockSpan.set(piece.block, span);
        spans.push(span);
      }
    }
    if (piece.endNode !== undefined) spans.push({ res: nodeBase + piece.endNode, from: s - NODE_CLEARANCE, to: s + bodyLength + NODE_CLEARANCE });
  }
  spans.sort((a, b) => a.from - b.from);
  const path: Path = { pts, cum, limit, total: s, spans, arcs, arcStart, time: new Array<number>(cum.length).fill(0), start: 0, end: 0, bodyLength };
  return path;
}

/** Recompute the nominal timing for a run from `start` at `speed` that stops at `end`. */
export function retime(path: Path, start: number, speed: number, end: number): void {
  const { cum, limit } = path;
  const n = cum.length;
  const stop = Math.min(end, path.total);
  const v = new Array<number>(n).fill(0);
  let first = 0;
  while (first < n - 1 && cum[first + 1] <= start) first += 1;
  v[first] = speed;
  for (let i = first + 1; i < n; i += 1) {
    const ds = cum[i] - Math.max(start, cum[i - 1]);
    v[i] = Math.min(limit[Math.min(i, n - 1)], limit[i - 1], Math.sqrt(v[i - 1] * v[i - 1] + 2 * ACCEL * ds));
  }
  let ahead = 0;
  let aheadS = stop;
  for (let i = n - 1; i >= first; i -= 1) {
    if (cum[i] > stop) {
      v[i] = 0;
      continue;
    }
    v[i] = Math.min(v[i], Math.sqrt(ahead * ahead + 2 * DECEL * (aheadS - cum[i])));
    ahead = v[i];
    aheadS = cum[i];
  }
  let t = 0;
  for (let i = 0; i <= first; i += 1) path.time[i] = 0;
  for (let i = first + 1; i < n; i += 1) {
    const a = Math.max(start, cum[i - 1]);
    const b = Math.min(stop, cum[i]);
    if (b > a) t += (b - a) / Math.max(1.2, (v[i - 1] + v[i]) / 2);
    path.time[i] = t;
  }
  path.start = start;
  path.end = stop;
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

export interface PathPoint {
  x: number;
  y: number;
  heading: number;
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

/**
 * Where a body is when its lead point is at distance s: the middle of the fuselage and the way it
 * faces. The nose sits `front` metres behind the lead point, or a whole length further back when
 * the path is followed tail first; the nose wheel and the main wheels are on the line. Returns
 * false when the two wheel points coincide, at the very start of a path, and the heading is the
 * line's own.
 */
export function bodyAt(path: Path, s: number, length: number, front: number, reversing: boolean, out: PathPoint, a: PathPoint, b: PathPoint): boolean {
  const nose = reversing ? s - front - length : s - front;
  const sign = reversing ? 1 : -1;
  pointAt(path, nose + sign * 0.12 * length, a);
  pointAt(path, nose + sign * 0.55 * length, b);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const known = dx * dx + dy * dy > 0.01;
  out.heading = known ? Math.atan2(dy, dx) : reversing ? a.heading + Math.PI : a.heading;
  // The middle of the fuselage is half a length behind the nose, a little ahead of the main wheels.
  out.x = a.x + (b.x - a.x) * 0.88;
  out.y = a.y + (b.y - a.y) * 0.88;
  return known;
}

/** Nominal seconds from the path's `start` until the lead point reaches s. */
export function timeAt(path: Path, s: number): number {
  if (s <= path.start) return 0;
  const clamped = Math.min(path.end, s);
  const i = segmentAt(path, clamped);
  const span = path.cum[i + 1] - path.cum[i] || 1;
  const t = (clamped - path.cum[i]) / span;
  return path.time[i] + (path.time[i + 1] - path.time[i]) * Math.max(0, Math.min(1, t));
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
