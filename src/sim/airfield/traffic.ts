// Ground traffic control: who may be on which piece of ground, and in what order.
//
// The ground is cut into tiles (tiles.ts) and a fuselage holds every tile near it. An aircraft
// moves onto a tile only when it holds it, and no tile has two holders, so two fuselages are
// never close, whatever lines they follow.
//
// Every journey over the ground (runway to stand, stand to runway) has a place in one order of
// all journeys under way, and from its start it wants every tile on its whole way. An aircraft
// takes a tile only when nobody holds it and nobody before it in the order still wants it. So
// nobody ever holds a tile that someone before it in the order wants, and the first in the order
// is never waiting for another aircraft: it runs to its end, then the next is first. A ring of
// aircraft each waiting for the next would need each to be before the next in one order, which
// cannot be.
//
// A journey starts last in the order: the earlier journey has the right of way. An aircraft
// stopped only by that right, at a tile nobody holds, may be put before the one it waits for when
// that one is too far off to be held up by it. Any order that keeps "nobody holds what someone
// before them wants" is as safe as any other, so letting an aircraft past costs time at worst.

import type { TaxiNet } from './net.ts';
import { runSeconds, type Path } from './path.ts';

/** Metres short of a tile it may not enter at which an aircraft stops. */
const STOP_GAP = 1;
/** Seconds an aircraft let past may always cost the one that had the right of way. */
const LET_PAST_COST = 6;
/** It may cost more, up to this share of what waiting would cost the aircraft asking. */
const LET_PAST_SHARE = 0.7;
/** Seconds a departure is taken to stand lined up before it rolls, for reckoning when it leaves that ground. */
const LINED_UP = 60;
/** No aircraft is made to stand longer than this in all, over one journey, by being passed. */
const STOOD_ENOUGH = 480;
/** Seconds with no ground of the other's in hand after which the other could be let past again. */
const LET_PAST_BREAK = 15;
/** Seconds added to the time an aircraft needs to clear a tile, for running late. */
const LET_PAST_PAD = 8;

export interface Mover {
  id: number;
  path: Path | null;
  /** Lead point's distance along the path, and its speed. */
  s: number;
  v: number;
  /** Tiles of the path, in path order, taken so far. */
  entered: number;
  /** Tiles of the path, in the order the tail leaves them, given back so far. */
  left: number;
  /** The path that follows this one on the same journey, whose ground is wanted from the start. */
  next: Path | null;
  /** Place in the order of journeys; -1 with no journey under way. */
  rank: number;
  /** The aircraft does not move before this time. */
  startAt: number;
  /** It will not move on from the end of this path before this time (engine start after a push). */
  pauseUntil: number;
  /** When it last came to a stand wanting to move; -1 while moving. Kept by the aircraft. */
  waitingSince: number;
  /** Seconds it has stood waiting on this journey in all. Kept by the aircraft. */
  stood: number;
  /** Since when it has been asking to start its journey, while held at its stand; -1 otherwise. Kept by the aircraft. */
  askingSince: number;
  /** Its journey ends parked, on ground it then keeps. */
  rests: boolean;
  /** Nobody is let past it: it is about to need all of its ground at once. */
  firm: boolean;
  /** For the instruments: the tile it last could not take, and who was in the way. */
  blockedTile: number;
  blockedBy: number;
  /** When it may next ask to be let past. */
  nextAsk: number;
}

export function newMover(id: number): Mover {
  return { id, path: null, s: 0, v: 0, entered: 0, left: 0, next: null, rank: -1, startAt: 0, pauseUntil: 0, waitingSince: -1, stood: 0, askingSince: -1, rests: false, firm: false, blockedTile: -1, blockedBy: -1, nextAsk: 0 };
}

export class Traffic {
  readonly net: TaxiNet;
  /** Per tile: the aircraft holding it, or -1. */
  private readonly holder: Int32Array;
  /** Per tile: the aircraft that will stand on it for good at the end of its journey, or -1. */
  private readonly restOf: Int32Array;
  /** Per tile: the aircraft with a journey under way that have still to take it. */
  private readonly wanted = new Map<number, number[]>();
  private readonly movers = new Map<number, Mover>();
  /** Journeys under way, the one with the right of way over all others first. */
  private order: Mover[] = [];
  /** True when the last `inTheWay` found a holder, false when it found only an earlier claim. */
  private held = false;
  /** Counted for the soak tests: a tile taken while another aircraft held it. Always 0 if the rules hold. */
  outOfOrder = 0;
  /** Counters for the instruments. */
  stats = { letPast: 0, refusedPast: 0, journeys: 0 };

  constructor(net: TaxiNet) {
    this.net = net;
    this.holder = new Int32Array(net.grid.count).fill(-1);
    this.restOf = new Int32Array(net.grid.count).fill(-1);
  }

  get activeCount(): number {
    return this.order.length;
  }

  holderOf(tile: number): number {
    return this.holder[tile];
  }

  // ---- taking and giving back -----------------------------------------------------------

  private want(mover: Mover, path: Path, fromIndex: number): void {
    for (let i = fromIndex; i < path.tiles.length; i += 1) {
      const tile = path.tiles[i];
      const list = this.wanted.get(tile);
      if (!list) this.wanted.set(tile, [mover.id]);
      else if (!list.includes(mover.id)) list.push(mover.id);
    }
  }

  private unwant(mover: Mover, tile: number): void {
    const list = this.wanted.get(tile);
    if (!list) return;
    const at = list.indexOf(mover.id);
    if (at < 0) return;
    if (list.length === 1) this.wanted.delete(tile);
    else list.splice(at, 1);
  }

  private take(mover: Mover, tile: number): void {
    const before = this.holder[tile];
    if (before !== -1 && before !== mover.id) this.outOfOrder += 1;
    this.holder[tile] = mover.id;
    // Still wanted if the next path comes back over it.
    if (!mover.next?.index.has(tile)) this.unwant(mover, tile);
  }

  /**
   * Put an aircraft on a path with its lead point at the path's origin, holding the ground under
   * it and nothing else. Ground it held that is not under it on the new path is given back.
   */
  private put(mover: Mover, path: Path, now: number): void {
    const old = mover.path;
    if (old) {
      for (let i = 0; i < mover.entered; i += 1) {
        const tile = old.tiles[i];
        if (this.holder[tile] !== mover.id) continue;
        const k = path.index.get(tile);
        if (k === undefined || path.from[k] !== -Infinity) this.holder[tile] = -1;
      }
    }
    mover.path = path;
    mover.s = path.origin;
    mover.v = 0;
    mover.entered = 0;
    mover.left = 0;
    mover.startAt = now;
    mover.blockedTile = -1;
    mover.blockedBy = -1;
    while (mover.entered < path.tiles.length && path.from[mover.entered] === -Infinity) {
      const tile = path.tiles[mover.entered];
      const before = this.holder[tile];
      if (before !== -1 && before !== mover.id) this.outOfOrder += 1;
      this.holder[tile] = mover.id;
      mover.entered += 1;
    }
    this.movers.set(mover.id, mover);
  }

  /** Is the ground under the place a path starts from free for `mover` to stand on? */
  open(mover: Mover, path: Path): boolean {
    for (let i = 0; i < path.tiles.length && path.from[i] === -Infinity; i += 1) {
      const holder = this.holder[path.tiles[i]];
      if (holder !== -1 && holder !== mover.id) return false;
    }
    return true;
  }

  /** The first aircraft other than `mover` holding ground the path covers up to distance `upTo`, or -1. */
  heldAhead(mover: Mover, path: Path, upTo: number): number {
    for (let i = 0; i < path.tiles.length && path.from[i] <= upTo; i += 1) {
      const holder = this.holder[path.tiles[i]];
      if (holder !== -1 && holder !== mover.id) return holder;
    }
    return -1;
  }

  /** Stand an aircraft with no journey at the end of a path: parked. The ground under it is its to rest on. */
  place(mover: Mover, path: Path, now: number): void {
    this.dropJourney(mover);
    this.put(mover, path, now);
    for (let i = 0; i < mover.entered; i += 1) this.restOf[path.tiles[i]] = mover.id;
  }

  /**
   * The first aircraft, other than `mover`, that will rest for good on ground the path passes
   * over up to distance `upTo`, or that holds such ground with no journey of its own; -1 when the
   * way is open.
   */
  restingOn(mover: Mover, path: Path, upTo = Infinity): number {
    for (let i = 0; i < path.tiles.length && path.from[i] <= upTo; i += 1) {
      const rest = this.restOf[path.tiles[i]];
      if (rest !== -1 && rest !== mover.id) return rest;
      const holder = this.holder[path.tiles[i]];
      if (holder !== -1 && holder !== mover.id && this.movers.get(holder)!.rank < 0) return holder;
    }
    return -1;
  }

  /**
   * Start a journey: the aircraft is put on `path` where it stands, last in the order, wanting
   * all of that path and of `next`, the path that follows it. `rests` says the journey ends
   * parked, on ground nobody else may plan to cross from now on.
   */
  begin(mover: Mover, path: Path, next: Path | null, rests: boolean, now: number): boolean {
    this.dropJourney(mover);
    this.clearRest(mover);
    mover.next = next;
    this.put(mover, path, now);
    this.want(mover, path, mover.entered);
    if (next) this.want(mover, next, 0);
    mover.rank = this.order.length;
    this.order.push(mover);
    mover.firm = false;
    mover.rests = rests;
    mover.pauseUntil = 0;
    mover.nextAsk = 0;
    mover.stood = 0;
    mover.waitingSince = -1;
    this.stats.journeys += 1;
    // It stands where it stands: whoever wants that ground comes after it in the order.
    for (let i = 0; i < mover.entered; i += 1) {
      if (this.inTheWay(mover, path.tiles[i]) !== -1 && !this.letPast(mover, path.tiles[i], now, true)) {
        this.dropJourney(mover);
        return false;
      }
    }
    if (rests) {
      const last = next ?? path;
      for (let i = 0; i < last.tiles.length; i += 1) if (last.to[i] === Infinity) this.restOf[last.tiles[i]] = mover.id;
    }
    return true;
  }

  /** Go on to the next path of the journey, from where the aircraft stands. */
  advance(mover: Mover, now: number): void {
    const next = mover.next;
    if (!next) return;
    // What the old path still wanted is not wanted any more; the new path's wants are already in.
    const old = mover.path!;
    for (let i = mover.entered; i < old.tiles.length; i += 1) if (!next.index.has(old.tiles[i])) this.unwant(mover, old.tiles[i]);
    mover.next = null;
    this.put(mover, next, now);
    for (let i = 0; i < mover.entered; i += 1) this.unwant(mover, next.tiles[i]);
  }

  /** The journey is over and the aircraft stays where it is, holding the ground under it. */
  finish(mover: Mover): void {
    this.dropJourney(mover);
  }

  private dropJourney(mover: Mover): void {
    if (mover.rank < 0) return;
    const path = mover.path;
    if (path) for (let i = mover.entered; i < path.tiles.length; i += 1) this.unwant(mover, path.tiles[i]);
    if (mover.next) for (let i = 0; i < mover.next.tiles.length; i += 1) this.unwant(mover, mover.next.tiles[i]);
    mover.next = null;
    this.order.splice(mover.rank, 1);
    for (let i = mover.rank; i < this.order.length; i += 1) this.order[i].rank = i;
    mover.rank = -1;
  }

  private clearRest(mover: Mover): void {
    const path = mover.path;
    if (!path) return;
    for (let i = 0; i < path.tiles.length; i += 1) if (this.restOf[path.tiles[i]] === mover.id) this.restOf[path.tiles[i]] = -1;
  }

  /** Take an aircraft off the ground and drop everything it holds and wants. */
  remove(mover: Mover): void {
    this.dropJourney(mover);
    this.clearRest(mover);
    const path = mover.path;
    if (path) for (let i = 0; i < mover.entered; i += 1) if (this.holder[path.tiles[i]] === mover.id) this.holder[path.tiles[i]] = -1;
    mover.path = null;
    mover.entered = 0;
    mover.left = 0;
    this.movers.delete(mover.id);
  }

  /** Give back the tiles the tail has left. Call after moving; `s` may run past the end of the path. */
  release(mover: Mover): void {
    const path = mover.path;
    if (!path) return;
    const { byTo, to, tiles } = path;
    while (mover.left < byTo.length) {
      const i = byTo[mover.left];
      if (to[i] > mover.s || i >= mover.entered) break;
      if (this.holder[tiles[i]] === mover.id) this.holder[tiles[i]] = -1;
      mover.left += 1;
    }
  }

  // ---- moving ---------------------------------------------------------------------------

  /** The aircraft in the way of `mover` taking a tile, or -1. Sets `held`. */
  private inTheWay(mover: Mover, tile: number): number {
    const holder = this.holder[tile];
    if (holder !== -1 && holder !== mover.id) {
      this.held = true;
      return holder;
    }
    this.held = false;
    const list = this.wanted.get(tile);
    if (!list) return -1;
    let first = -1;
    let firstRank = mover.rank < 0 ? Infinity : mover.rank;
    for (const id of list) {
      if (id === mover.id) continue;
      const rank = this.movers.get(id)!.rank;
      if (rank < firstRank) {
        firstRank = rank;
        first = id;
      }
    }
    return first;
  }

  /**
   * The farthest the lead point may go right now, up to `want`: tiles on the way are taken as far
   * as they can be, and the limit is just short of the first that cannot.
   */
  limit(mover: Mover, want: number, now: number): number {
    const path = mover.path;
    if (!path || now < mover.startAt) return mover.s;
    const { tiles, from } = path;
    const target = Math.min(want, path.total);
    while (mover.entered < tiles.length && from[mover.entered] <= target) {
      const tile = tiles[mover.entered];
      const by = this.inTheWay(mover, tile);
      if (by !== -1) {
        if (!this.held && now >= mover.nextAsk) {
          if (this.letPast(mover, tile, now, false)) continue;
          mover.nextAsk = now + 2;
        }
        mover.blockedTile = tile;
        mover.blockedBy = by;
        return Math.max(mover.s, Math.min(target, from[mover.entered] - STOP_GAP));
      }
      this.take(mover, tile);
      mover.entered += 1;
    }
    mover.blockedTile = -1;
    mover.blockedBy = -1;
    return target;
  }

  /**
   * Take every tile up to distance `upTo` at once, or none of them: for a stretch that must not be
   * started unless it can be finished, like a runway crossing. With `must` the aircraft cannot
   * wait (it is rolling out on a runway) and is put before whoever only has the right of way.
   */
  reserve(mover: Mover, upTo: number, now: number, must: boolean): boolean {
    const path = mover.path;
    if (!path) return false;
    const { tiles, from } = path;
    let last = mover.entered;
    while (last < tiles.length && from[last] <= upTo) last += 1;
    for (let i = mover.entered; i < last; i += 1) {
      const holder = this.holder[tiles[i]];
      if (holder !== -1 && holder !== mover.id) {
        mover.blockedTile = tiles[i];
        mover.blockedBy = holder;
        return false;
      }
    }
    for (let i = mover.entered; i < last; i += 1) {
      const by = this.inTheWay(mover, tiles[i]);
      if (by === -1) continue;
      if (!this.letPast(mover, tiles[i], now, must)) {
        mover.blockedTile = tiles[i];
        mover.blockedBy = by;
        return false;
      }
    }
    for (let i = mover.entered; i < last; i += 1) this.take(mover, tiles[i]);
    mover.entered = last;
    mover.blockedTile = -1;
    mover.blockedBy = -1;
    return true;
  }

  // ---- the order ------------------------------------------------------------------------

  /** Does `mover` still want this tile on its journey: on its path ahead, or on the next path? */
  private wants(mover: Mover, tile: number): boolean {
    const i = mover.path?.index.get(tile);
    if (i !== undefined && i >= mover.entered) return true;
    return mover.next?.index.has(tile) ?? false;
  }

  /** Seconds until `mover` first comes to a tile it wants, running freely. */
  private arrives(mover: Mover, tile: number, now: number): number {
    const path = mover.path!;
    const wait = Math.max(0, mover.startAt - now);
    const i = path.index.get(tile);
    if (i !== undefined && i >= mover.entered) return wait + runSeconds(path, mover.s, path.from[i]);
    const next = mover.next!;
    const k = next.index.get(tile)!;
    return Math.max(wait + runSeconds(path, mover.s, path.total), mover.pauseUntil - now) + runSeconds(next, next.origin, Math.max(next.origin, next.from[k]));
  }

  /**
   * Seconds until `mover` has left a tile it wants for the last time, running freely. Infinity if
   * it comes to rest on it; a departure is taken to leave the end of its way a minute after reaching it.
   */
  private leaves(mover: Mover, tile: number, now: number): number {
    const path = mover.path!;
    const wait = Math.max(0, mover.startAt - now);
    const next = mover.next;
    const k = next?.index.get(tile);
    if (next && k !== undefined) {
      if (next.to[k] === Infinity && mover.rests) return Infinity;
      return Math.max(wait + runSeconds(path, mover.s, path.total), mover.pauseUntil - now) + (next.to[k] === Infinity ? runSeconds(next, next.origin, next.total) + LINED_UP : runSeconds(next, next.origin, next.to[k]));
    }
    const i = path.index.get(tile);
    if (i === undefined) return Infinity;
    if (path.to[i] === Infinity) return mover.rests ? Infinity : wait + runSeconds(path, mover.s, path.total) + LINED_UP;
    return wait + runSeconds(path, mover.s, path.to[i]);
  }

  /**
   * Try to put `mover` before every aircraft that only has the right of way over it at `tile`.
   * Allowed when none of them would be held up by more than a few seconds (always, with `must`),
   * and when the order can be changed without anyone holding ground that someone before them wants.
   */
  private letPast(mover: Mover, tile: number, now: number, must: boolean): boolean {
    if (mover.rank < 0) return false;
    const list = this.wanted.get(tile);
    if (!list) return true;
    const ahead: Mover[] = [];
    for (const id of list) {
      if (id === mover.id) continue;
      const other = this.movers.get(id)!;
      if (other.rank < mover.rank) ahead.push(other);
    }
    if (!ahead.length) return true;
    if (!must) {
      // How long the asker has already been kept: standing on a taxiway, or ready at its stand.
      const kept = mover.askingSince >= 0 ? now - mover.askingSince : mover.waitingSince >= 0 ? now - mover.waitingSince : 0;
      for (const other of ahead) {
        const cost = other.firm ? Infinity : this.costOfPassing(mover, other, now);
        if (cost <= LET_PAST_COST) continue;
        // More than a moment: only when the other has not stood long already, and either waiting
        // would cost the asker more still or the asker has itself been kept as long.
        const standing = other.stood + (other.waitingSince >= 0 ? now - other.waitingSince : 0);
        if (standing + cost > STOOD_ENOUGH || cost > Math.max(kept, LET_PAST_SHARE * this.leaves(other, tile, now))) {
          this.stats.refusedPast += 1;
          return false;
        }
      }
    }
    // Everyone to be passed moves to just behind `mover`, and with each of them everyone between
    // who wants ground one of them holds, since those must stay behind the holder.
    ahead.sort((p, q) => p.rank - q.rank);
    const moving = new Set<Mover>(ahead);
    for (let r = ahead[0].rank; r <= mover.rank; r += 1) {
      const candidate = this.order[r];
      if (moving.has(candidate)) continue;
      let behindOne = false;
      for (const m of moving) {
        if (m.rank < r && this.holdsWantedBy(m, candidate)) {
          behindOne = true;
          break;
        }
      }
      if (!behindOne) continue;
      // The aircraft asking would itself have to stay behind one it wants to pass.
      if (candidate === mover) {
        this.stats.refusedPast += 1;
        return false;
      }
      moving.add(candidate);
    }
    const kept: Mover[] = [];
    const moved: Mover[] = [];
    for (let r = ahead[0].rank; r <= mover.rank; r += 1) (moving.has(this.order[r]) ? moved : kept).push(this.order[r]);
    this.order.splice(ahead[0].rank, kept.length + moved.length, ...kept, ...moved);
    for (let r = ahead[0].rank; r < this.order.length; r += 1) this.order[r].rank = r;
    this.stats.letPast += 1;
    return true;
  }

  /** Does `holder` hold a tile that `other` still wants? */
  private holdsWantedBy(holder: Mover, other: Mover): boolean {
    const path = holder.path!;
    for (let k = holder.left; k < path.byTo.length; k += 1) {
      const i = path.byTo[k];
      if (i >= holder.entered) continue;
      const tile = path.tiles[i];
      if (this.holder[tile] === holder.id && this.wants(other, tile)) return true;
    }
    return false;
  }

  /**
   * Seconds `other` would be held up if `mover` went before it now. Only the ground `mover` takes
   * from now on without a break counts: once it holds nothing `other` wants, `other` can be put
   * before it again. Infinity if `mover` comes to rest on ground `other` wants.
   */
  private costOfPassing(mover: Mover, other: Mover, now: number): number {
    if (mover.rests) {
      const last = mover.next ?? mover.path!;
      for (let k = last.byTo.length - 1; k >= 0; k -= 1) {
        const i = last.byTo[k];
        if (last.to[i] !== Infinity) break;
        if (this.wants(other, last.tiles[i])) return Infinity;
      }
    }
    let cost = 0;
    // Seconds from now until `mover` has left the ground of `other`'s that it holds without a break.
    let until = 0;
    const walk = (path: Path, fromIndex: number, base: number, startS: number): boolean => {
      for (let i = fromIndex; i < path.tiles.length; i += 1) {
        const tile = path.tiles[i];
        if (!this.wants(other, tile)) continue;
        const takes = base + runSeconds(path, startS, Math.max(startS, path.from[i]));
        if (takes > until + LET_PAST_BREAK) return false;
        const leaves = this.leaves(mover, tile, now);
        if (leaves > until) until = leaves;
        const late = leaves + LET_PAST_PAD - this.arrives(other, tile, now);
        if (late > cost) cost = late;
      }
      return true;
    };
    const path = mover.path!;
    const wait = Math.max(0, mover.startAt - now);
    if (walk(path, mover.entered, wait, mover.s) && mover.next) {
      walk(mover.next, 0, Math.max(wait + runSeconds(path, mover.s, path.total), mover.pauseUntil - now), mover.next.origin);
    }
    return cost;
  }

  // ---- instruments ----------------------------------------------------------------------

  /** For the instruments: the tile the mover last could not take, and who was in the way. */
  waitingOn(mover: Mover): { res: number; by: number } | null {
    return mover.blockedBy >= 0 ? { res: mover.blockedTile, by: mover.blockedBy } : null;
  }

  /** For the instruments: the tiles the mover holds. */
  under(mover: Mover): number[] {
    const path = mover.path;
    if (!path) return [];
    const out: number[] = [];
    for (let i = 0; i < mover.entered; i += 1) if (this.holder[path.tiles[i]] === mover.id) out.push(path.tiles[i]);
    return out;
  }

  /** For the instruments: does anyone hold a tile that someone before them in the order wants? Always false if the rules hold. */
  orderBroken(): boolean {
    for (const m of this.order) {
      for (let r = 0; r < m.rank; r += 1) if (this.holdsWantedBy(m, this.order[r])) return true;
    }
    return false;
  }
}
