// Ground traffic control, built the way a railway interlocking is.
//
// Every aircraft on the ground follows a path and is cleared along it a stretch at a time. The
// ground a clearance covers is the ground the fuselage sweeps: the path is turned into a row of
// poses a few metres apart, each the straight line of the fuselage with the lead point there, and
// two poses are on the same ground when those lines come within APART metres. Three rules:
//
//  1. Nothing is cleared through the place where another aircraft stands or will come to rest.
//  2. A clearance gives way to every clearance made before it: where two cross, the later aircraft
//     waits until the earlier has gone by. The earliest clearance of all waits for nobody, so
//     every clearance, once given, is carried out.
//  3. An aircraft may come to rest only where that leaves no ring of aircraft each standing across
//     the next one's way on. With no ring there is always an aircraft with nobody standing in its
//     way, and it can be cleared all the way to where it is going.
//
// Rules 1 and 2 keep aircraft apart. Rules 2 and 3 keep them moving: a wait is always for an
// earlier clearance or for an aircraft further down a chain that ends, never round a ring.

import { bodyAt, type Path, type PathPoint } from './path.ts';

/** Metres of travel between the poses an envelope is made of. */
export const STEP = 3;
/** Fuselage centrelines closer than this, metres, are on the same ground. */
export const APART = 11;
/** Closer than this, metres, and the interlocking has failed; counted by the audit. */
const TOUCHING = 5;
const CHUNK = 8;

/** The ground a body sweeps along a path. */
export interface Envelope {
  /** Nose x, y and tail x, y of the fuselage for each pose; pose k has the lead point at k * STEP. */
  seg: Float64Array;
  count: number;
  /** Bounds of each run of CHUNK poses: least x, least y, greatest x, greatest y. */
  box: Float64Array;
}

/** A place on another aircraft's path that must be behind it before this one goes further. */
interface Gate {
  /** The first pose this aircraft may not take up until the gate opens. */
  at: number;
  other: Mover;
  /** The other aircraft's lead point must have come this far along its path. */
  need: number;
  /** The clearance of the other aircraft the gate belongs to; a newer one means it has gone by. */
  epoch: number;
}

export interface Mover {
  id: number;
  /** Fuselage length, and how far behind the lead point the nose is. */
  length: number;
  front: number;
  path: Path | null;
  env: Envelope | null;
  /** True while the path is followed tail first. */
  reversing: boolean;
  /** Lead point's distance along the path, and its speed. */
  s: number;
  v: number;
  /** Where the current clearance ends: the aircraft rests there until cleared on. */
  end: number;
  /** The aircraft does not move, and is not yet on its path, before this time. */
  startAt: number;
  /** Off its stand and going somewhere: the rest of its path is its way on. */
  bound: boolean;
  /** Taxiing in to a stand. */
  inbound: boolean;
  /** Taxiing out to a runway: others bound for a runway may queue behind it. */
  queued: boolean;
  /** The way it goes after this path, when that is already fixed: a pushback's way out. */
  onward: Envelope | null;
  onwardFrom: number;
  gates: Gate[];
  gateFrom: number;
  epoch: number;
}

export interface ClaimOptions {
  /** Refuse unless the clearance reaches the whole way. */
  whole?: boolean;
  /** Short of the whole way, the aircraft may rest only behind one for which this holds. */
  behind?: (other: Mover) => boolean;
  /** The smallest advance worth making, metres. */
  least?: number;
  /** The ground up to this distance must be free to enter at once. */
  openTo?: number;
  /** Refuse to rest across the way on of any aircraft for which this holds. */
  yieldTo?: (other: Mover) => boolean;
}

export interface ClaimResult {
  ok: boolean;
  /** Where the clearance now ends. */
  end: number;
  /** When refused or cut short: the aircraft in the way, or -1. */
  blocker: number;
  /** Refused because resting there would close a ring, or stand in the way of one it yields to. */
  ring: boolean;
}

export interface PlaceOptions {
  reversing?: boolean;
  bound?: boolean;
  inbound?: boolean;
  queued?: boolean;
  env?: Envelope;
  onward?: Envelope | null;
  onwardFrom?: number;
}

export function newMover(id: number, length: number, front: number): Mover {
  return { id, length, front, path: null, env: null, reversing: false, s: 0, v: 0, end: 0, startAt: 0, bound: false, inbound: false, queued: false, onward: null, onwardFrom: 0, gates: [], gateFrom: 0, epoch: 0 };
}

export function buildEnvelope(path: Path, length: number, front: number, reversing: boolean): Envelope {
  const count = Math.floor(path.total / STEP) + 2;
  const seg = new Float64Array(count * 4);
  const pose: PathPoint = { x: 0, y: 0, heading: 0 };
  const a: PathPoint = { x: 0, y: 0, heading: 0 };
  const b: PathPoint = { x: 0, y: 0, heading: 0 };
  const half = length / 2;
  for (let k = 0; k < count; k += 1) {
    bodyAt(path, Math.min(k * STEP, path.total), length, front, reversing, pose, a, b);
    const ux = Math.cos(pose.heading) * half;
    const uy = Math.sin(pose.heading) * half;
    seg[k * 4] = pose.x + ux;
    seg[k * 4 + 1] = pose.y + uy;
    seg[k * 4 + 2] = pose.x - ux;
    seg[k * 4 + 3] = pose.y - uy;
  }
  const chunks = Math.ceil(count / CHUNK);
  const box = new Float64Array(chunks * 4);
  for (let c = 0; c < chunks; c += 1) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = c * CHUNK; k < Math.min(count, (c + 1) * CHUNK); k += 1) {
      x0 = Math.min(x0, seg[k * 4], seg[k * 4 + 2]);
      x1 = Math.max(x1, seg[k * 4], seg[k * 4 + 2]);
      y0 = Math.min(y0, seg[k * 4 + 1], seg[k * 4 + 3]);
      y1 = Math.max(y1, seg[k * 4 + 1], seg[k * 4 + 3]);
    }
    box[c * 4] = x0;
    box[c * 4 + 1] = y0;
    box[c * 4 + 2] = x1;
    box[c * 4 + 3] = y1;
  }
  return { seg, count, box };
}

function pointToLine2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const ex = px - (ax + dx * t);
  const ey = py - (ay + dy * t);
  return ex * ex + ey * ey;
}

/** Are two fuselage lines, four numbers each at p[i] and q[j], within `apart` metres of each other? */
function near(p: Float64Array, i: number, q: Float64Array, j: number, apart: number): boolean {
  const ax = p[i];
  const ay = p[i + 1];
  const bx = p[i + 2];
  const by = p[i + 3];
  const cx = q[j];
  const cy = q[j + 1];
  const dx = q[j + 2];
  const dy = q[j + 3];
  if (Math.min(ax, bx) - apart > Math.max(cx, dx) || Math.max(ax, bx) + apart < Math.min(cx, dx)) return false;
  if (Math.min(ay, by) - apart > Math.max(cy, dy) || Math.max(ay, by) + apart < Math.min(cy, dy)) return false;
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  const limit = apart * apart;
  return pointToLine2(ax, ay, cx, cy, dx, dy) < limit || pointToLine2(bx, by, cx, cy, dx, dy) < limit || pointToLine2(cx, cy, ax, ay, bx, by) < limit || pointToLine2(dx, dy, ax, ay, bx, by) < limit;
}

const REFUSED = (end: number, blocker: number, ring: boolean): ClaimResult => ({ ok: false, end, blocker, ring });

export class Traffic {
  private readonly movers: Mover[] = [];
  /** Changes whenever anyone's resting place or way on does. */
  private version = 0;
  private readonly blockerCache = new Map<number, { version: number; list: Mover[] }>();
  private readonly counted = new Set<string>();
  private readonly pose: PathPoint = { x: 0, y: 0, heading: 0 };
  private readonly scratchA: PathPoint = { x: 0, y: 0, heading: 0 };
  private readonly scratchB: PathPoint = { x: 0, y: 0, heading: 0 };
  private readonly rest = new Float64Array(4);
  /**
   * Counted for the soak tests: the times an aircraft was found on ground an earlier clearance
   * had not given up. The audit measures it from where the aircraft actually are.
   */
  outOfOrder = 0;

  get activeCount(): number {
    return this.movers.length;
  }

  /** Put an aircraft on a path where it stands, at rest. */
  place(mover: Mover, path: Path, s: number, now: number, options: PlaceOptions = {}): void {
    this.set(mover, path, s, now, options);
    if (!this.movers.includes(mover)) this.movers.push(mover);
    this.version += 1;
  }

  /** The same aircraft on another path, to try clearances on without committing to them. */
  candidate(mover: Mover, path: Path, s: number, now: number, options: PlaceOptions = {}): Mover {
    const trial = newMover(mover.id, mover.length, mover.front);
    this.set(trial, path, s, now, options);
    return trial;
  }

  /** Make a candidate, with the clearances it has been given, the aircraft's own. */
  adopt(mover: Mover, trial: Mover): void {
    const epoch = mover.epoch + 1;
    Object.assign(mover, trial);
    mover.epoch = epoch;
    if (!this.movers.includes(mover)) this.movers.push(mover);
    this.version += 1;
  }

  private set(mover: Mover, path: Path, s: number, now: number, options: PlaceOptions): void {
    mover.path = path;
    mover.reversing = options.reversing ?? false;
    mover.env = options.env ?? buildEnvelope(path, mover.length, mover.front, mover.reversing);
    mover.s = s;
    mover.v = 0;
    mover.end = s;
    mover.startAt = now;
    mover.bound = options.bound ?? false;
    mover.inbound = options.inbound ?? false;
    mover.queued = options.queued ?? false;
    mover.onward = options.onward ?? null;
    mover.onwardFrom = options.onwardFrom ?? 0;
    mover.gates = [];
    mover.gateFrom = 0;
    mover.epoch += 1;
  }

  /** The aircraft has arrived where it was going and has no way on. */
  settle(mover: Mover): void {
    mover.bound = false;
    mover.inbound = false;
    mover.queued = false;
    mover.onward = null;
    this.version += 1;
  }

  /** Take an aircraft off the ground. */
  remove(mover: Mover): void {
    const at = this.movers.indexOf(mover);
    if (at >= 0) this.movers.splice(at, 1);
    mover.path = null;
    mover.env = null;
    mover.onward = null;
    mover.gates = [];
    mover.gateFrom = 0;
    mover.bound = false;
    mover.epoch += 1;
    this.blockerCache.delete(mover.id);
    this.version += 1;
  }

  /**
   * Ask to move the clearance limit towards `target`. Whatever is given is given at once and the
   * aircraft may set off; it waits on the way wherever an earlier clearance crosses its own.
   */
  claim(mover: Mover, target: number, options: ClaimOptions = {}): ClaimResult {
    const env = mover.env;
    const path = mover.path;
    if (!env || !path) return REFUSED(0, -1, false);
    const from = mover.end;
    const goal = Math.min(target, path.total);
    if (goal <= from + 0.01) return { ok: true, end: from, blocker: -1, ring: false };
    const seg = env.seg;
    const first = Math.floor(from / STEP) + 1;
    const last = Math.min(env.count - 1, Math.ceil(goal / STEP));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = first; i <= last; i += 1) {
      x0 = Math.min(x0, seg[i * 4], seg[i * 4 + 2]);
      x1 = Math.max(x1, seg[i * 4], seg[i * 4 + 2]);
      y0 = Math.min(y0, seg[i * 4 + 1], seg[i * 4 + 3]);
      y1 = Math.max(y1, seg[i * 4 + 1], seg[i * 4 + 3]);
    }
    x0 -= APART;
    y0 -= APART;
    x1 += APART;
    y1 += APART;

    const gates: Gate[] = [];
    // The first pose that cannot be taken up at all, and who is resting there.
    let cut = last + 1;
    let cutBy: Mover | null = null;
    for (const other of this.movers) {
      const oe = other.env;
      if (other.id === mover.id || !oe) continue;
      // The poses the other still has to pass through; from `hard` on it rests in them.
      const lo = Math.max(0, Math.min(oe.count - 1, Math.floor(other.s / STEP)));
      const hard = Math.floor(other.end / STEP);
      const hi = Math.min(oe.count - 1, Math.ceil(other.end / STEP));
      let touches = false;
      for (let c = Math.floor(lo / CHUNK); c <= Math.floor(hi / CHUNK) && !touches; c += 1) {
        touches = !(oe.box[c * 4] > x1 || oe.box[c * 4 + 2] < x0 || oe.box[c * 4 + 1] > y1 || oe.box[c * 4 + 3] < y0);
      }
      if (!touches) continue;
      for (let i = first; i < cut; i += 1) {
        const p = i * 4;
        const px0 = Math.min(seg[p], seg[p + 2]) - APART;
        const px1 = Math.max(seg[p], seg[p + 2]) + APART;
        const py0 = Math.min(seg[p + 1], seg[p + 3]) - APART;
        const py1 = Math.max(seg[p + 1], seg[p + 3]) + APART;
        // The last of the other's poses that this one is in the way of.
        let latest = -1;
        for (let c = Math.floor(hi / CHUNK); c >= Math.floor(lo / CHUNK) && latest < 0; c -= 1) {
          if (oe.box[c * 4] > px1 || oe.box[c * 4 + 2] < px0 || oe.box[c * 4 + 1] > py1 || oe.box[c * 4 + 3] < py0) continue;
          for (let j = Math.min(hi, c * CHUNK + CHUNK - 1); j >= Math.max(lo, c * CHUNK); j -= 1) {
            if (near(seg, p, oe.seg, j * 4, APART)) {
              latest = j;
              break;
            }
          }
        }
        if (latest < 0) continue;
        if (latest >= hard) {
          cut = i;
          cutBy = other;
          break;
        }
        gates.push({ at: i, other, need: (latest + 1) * STEP, epoch: other.epoch });
      }
    }

    const reach = cut <= last ? Math.min(goal, (cut - 1) * STEP) : goal;
    const blocker = cutBy ? cutBy.id : -1;
    if (reach < goal - 0.01 && (options.whole || !options.behind || !cutBy || !options.behind(cutBy))) return REFUSED(from, blocker, false);
    if (reach - from < (options.least ?? 0.5)) return REFUSED(from, blocker, false);
    const reachPose = Math.ceil(reach / STEP);
    const kept = gates.filter((g) => g.at <= reachPose).sort((p, q) => p.at - q.at);
    if (options.openTo !== undefined) {
      const openPose = Math.ceil(Math.min(options.openTo, reach) / STEP);
      for (const g of kept) {
        if (g.at > openPose) break;
        if (!this.open(g)) return REFUSED(from, g.other.id, false);
      }
    }
    if (!this.restsFreely(mover, reach, options.yieldTo)) return REFUSED(from, blocker, true);
    mover.end = reach;
    for (const g of kept) mover.gates.push(g);
    this.version += 1;
    return { ok: true, end: reach, blocker, ring: false };
  }

  private open(gate: Gate): boolean {
    return gate.other.epoch !== gate.epoch || gate.other.s >= gate.need;
  }

  /** The farthest the lead point may go right now. */
  limit(mover: Mover, now: number): number {
    if (!mover.path || now < mover.startAt) return mover.s;
    const gates = mover.gates;
    while (mover.gateFrom < gates.length) {
      const gate = gates[mover.gateFrom];
      if (!this.open(gate)) return Math.max(mover.s, Math.min(mover.end, (gate.at - 1) * STEP));
      mover.gateFrom += 1;
    }
    return mover.end;
  }

  /** The aircraft whose passing this one is waiting for, or -1. */
  waitingFor(mover: Mover): number {
    const gate = mover.gates[mover.gateFrom];
    return gate && !this.open(gate) ? gate.other.id : -1;
  }

  /** Blocks under aircraft that are bound somewhere and rest, or will come to rest, on them. */
  restBlocks(blockCount: number, except: (mover: Mover) => boolean): Set<number> {
    const out = new Set<number>();
    for (const m of this.movers) {
      if (!m.bound || !m.path || except(m)) continue;
      for (const span of m.path.spans) {
        if (span.from > m.end) break;
        if (span.to > m.end && span.res < blockCount) out.add(span.res);
      }
    }
    return out;
  }

  // ---- rule 3: no ring of aircraft standing in each other's way ---------------------------

  /** Does any pose of an envelope, from pose `from` on, come within APART of the line in `rest`? */
  private sweeps(env: Envelope | null, from: number, rest: Float64Array): boolean {
    if (!env || from >= env.count) return false;
    const x0 = Math.min(rest[0], rest[2]) - APART;
    const x1 = Math.max(rest[0], rest[2]) + APART;
    const y0 = Math.min(rest[1], rest[3]) - APART;
    const y1 = Math.max(rest[1], rest[3]) + APART;
    const box = env.box;
    for (let c = Math.floor(from / CHUNK); c * CHUNK < env.count; c += 1) {
      if (box[c * 4] > x1 || box[c * 4 + 2] < x0 || box[c * 4 + 1] > y1 || box[c * 4 + 3] < y0) continue;
      const stop = Math.min(env.count, (c + 1) * CHUNK);
      for (let k = Math.max(from, c * CHUNK); k < stop; k += 1) if (near(env.seg, k * 4, rest, 0, APART)) return true;
    }
    return false;
  }

  /** Does the way on of `z`, beyond where its clearance ends, pass through the line in `rest`? */
  private wayThrough(z: Mover, rest: Float64Array): boolean {
    if (!z.bound) return false;
    return this.sweeps(z.env, Math.ceil(z.end / STEP) + 1, rest) || this.sweeps(z.onward, z.onwardFrom, rest);
  }

  /** Does the resting place of `y` lie on the way given by an envelope from a pose on, or by a second envelope? */
  private restsOn(y: Mover, env: Envelope | null, from: number, onward: Envelope | null, onwardFrom: number): boolean {
    const ye = y.env;
    if (!ye) return false;
    const lo = Math.max(0, Math.min(ye.count - 1, Math.floor(y.end / STEP)));
    const hi = Math.min(ye.count - 1, Math.ceil(y.end / STEP));
    for (let k = lo; k <= hi; k += 1) {
      this.rest.set(ye.seg.subarray(k * 4, k * 4 + 4));
      if (this.sweeps(env, from, this.rest) || this.sweeps(onward, onwardFrom, this.rest)) return true;
    }
    return false;
  }

  /** The aircraft resting across the way on of `y`. */
  private blockers(y: Mover): Mover[] {
    const known = this.blockerCache.get(y.id);
    if (known && known.version === this.version) return known.list;
    const list: Mover[] = [];
    if (y.bound) {
      const from = Math.ceil(y.end / STEP) + 1;
      for (const w of this.movers) if (w.id !== y.id && this.restsOn(w, y.env, from, y.onward, y.onwardFrom)) list.push(w);
    }
    this.blockerCache.set(y.id, { version: this.version, list });
    return list;
  }

  /** May the aircraft come to rest with its lead point at `reach`? */
  private restsFreely(mover: Mover, reach: number, yieldTo?: (other: Mover) => boolean): boolean {
    const env = mover.env!;
    const pose = this.pose;
    bodyAt(mover.path!, reach, mover.length, mover.front, mover.reversing, pose, this.scratchA, this.scratchB);
    const half = mover.length / 2;
    const rest = new Float64Array(4);
    rest[0] = pose.x + Math.cos(pose.heading) * half;
    rest[1] = pose.y + Math.sin(pose.heading) * half;
    rest[2] = pose.x - Math.cos(pose.heading) * half;
    rest[3] = pose.y - Math.sin(pose.heading) * half;
    // Whose way on would it be standing across?
    const across: Mover[] = [];
    for (const z of this.movers) if (z.id !== mover.id && this.wayThrough(z, rest)) across.push(z);
    if (!across.length) return true;
    if (yieldTo && across.some(yieldTo)) return false;
    // Who rests across its own way on from there, who across theirs, and so on: a ring closes if
    // the chain comes back to one of those it would be standing across.
    const from = Math.ceil(reach / STEP) + 1;
    const seen = new Set<number>([mover.id]);
    const chain: Mover[] = [];
    for (const y of this.movers) {
      if (y.id === mover.id || !this.restsOn(y, env, from, mover.onward, mover.onwardFrom)) continue;
      seen.add(y.id);
      chain.push(y);
    }
    while (chain.length) {
      const y = chain.pop()!;
      if (across.includes(y)) return false;
      for (const w of this.blockers(y)) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        chain.push(w);
      }
    }
    return true;
  }

  /** The aircraft resting across this one's way on, for reports. */
  inTheWayOf(mover: Mover): number[] {
    return this.blockers(mover).map((m) => m.id);
  }

  // ---- audit ----------------------------------------------------------------------------

  /**
   * Measure, from where the aircraft actually are, whether any two are on the same ground. This
   * is the check on the rules above; a pair found is counted once.
   */
  audit(now: number): void {
    const list = this.movers;
    const lines = new Float64Array(list.length * 4);
    const pose = this.pose;
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      if (!m.path) continue;
      bodyAt(m.path, m.s, m.length, m.front, m.reversing, pose, this.scratchA, this.scratchB);
      const half = m.length / 2;
      lines[i * 4] = pose.x + Math.cos(pose.heading) * half;
      lines[i * 4 + 1] = pose.y + Math.sin(pose.heading) * half;
      lines[i * 4 + 2] = pose.x - Math.cos(pose.heading) * half;
      lines[i * 4 + 3] = pose.y - Math.sin(pose.heading) * half;
    }
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (!a.path || now < a.startAt) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (!b.path || now < b.startAt || (!a.bound && !b.bound)) continue;
        if (!near(lines, i * 4, lines, j * 4, TOUCHING)) continue;
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (this.counted.has(key)) continue;
        this.counted.add(key);
        this.outOfOrder += 1;
      }
    }
  }
}
