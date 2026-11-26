// Ground traffic control: who may be on which piece of taxiway, and in what order.
//
// Every block and node has a queue of the aircraft cleared to use it, in the order they will. An
// aircraft may move onto a resource only when it is first in that resource's queue. A new
// clearance is added to the queues at the places a conflict-free timetable puts it: nominal
// timings for the new aircraft, estimates for everyone already cleared. Orders taken from one
// consistent timetable cannot form a cycle, so however late anyone runs, nobody waits in a ring:
// delays stretch the timetable, they do not knot it.

import type { TaxiNet } from './net.ts';
import { pointAt, retime, timeAt, type Path, type PathPoint } from './path.ts';

/** Seconds kept between one aircraft leaving a resource and the next arriving, in the plan. */
const BUFFER = 4;
/** Metres short of an uncleared resource at which an aircraft stops. */
const STOP_GAP = 5;

export interface Mover {
  id: number;
  path: Path | null;
  /** Lead point's distance along the path, and its speed. */
  s: number;
  v: number;
  /** Where the current clearance ends. */
  end: number;
  /** Spans (in path order) that are in the queues, and that may be entered now. */
  claimed: number;
  granted: number;
  /** Per span: 1 once the tail has cleared it and the claim is gone. */
  released: Uint8Array;
  /** Estimated arrival at and departure from each span, simulation seconds. */
  enter: Float64Array;
  exit: Float64Array;
  /** The aircraft does not move before this time. */
  startAt: number;
  /** Span index of each resource on the path. */
  index: Map<number, number>;
  /** Its next move is back the way its path came: parked nose-in, or pushed back and about to taxi. */
  turnsBack: boolean;
}

export interface ClearResult {
  ok: boolean;
  /** Seconds the plan has the aircraft wait before moving. */
  delay: number;
  /** When blocked: the distance along the path where the blocking resource starts. */
  blockedAt: number;
  /** When blocked: the aircraft in the way, and whether it will move without outside help. */
  blocker: number;
  blockerHolding: boolean;
}

export function newMover(id: number): Mover {
  return { id, path: null, s: 0, v: 0, end: 0, claimed: 0, granted: 0, released: new Uint8Array(0), enter: new Float64Array(0), exit: new Float64Array(0), startAt: 0, index: new Map(), turnsBack: false };
}

export class Traffic {
  private readonly queues: number[][];
  private readonly movers = new Map<number, Mover>();
  private estimatedAt = -1;
  private readonly scratchA: PathPoint = { x: 0, y: 0, heading: 0 };
  private readonly scratchB: PathPoint = { x: 0, y: 0, heading: 0 };
  /** Counted for the soak tests: a claim released out of turn means the order was broken. */
  outOfOrder = 0;
  readonly net: TaxiNet;

  constructor(net: TaxiNet) {
    this.net = net;
    this.queues = Array.from({ length: net.blocks.length + net.nodes.length }, () => []);
  }

  get activeCount(): number {
    return this.movers.size;
  }

  holder(res: number): number {
    const q = this.queues[res];
    return q.length ? q[0] : -1;
  }

  queueOf(res: number): readonly number[] {
    return this.queues[res];
  }

  /** Put an aircraft on a path where it stands, holding the ground its body covers. */
  place(mover: Mover, path: Path, s: number, now: number): void {
    this.remove(mover);
    mover.path = path;
    mover.s = s;
    mover.v = 0;
    mover.end = s;
    mover.claimed = 0;
    mover.granted = 0;
    mover.released = new Uint8Array(path.spans.length);
    mover.enter = new Float64Array(path.spans.length).fill(now);
    mover.exit = new Float64Array(path.spans.length).fill(Infinity);
    mover.startAt = now;
    mover.index = new Map();
    for (let i = 0; i < path.spans.length; i += 1) mover.index.set(path.spans[i].res, i);
    this.movers.set(mover.id, mover);
    retime(path, s, 0, s);
    // What it already stands on comes first in every queue: it is there.
    for (let i = 0; i < path.spans.length; i += 1) {
      const span = path.spans[i];
      if (span.from > s) break;
      if (span.to <= s) {
        mover.released[i] = 1;
      } else {
        const q = this.queues[span.res];
        const at = q.indexOf(mover.id);
        if (at > 0) q.splice(at, 1);
        if (at !== 0) q.unshift(mover.id);
      }
      mover.claimed = i + 1;
      mover.granted = i + 1;
    }
    this.estimatedAt = -1;
  }

  /**
   * Replace an aircraft's path with one that starts on the ground it holds, keeping its claims.
   * `s` is the lead point's distance along the new path.
   */
  replace(mover: Mover, path: Path, s: number, now: number): void {
    const held = new Set<number>();
    if (mover.path) {
      for (let i = 0; i < mover.claimed; i += 1) if (!mover.released[i]) held.add(mover.path.spans[i].res);
    }
    const keeps = new Set<number>();
    for (const span of path.spans) if (span.from <= s && span.to > s) keeps.add(span.res);
    for (const res of held) {
      if (keeps.has(res)) continue;
      const q = this.queues[res];
      const at = q.indexOf(mover.id);
      if (at >= 0) q.splice(at, 1);
    }
    mover.path = null;
    this.movers.delete(mover.id);
    this.place(mover, path, s, now);
  }

  /** Take an aircraft off the network and drop every claim it has. */
  remove(mover: Mover): void {
    if (mover.path) {
      for (let i = 0; i < mover.claimed; i += 1) {
        if (mover.released[i]) continue;
        const q = this.queues[mover.path.spans[i].res];
        const at = q.indexOf(mover.id);
        if (at >= 0) q.splice(at, 1);
      }
    }
    mover.path = null;
    mover.claimed = 0;
    mover.granted = 0;
    this.movers.delete(mover.id);
    this.estimatedAt = -1;
  }

  /**
   * Ask to move the clearance limit to `end`. On success the aircraft is queued for every
   * resource on the way. With `holdAtOrigin` it waits where it is until the way is clear in the
   * plan; otherwise it sets off and waits wherever its turn comes.
   */
  clear(mover: Mover, end: number, now: number, maxDelay: number, holdAtOrigin: boolean): ClearResult {
    const path = mover.path;
    if (!path) return { ok: false, delay: 0, blockedAt: 0, blocker: -1, blockerHolding: false };
    const target = Math.min(end, path.total);
    if (target <= mover.end + 0.01) return { ok: true, delay: 0, blockedAt: 0, blocker: -1, blockerHolding: false };
    this.estimate(now);
    const startDelay = Math.max(0, mover.startAt - now);
    const spans = path.spans;
    let last = mover.claimed;
    while (last < spans.length && spans[last].from <= target) last += 1;

    const fromSpeed = mover.v;
    retime(path, mover.s, fromSpeed, target);
    let failure: ClearResult | null = null;
    for (let delay = 0; delay <= maxDelay; delay += 5) {
      failure = null;
      const base = now + startDelay + delay;
      for (let i = mover.claimed; i < last; i += 1) {
        const span = spans[i];
        const arrive = base + timeAt(path, span.from);
        const leave = span.to > target ? Infinity : base + timeAt(path, span.to);
        for (const otherId of this.queues[span.res]) {
          if (otherId === mover.id) continue;
          const other = this.movers.get(otherId)!;
          const k = this.spanIndex(other, span.res);
          const otherEnter = other.enter[k];
          const otherExit = other.exit[k];
          const before = otherExit + BUFFER <= arrive;
          const after = otherEnter >= leave + BUFFER;
          if (!before && !after) {
            failure = { ok: false, delay, blockedAt: span.from, blocker: otherId, blockerHolding: otherExit === Infinity };
            break;
          }
        }
        if (failure) break;
      }
      if (!failure) {
        this.insert(mover, path, last, target, base);
        mover.end = target;
        if (holdAtOrigin && delay > 0) mover.startAt = now + startDelay + delay;
        this.estimatedAt = -1;
        return { ok: true, delay, blockedAt: 0, blocker: -1, blockerHolding: false };
      }
      // Someone standing in the way with no clearance to leave will not move for a delay.
      if (failure.blockerHolding) break;
    }
    retime(path, mover.s, fromSpeed, mover.end);
    return failure ?? { ok: false, delay: 0, blockedAt: 0, blocker: -1, blockerHolding: false };
  }

  /**
   * Clear as far towards `end` as the traffic allows: the full distance if it can, otherwise up
   * to just short of whatever is standing in the way. Returns the new limit, or the old one.
   */
  clearAsFarAs(mover: Mover, end: number, now: number, maxDelay: number, holdAtOrigin: boolean, minAdvance = 25): { end: number; result: ClearResult } {
    let target = end;
    let result = this.clear(mover, target, now, maxDelay, holdAtOrigin);
    for (let attempt = 0; attempt < 4 && !result.ok && result.blockerHolding; attempt += 1) {
      // Queue up behind someone going the same way, but never close in on someone who will have
      // to come out past us: nose to nose on a taxiway, neither can move again.
      if (this.oncoming(mover, result.blockedAt, result.blocker)) break;
      target = result.blockedAt - STOP_GAP - 3;
      if (target < Math.max(mover.end, mover.s) + minAdvance) break;
      result = this.clear(mover, target, now, maxDelay, holdAtOrigin);
    }
    return { end: mover.end, result };
  }

  /** Will the aircraft standing in the way at `at` on the mover's path next move towards the mover? */
  private oncoming(mover: Mover, at: number, blockerId: number): boolean {
    const other = this.movers.get(blockerId);
    if (!other?.path || !mover.path) return false;
    const mine = pointAt(mover.path, at, this.scratchA).heading;
    const theirs = pointAt(other.path, other.s, this.scratchB).heading + (other.turnsBack ? Math.PI : 0);
    return Math.cos(mine - theirs) < -0.3;
  }

  /** The farthest the lead point may go right now. */
  limit(mover: Mover, now: number): number {
    const path = mover.path;
    if (!path || now < mover.startAt) return mover.s;
    const spans = path.spans;
    while (mover.granted < mover.claimed && this.queues[spans[mover.granted].res][0] === mover.id) mover.granted += 1;
    if (mover.granted < mover.claimed) return Math.min(mover.end, spans[mover.granted].from - STOP_GAP);
    return mover.end;
  }

  /** For the instruments: the first resource ahead the mover is queued for but not first at, and who is. */
  waitingOn(mover: Mover): { res: number; by: number } | null {
    const path = mover.path;
    if (!path || mover.granted >= mover.claimed) return null;
    const res = path.spans[mover.granted].res;
    return { res, by: this.queues[res][0] };
  }

  /** For the instruments: the resources the mover's body is on now. */
  under(mover: Mover): number[] {
    const path = mover.path;
    if (!path) return [];
    const out: number[] = [];
    for (let i = 0; i < mover.claimed; i += 1) {
      const span = path.spans[i];
      if (span.from > mover.s) break;
      if (!mover.released[i] && span.to > mover.s) out.push(span.res);
    }
    return out;
  }

  /** Give up the resources the tail has cleared. Call after moving. */
  release(mover: Mover): void {
    const path = mover.path;
    if (!path) return;
    const spans = path.spans;
    for (let i = 0; i < mover.granted; i += 1) {
      if (mover.released[i] || spans[i].to > mover.s) continue;
      mover.released[i] = 1;
      const q = this.queues[spans[i].res];
      if (q[0] === mover.id) q.shift();
      else {
        const at = q.indexOf(mover.id);
        if (at >= 0) {
          q.splice(at, 1);
          this.outOfOrder += 1;
        }
      }
    }
  }

  /** Aircraft that hold, or are queued for, any of the resources a path covers between two distances. */
  occupants(path: Path, from: number, to: number, except: number): number[] {
    const found = new Set<number>();
    for (const span of path.spans) {
      if (span.to < from || span.from > to) continue;
      for (const id of this.queues[span.res]) if (id !== except) found.add(id);
    }
    return [...found];
  }

  private spanIndex(mover: Mover, res: number): number {
    return mover.index.get(res) ?? 0;
  }

  /** Queue the mover for spans [claimed, last), each at the place its planned time gives it. */
  private insert(mover: Mover, path: Path, last: number, target: number, base: number): void {
    const spans = path.spans;
    for (let i = mover.claimed; i < last; i += 1) {
      const span = spans[i];
      const arrive = base + timeAt(path, span.from);
      const leave = span.to > target ? Infinity : base + timeAt(path, span.to);
      mover.enter[i] = arrive;
      mover.exit[i] = leave;
      const q = this.queues[span.res];
      let at = q.length;
      for (let k = 0; k < q.length; k += 1) {
        const other = this.movers.get(q[k])!;
        if (other.enter[this.spanIndex(other, span.res)] >= leave) {
          at = k;
          break;
        }
      }
      q.splice(at, 0, mover.id);
    }
    mover.claimed = last;
    // Spans cleared earlier that ran past the old limit now have an end to them.
    for (let i = 0; i < last; i += 1) {
      if (!mover.released[i] && mover.exit[i] === Infinity && spans[i].to <= target) mover.exit[i] = base + timeAt(path, spans[i].to);
    }
  }

  /**
   * Bring every aircraft's estimated times up to date: nominal running from where it is now,
   * waiting wherever the queues make it wait. Repeated until the estimates stop moving.
   */
  private estimate(now: number): void {
    if (this.estimatedAt === now) return;
    this.estimatedAt = now;
    const list = [...this.movers.values()];
    for (const m of list) retime(m.path!, m.s, m.v, m.end);
    for (let pass = 0; pass < 8; pass += 1) {
      let moved = 0;
      for (const m of list) {
        const path = m.path!;
        const spans = path.spans;
        const base = Math.max(now, m.startAt);
        let delay = 0;
        // Delay picked up at each gate, by the distance at which it applies.
        const gateAt: number[] = [];
        const gateDelay: number[] = [];
        for (let i = 0; i < m.claimed; i += 1) {
          if (m.released[i]) continue;
          const span = spans[i];
          let enter = span.from <= m.s ? Math.min(m.enter[i], now) : base + timeAt(path, span.from) + delay;
          if (span.from > m.s && i >= m.granted) {
            let gate = 0;
            for (const otherId of this.queues[span.res]) {
              if (otherId === m.id) break;
              const other = this.movers.get(otherId)!;
              gate = Math.max(gate, other.exit[this.spanIndex(other, span.res)] + BUFFER);
            }
            if (gate > enter && gate !== Infinity) {
              delay += gate - enter;
              enter = gate;
              gateAt.push(span.from);
              gateDelay.push(delay);
            } else if (gate === Infinity) {
              enter = Infinity;
            }
          }
          if (Math.abs(enter - m.enter[i]) > 0.5 && !(enter === Infinity && m.enter[i] === Infinity)) moved += 1;
          m.enter[i] = enter;
        }
        for (let i = 0; i < m.claimed; i += 1) {
          if (m.released[i]) continue;
          const span = spans[i];
          let exit = Infinity;
          if (span.to <= m.end && m.enter[i] !== Infinity) {
            let d = 0;
            for (let g = 0; g < gateAt.length; g += 1) if (gateAt[g] <= span.to) d = gateDelay[g];
            exit = base + timeAt(path, span.to) + d;
            // Blocked for good somewhere before the tail clears this span: no end in sight.
            for (let k = i; k < m.claimed; k += 1) {
              if (spans[k].from > span.to) break;
              if (m.enter[k] === Infinity) exit = Infinity;
            }
          }
          m.exit[i] = exit;
        }
      }
      if (!moved) break;
    }
  }
}
