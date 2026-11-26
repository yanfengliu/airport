// Ways to push an aircraft back from its stand.
//
// A tug backs the aircraft up the lead-in onto the taxilane, tail first, and leaves it facing the
// way it will taxi out. The painted lead-in usually curves one way only, which would leave the
// nose pointing one way only, often into the dead end of an alley. So besides following the paint
// there is the swing: straight back along the stand's own axis, then the tail turned the other
// way onto the taxilane. And where a stand's own junction offers no way out at all, the push goes
// on, tail first, to the next junction and the tail is turned into a side of that.

import type { Stand } from '../../shared/layout.ts';
import { MAX_TURN, type TaxiNet } from '../airfield/net.ts';
import { arcPieces, type Piece } from '../airfield/path.ts';

export interface PushbackOption {
  /** Arcs followed tail first. */
  out: number[];
  /** Distance along the push at which the aircraft's way out begins: it must be pushed wholly past it. */
  joinAt: number;
  /** The arc the aircraft ends up on, pointing forwards; it arrives at the junction it leaves by. */
  forward: number;
  /** For a swing: the line to follow instead of the arcs' own. */
  pieces?: Piece[];
  /** For a swing: from where it meets the taxilane back to the junction, for leaving forwards. */
  link?: Piece[];
}

/** How far a tug will push an aircraft, metres, and how many junctions it will push it through. */
const PUSH_LIMIT = 460;
const PUSH_JUNCTIONS = 3;
/** Longest straight-to-curve lead of a swing, metres. */
const SWING_REACH = 45;

/** Add taxiway arcs straight on from the last of `arcs` until `need` more metres are covered. */
function straightOn(net: TaxiNet, arcs: number[], need: number): boolean {
  let covered = 0;
  let tail = arcs[arcs.length - 1];
  while (covered < need) {
    let next = -1;
    let straightest = MAX_TURN;
    for (const candidate of net.arcsFrom(net.arcTo(tail))) {
      if (candidate === (tail ^ 1) || net.arcBlock(candidate).kind !== 'twy') continue;
      const turn = net.turn(tail, candidate);
      if (turn < straightest) {
        straightest = turn;
        next = candidate;
      }
    }
    if (next === -1) return false;
    arcs.push(next);
    covered += net.arcBlock(next).len;
    tail = next;
  }
  return true;
}

/** Where the stand's axis, run back from the stop point, crosses the line of a taxilane arc. */
function crossing(net: TaxiNet, stand: Stand, arc: number): { s: number; r: number } | null {
  const junction = net.nodes[net.arcFrom(arc)];
  const ax = -Math.cos(stand.heading);
  const ay = -Math.sin(stand.heading);
  const heading = net.arcStartHeading(arc);
  const ex = Math.cos(heading);
  const ey = Math.sin(heading);
  const cross = ax * ey - ay * ex;
  // A taxilane that runs along the stand's axis has no side to swing to.
  if (Math.abs(cross) < 0.3) return null;
  const dx = junction.x - stand.x;
  const dy = junction.y - stand.y;
  return { s: (dx * ey - dy * ex) / cross, r: (dx * ay - dy * ax) / cross };
}

function lengthOf(pts: readonly number[]): number {
  let total = 0;
  for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return total;
}

/** The part of a line of x, y pairs between two distances along it. */
function between(pts: readonly number[], from: number, to: number): number[] {
  const out: number[] = [];
  let run = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2];
    const y0 = pts[i - 1];
    const x1 = pts[i];
    const y1 = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 0 && run + len >= from && run <= to) {
      const a = Math.max(0, (from - run) / len);
      const b = Math.min(1, (to - run) / len);
      if (!out.length) out.push(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
      out.push(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
    }
    run += len;
  }
  // Past the end of the line: the last point, twice, so the result is always a line.
  if (!out.length) out.push(pts[pts.length - 2], pts[pts.length - 1], pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

function reversed(pts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/**
 * The swing: back along the stand's axis from the stop point, then a curve onto the taxilane in
 * the direction of `tail`, the taxiway arcs the aircraft ends up on. `lead` is the lead-in's arcs,
 * whose ground the first part still covers.
 */
function swing(net: TaxiNet, stand: Stand, lead: readonly number[], tail: readonly number[], length: number): { pieces: Piece[]; joinAt: number; link: Piece[] } | null {
  const at = crossing(net, stand, tail[0]);
  if (!at) return null;
  const { s, r } = at;
  if (r < -20) return null;
  const run: number[] = [];
  const arcEnd: number[] = [];
  for (const arc of tail) {
    const pts = net.arcPoints(arc);
    for (let i = run.length ? 2 : 0; i < pts.length; i += 2) run.push(pts[i], pts[i + 1]);
    arcEnd.push(lengthOf(run));
  }
  const total = arcEnd[arcEnd.length - 1];
  // The curve starts behind the fuselage, so the aircraft leaves the stand as it stands in it,
  // and is as wide as the taxilane beyond it leaves room for.
  const reach = Math.min(SWING_REACH, s - 0.6 * length - 2, total - Math.max(0, r) - length - 1);
  if (reach < 10) return null;
  const meet = Math.max(0.5, r + reach);

  const ax = -Math.cos(stand.heading);
  const ay = -Math.sin(stand.heading);
  const cx = stand.x + ax * s;
  const cy = stand.y + ay * s;
  const fx = cx - ax * reach;
  const fy = cy - ay * reach;
  const end = between(run, meet, meet);
  const first: number[] = [stand.x, stand.y];
  const second: number[] = [];
  const steps = 12;
  for (let k = 0; k <= steps; k += 1) {
    const u = k / steps;
    const x = (1 - u) * (1 - u) * fx + 2 * u * (1 - u) * cx + u * u * end[0];
    const y = (1 - u) * (1 - u) * fy + 2 * u * (1 - u) * cy + u * u * end[1];
    if (k <= steps / 2) first.push(x, y);
    if (k >= steps / 2) second.push(x, y);
  }

  // The lead-in's blocks share the first half in proportion to their lengths.
  const pieces: Piece[] = [];
  const leadLength = lead.reduce((sum, arc) => sum + net.arcBlock(arc).len, 0);
  const firstLength = lengthOf(first);
  let done = 0;
  for (const arc of lead) {
    const block = net.arcBlock(arc);
    const next = done + (block.len / leadLength) * firstLength;
    pieces.push({ pts: between(first, done, next), speed: block.speed, block: block.id, arc, endNode: net.arcTo(arc) });
    done = next;
  }
  // The taxilane's blocks: the first takes the second half of the curve, the rest of the run follows.
  let from = 0;
  tail.forEach((arc, index) => {
    const block = net.arcBlock(arc);
    const to = arcEnd[index];
    const beyond = to > meet ? between(run, Math.max(from, meet), to) : [end[0], end[1], end[0], end[1]];
    pieces.push({ pts: index === 0 ? [...second, ...beyond] : beyond, speed: block.speed, block: block.id, arc, endNode: net.arcTo(arc) });
    from = to;
  });

  // Leaving forwards: from where the curve met the taxilane back along it to the junction.
  const link: Piece[] = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const start = index === 0 ? 0 : arcEnd[index - 1];
    if (start >= meet) continue;
    const block = net.arcBlock(tail[index]);
    link.push({ pts: reversed(between(run, start, Math.min(arcEnd[index], meet))), speed: block.speed, block: block.id, endNode: net.arcFrom(tail[index]) });
  }
  return { pieces, joinAt: firstLength + lengthOf(second), link };
}

/**
 * Ways to push back from the stand whose stop point is `standNode`, for a body that needs
 * `length` metres of taxiway behind the junction it will leave by.
 */
export function pushbackOptions(net: TaxiNet, standNode: number, length: number): PushbackOption[] {
  const options: PushbackOption[] = [];
  const seen = new Set<string>();
  const standId = net.nodes[standNode].stand;
  const stand = standId ? net.stands.get(standId) : undefined;

  /** `arcs` reach `node` after `distance` metres; try turning the tail into each way out of it. */
  const walk = (node: number, arcs: number[], distance: number, junctions: number): void => {
    if (arcs.length > 26 || options.length >= 24 || distance > PUSH_LIMIT) return;
    const last = arcs.length ? arcs[arcs.length - 1] : -1;
    const onTaxiway = last !== -1 && net.arcBlock(last).kind === 'twy';
    const ways = net.arcsFrom(node).filter((arc) => arc !== (last ^ 1));
    const branching = ways.filter((arc) => net.arcBlock(arc).kind === 'twy').length > 1;
    for (const arc of ways) {
      const block = net.arcBlock(arc);
      const turn = last === -1 ? 0 : net.turn(last, arc);
      if (block.kind === 'stand') {
        // Still on the lead-in; never back through another stand.
        if (onTaxiway || turn > MAX_TURN || net.nodes[net.arcTo(arc)].stand) continue;
        walk(net.arcTo(arc), [...arcs, arc], distance + block.len, junctions);
        continue;
      }
      if (block.kind !== 'twy' || last === -1) continue;
      const key = `${node}:${arc}`;
      if (turn > MAX_TURN) {
        // No line is painted this way. Off the lead-in the tug can still swing the tail round.
        if (onTaxiway || !stand || seen.has(key)) continue;
        seen.add(key);
        const at = crossing(net, stand, arc);
        if (!at) continue;
        const tail = [arc];
        // As much taxilane as a full swing wants, or as much as there is.
        straightOn(net, tail, length + Math.max(0, at.r) + SWING_REACH - block.len);
        const swung = swing(net, stand, arcs, tail, length);
        if (swung) options.push({ out: [...arcs, ...tail], joinAt: swung.joinAt, forward: arc ^ 1, pieces: swung.pieces, link: swung.link });
        continue;
      }
      if (!seen.has(key)) {
        seen.add(key);
        const out = [...arcs, arc];
        if (block.len >= length || straightOn(net, out, length - block.len)) options.push({ out, joinAt: distance, forward: arc ^ 1 });
      }
      const deeper = junctions + (onTaxiway && branching ? 1 : 0);
      if (deeper <= PUSH_JUNCTIONS) walk(net.arcTo(arc), [...arcs, arc], distance + block.len, deeper);
    }
  };
  walk(standNode, [], 0, 0);
  return options;
}

/** The pieces an option's push follows. */
export function pushPieces(net: TaxiNet, option: PushbackOption): Piece[] {
  return option.pieces ?? arcPieces(net, option.out);
}
