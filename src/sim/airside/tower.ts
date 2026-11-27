// The tower: which runways are in use, when each arrival lands, and who may line up, take off or
// cross. Runways that cross each other are shared ground: a movement holds a window of time at
// each crossing point, and nothing else is cleared into that window.

import type { TaxiNet } from '../airfield/net.ts';
import { CONFIG } from '../config.ts';
import { AIRCRAFT, type BodyClass, type WakeClass } from '../fleet.ts';

export interface RunwayPlan {
  name: 'West' | 'Southeast';
  /** Runway ends used for landing, for ordinary departures and for departures needing length. */
  arrivals: string[];
  departures: string[];
  longDepartures: string[];
}

// A departure cleared onto a runway that takes no landings may be held a little
// (CONFIG.runway.crossHoldsDeparture) by traffic crossing in front of it. Without such a turn, a
// runway with a queue of departures is never crossed: the next lines up before the last is past
// the crossing.
const {
  crossHoldsDeparture: CROSS_HOLDS_DEPARTURE,
  crossLiningUp: CROSS_LINING_UP,
  firstCome: FIRST_COME,
  askLapses: ASK_LAPSES,
  oppositeClear: OPPOSITE_CLEAR,
  departedAlongForLanding: DEPARTED_ALONG_FOR_LANDING,
  departedSpeedForLanding: DEPARTED_SPEED_FOR_LANDING,
  departedAlongForTakeoff: DEPARTED_ALONG_FOR_TAKEOFF,
  lineUpBehind: LINE_UP_BEHIND,
  rollMargin: ROLL_MARGIN,
  lineUpMargin: LINE_UP_MARGIN,
  crossingPassed: CROSSING_PASSED,
  rollShare: ROLL_SHARE,
  lineUpLength: LINE_UP_LENGTH,
} = CONFIG.runway;

export const WEST_PLAN: RunwayPlan ={ name: 'West', arrivals: ['28L', '28R'], departures: ['01L', '01R'], longDepartures: ['28L', '28R'] };
export const SOUTHEAST_PLAN: RunwayPlan = { name: 'Southeast', arrivals: ['19L', '19R'], departures: ['10L', '10R'], longDepartures: ['10L', '10R'] };

/** Where two runways cross, as distances from each runway end's pavement edge. */
interface Crossing {
  runwayA: string;
  runwayB: string;
  x: number;
  y: number;
}

interface Window {
  /** Physical runway whose crossing points this covers, and the other runway at the crossing. */
  on: string;
  across: string;
  from: number;
  to: number;
  aircraft: number;
}

interface Inbound {
  aircraft: number;
  end: string;
  /** Time over the landing threshold. */
  threshold: number;
  wake: WakeClass;
}

/**
 * A landing slot given out, or one left empty, on a runway end: the stretch of time it holds,
 * from `at` for `length` seconds, the beat it was given out in.
 */
interface Held {
  at: number;
  length: number;
}

/** Does any of `list` hold time between `from` and `to`? Stretches that only meet do not. */
function overlaps(list: readonly Held[] | undefined, from: number, to: number): boolean {
  if (!list) return false;
  for (const h of list) if (h.at < to - 0.5 && from < h.at + h.length - 0.5) return true;
  return false;
}

interface RunwayState {
  id: string;
  /** Aircraft on the pavement, with where they are heading along it. */
  occupants: Map<number, { end: string; kind: 'landing' | 'departing' | 'crossing' | 'linedUp' }>;
  inbound: Inbound[];
  lastDeparture: { time: number; wake: WakeClass; end: string } | null;
  /** Aircraft told to line up or cleared to go, not yet airborne. */
  cleared: number | null;
  /**
   * Departures holding short asking to line up: since when, when they last asked, and when they
   * last could not take a clearance they were given.
   */
  asking: Map<number, { since: number; last: number; failed: number }>;
}

/** What the tower needs to know about an aircraft on a runway. */
export interface RunwayPosition {
  /** Distance from the pavement edge of the end it is using, and speed along the runway. */
  along: number;
  speed: number;
}

export class Tower {
  /** The runway plan in use; change it with `setPlan`. */
  plan: RunwayPlan = WEST_PLAN;
  /** Side-by-side approaches are possible; change it with `setPaired`. */
  visual = true;
  /** Physical runways closed to new movements: what is already cleared onto one goes on. */
  readonly closed = new Set<string>();
  /** No landing slot is given out before this time: the runways are being changed over. */
  notBefore = 0;
  readonly runways = new Map<string, RunwayState>();
  private readonly crossings: Crossing[] = [];
  private windows: Window[] = [];
  /**
   * Landing slots given out, and slots to be left empty, by runway end. Each keeps the stretch of
   * time it was given in its own beat, so that after a change of beat (paired approaches or not)
   * a new slot neither reads an old one as one at another time nor lands inside part of it: the
   * empty slots behind a super-heavy keep the next arrival back whatever the beat.
   */
  private readonly slots = new Map<string, Held[]>();
  private readonly holes = new Map<string, Held[]>();
  /** The latest landing slot given out, and the latest on each runway end. */
  private lastSlot = 0;
  private readonly lastSlotOn = new Map<string, number>();
  /**
   * Whether departures are still on their way to a runway end: no landing slot is given on its
   * other end until they have gone, so that a change of plan cannot leave them facing the
   * arrivals for good. Set by whoever runs the departures.
   */
  departuresWaiting: (end: string) => boolean = () => false;
  private readonly net: TaxiNet;
  private readonly position: (aircraft: number) => RunwayPosition | null;
  /** Counters for the operations panel and the tests. */
  stats = { landings: 0, takeoffs: 0, goArounds: 0, crossings: 0 };
  /** How many go-arounds each kind of obstruction has caused. */
  goAroundReasons: Record<string, number> = {};
  /** For the instruments: why the last request was refused, and the aircraft in the way if there was one. */
  denial = '';
  deniedBy = -1;

  private deny(reason: string, by = -1): false {
    this.denial = reason;
    this.deniedBy = by;
    return false;
  }

  constructor(net: TaxiNet, position: (aircraft: number) => RunwayPosition | null) {
    this.net = net;
    this.position = position;
    const seen = new Set<string>();
    for (const info of net.runwayEnds.values()) {
      const id = info.runway.id;
      if (seen.has(id)) continue;
      seen.add(id);
      this.runways.set(id, { id, occupants: new Map(), inbound: [], lastDeparture: null, cleared: null, asking: new Map() });
    }
    const list = [...seen].map((id) => [...net.runwayEnds.values()].find((e) => e.runway.id === id)!);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const denom = a.ux * b.uy - a.uy * b.ux;
        if (Math.abs(denom) < 0.2) continue;
        const dx = b.end.x - a.end.x;
        const dy = b.end.y - a.end.y;
        const t = (dx * b.uy - dy * b.ux) / denom;
        const u = (dx * a.uy - dy * a.ux) / denom;
        if (t < -50 || t > a.runway.length + 50 || u < -50 || u > b.runway.length + 50) continue;
        this.crossings.push({ runwayA: a.runway.id, runwayB: b.runway.id, x: a.end.x + a.ux * t, y: a.end.y + a.uy * t });
      }
    }
  }

  runwayOf(end: string): RunwayState {
    return this.runways.get(this.net.runwayEnds.get(end)!.runway.id)!;
  }

  /** Distance from the pavement edge of `end` to each point where another runway crosses. */
  crossingsAlong(end: string): { across: string; along: number }[] {
    const info = this.net.runwayEnds.get(end)!;
    const out: { across: string; along: number }[] = [];
    for (const c of this.crossings) {
      if (c.runwayA !== info.runway.id && c.runwayB !== info.runway.id) continue;
      const along = (c.x - info.end.x) * info.ux + (c.y - info.end.y) * info.uy;
      out.push({ across: c.runwayA === info.runway.id ? c.runwayB : c.runwayA, along });
    }
    return out.sort((p, q) => p.along - q.along);
  }

  // ---- arrivals -------------------------------------------------------------------------

  get slotLength(): number {
    return this.visual ? CONFIG.runway.slotVisual : CONFIG.runway.slotInstrument;
  }

  private open(end: string): boolean {
    return !this.closed.has(this.net.runwayEnds.get(end)!.runway.id);
  }

  /** Runway ends landing aircraft now: the plan's open arrival runways, one of them when approaches cannot be paired. */
  get arrivalEnds(): string[] {
    const open = this.plan.arrivals.filter((end) => this.open(end));
    return this.visual ? open : open.slice(-1);
  }

  /** The other end of the same runway. */
  otherEnd(end: string): string {
    return this.net.runwayEnds.get(end)!.other.name;
  }

  /**
   * Is an arrival coming to the other end of `end`'s runway: on its approach, or holding a landing
   * slot not yet a minute past? A departure from `end` would climb out head-on towards it.
   */
  private landingTowards(end: string, now: number): number | null {
    const other = this.otherEnd(end);
    const coming = this.runwayOf(end).inbound.find((i) => i.end === other);
    if (coming) return coming.aircraft;
    return (this.lastSlotOn.get(other) ?? -Infinity) > now - OPPOSITE_CLEAR ? -1 : null;
  }

  /** The end of the same runway as `end` that takes landings under the plan, if any: a departure from it needs a gap in them. */
  arrivalEndOn(end: string): string | null {
    const id = this.net.runwayEnds.get(end)!.runway.id;
    return this.arrivalEnds.find((e) => this.net.runwayEnds.get(e)!.runway.id === id) ?? null;
  }

  /**
   * Change the runway plan. Arrivals already on their approach land where they were going and
   * departures already on their way take off where they were going; no new landing is given a
   * slot for `changeover` seconds, so that the old runways can be cleared.
   */
  setPlan(plan: RunwayPlan, now: number, changeover: number): boolean {
    if (plan === this.plan) return false;
    this.plan = plan;
    this.notBefore = Math.max(this.notBefore, now + changeover);
    return true;
  }

  /**
   * Pair approaches or not. New slots keep to the new beat and start after every slot already
   * given out, and none is given inside the time an old one holds, a super-heavy's empty slots
   * behind it included.
   */
  setPaired(paired: boolean): boolean {
    if (paired === this.visual) return false;
    this.notBefore = Math.max(this.notBefore, this.lastSlot + this.slotLength);
    this.visual = paired;
    return true;
  }

  /** Give back a landing slot an arrival not yet on its approach no longer needs. */
  releaseSlot(end: string, threshold: number): void {
    const list = this.slots.get(end);
    const at = list ? list.findIndex((h) => Math.abs(h.at - threshold) < 0.5) : -1;
    if (at >= 0) list!.splice(at, 1);
  }

  /**
   * Give an arrival the first free landing slot at or after `earliest`. Slots are a fixed beat;
   * in visual conditions each takes one aircraft per arrival runway, landing side by side. Null
   * when no slot is free by `latest`, or no arrival runway is open: the arrival waits for one.
   */
  assignSlot(earliest: number, wake: WakeClass, prefer: string | null, latest = Infinity): { end: string; threshold: number } | null {
    const length = this.slotLength;
    const ends = this.arrivalEnds;
    // With every arrival runway closed nothing lands: the arrival waits for one to open.
    if (!ends.length) return null;
    const order = prefer && ends.includes(prefer) ? [prefer, ...ends.filter((e) => e !== prefer)] : ends;
    // Not an end whose other end still has departures on their way to it: they would face the landings.
    const usable = order.filter((end) => !this.departuresWaiting(this.otherEnd(end)));
    if (!usable.length) return null;
    for (let k = Math.ceil(Math.max(earliest, this.notBefore) / length); ; k += 1) {
      const at = k * length;
      if (at > latest) return null;
      for (const end of usable) {
        // Free of every slot given out and every gap kept, in whatever beat they were.
        if (this.slotTaken(end, at) || this.isHole(end, at)) continue;
        // A super-heavy needs the slots behind it empty, and one of them may already be given out.
        if (wake === 'J' && overlaps(this.slots.get(end), at + length, at + (1 + CONFIG.runway.slotsBehindSuper) * length)) continue;
        this.held(this.slots, end).push({ at, length });
        if (wake === 'J') for (let n = 1; n <= CONFIG.runway.slotsBehindSuper; n += 1) this.addHole(end, at + n * length);
        this.lastSlot = Math.max(this.lastSlot, at);
        this.lastSlotOn.set(end, Math.max(this.lastSlotOn.get(end) ?? -Infinity, at));
        return { end, threshold: at };
      }
    }
  }

  private held(map: Map<string, Held[]>, end: string): Held[] {
    let list = map.get(end);
    if (!list) map.set(end, (list = []));
    return list;
  }

  /** Is any of the landing slot at time `at` on `end`, in the beat now in use, given to an arrival? */
  slotTaken(end: string, at: number): boolean {
    return overlaps(this.slots.get(end), at, at + this.slotLength);
  }

  /** Is any of the landing slot at time `at` on `end`, in the beat now in use, to be left empty? */
  isHole(end: string, at: number): boolean {
    return overlaps(this.holes.get(end), at, at + this.slotLength);
  }

  /** Leave the landing slot at time `at` on `end` empty; it must not be given to an arrival. */
  addHole(end: string, at: number): void {
    this.held(this.holes, end).push({ at, length: this.slotLength });
  }

  /** An arrival is established on final. Its threshold time is kept up to date with `updateInbound`. */
  addInbound(aircraft: number, end: string, threshold: number, wake: WakeClass): void {
    const runway = this.runwayOf(end);
    runway.inbound.push({ aircraft, end, threshold, wake });
    runway.inbound.sort((a, b) => a.threshold - b.threshold);
  }

  updateInbound(aircraft: number, end: string, threshold: number, rollToCrossings: { across: string; seconds: number }[]): void {
    const runway = this.runwayOf(end);
    const entry = runway.inbound.find((i) => i.aircraft === aircraft);
    if (entry) entry.threshold = threshold;
    // The landing owns each crossing point from over the threshold until it has rolled through.
    this.windows = this.windows.filter((w) => !(w.aircraft === aircraft && w.on === runway.id));
    const margin = CONFIG.runway.crossingMargin;
    for (const c of rollToCrossings) this.windows.push({ on: runway.id, across: c.across, from: threshold - margin, to: threshold + c.seconds + margin, aircraft });
  }

  /** At decision height: is the runway the arrival's alone? */
  mayLand(aircraft: number, end: string): boolean {
    const reason = this.landingBlockedBy(aircraft, end);
    if (reason) this.goAroundReasons[reason] = (this.goAroundReasons[reason] ?? 0) + 1;
    return reason === null;
  }

  /** What is in the way of a landing, in a word, or null when the runway is clear. */
  private landingBlockedBy(aircraft: number, end: string): string | null {
    const runway = this.runwayOf(end);
    if (runway.cleared !== null) return 'departure lining up';
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      // A departure already well down the runway will be gone before the wheels touch.
      const p = this.position(id);
      if (occupant.kind === 'departing' && occupant.end === end && p && p.along > DEPARTED_ALONG_FOR_LANDING && p.speed > DEPARTED_SPEED_FOR_LANDING) continue;
      return occupant.kind === 'landing' ? 'landing not yet clear' : occupant.kind === 'crossing' ? 'aircraft crossing' : occupant.kind === 'departing' ? 'departure rolling' : 'departure lined up';
    }
    return null;
  }

  touchedDown(aircraft: number, end: string): void {
    const runway = this.runwayOf(end);
    runway.inbound = runway.inbound.filter((i) => i.aircraft !== aircraft);
    runway.occupants.set(aircraft, { end, kind: 'landing' });
    this.stats.landings += 1;
  }

  wentAround(aircraft: number, end: string): void {
    const runway = this.runwayOf(end);
    runway.inbound = runway.inbound.filter((i) => i.aircraft !== aircraft);
    this.windows = this.windows.filter((w) => w.aircraft !== aircraft);
    this.stats.goArounds += 1;
  }

  /** The aircraft is off the pavement and behind the hold line. */
  vacated(aircraft: number, end: string): void {
    this.runwayOf(end).occupants.delete(aircraft);
    this.windows = this.windows.filter((w) => w.aircraft !== aircraft);
  }

  // ---- departures -----------------------------------------------------------------------

  /**
   * The runway ends a departure may use, the long runways for the big aircraft: the plan's open
   * ones, not sorted. With all of them closed, the plan's others that are long enough for it. A
   * big aircraft with none of those waits at its stand; a small one, failing all, takes the
   * closed ones: it has to leave from somewhere.
   */
  departureEndsFor(body: BodyClass): readonly string[] {
    const big = body === 'wide' || body === 'super';
    const own = big ? this.plan.longDepartures : this.plan.departures;
    const open = own.filter((end) => this.open(end));
    if (open.length) return open;
    const shortest = shortestRunway(body);
    const other = (big ? this.plan.departures : this.plan.longDepartures).filter((end) => this.open(end) && this.net.runwayEnds.get(end)!.runway.length >= shortest);
    return other.length ? other : big ? [] : own;
  }

  /** The runway ends a departure may use, the one with the shortest queue first. */
  departureEnds(body: BodyClass, queued: (end: string) => number): string[] {
    return [...this.departureEndsFor(body)].sort((a, b) => queued(a) - queued(b) || (a < b ? -1 : a > b ? 1 : 0));
  }

  /** May the aircraft at the hold line enter the runway and line up? */
  mayLineUp(aircraft: number, end: string, now: number, lineUpSeconds: number, rollSeconds: number): boolean {
    const runway = this.runwayOf(end);
    let mine = runway.asking.get(aircraft);
    if (!mine) {
      mine = { since: now, last: now, failed: -Infinity };
      runway.asking.set(aircraft, mine);
    }
    mine.last = now;
    if (runway.cleared !== null && runway.cleared !== aircraft) return this.deny('another cleared to line up', runway.cleared);
    const headOn = this.landingTowards(end, now);
    if (headOn !== null) return this.deny('landing the other way', headOn);
    // First come, first served between the hold lines of one runway: a departure that has held
    // short much longer goes first, unless it could not take the last clearance it was given.
    for (const [id, other] of runway.asking) {
      if (id === aircraft) continue;
      if (now - other.last > ASK_LAPSES) {
        runway.asking.delete(id);
        continue;
      }
      if (other.since < mine.since - FIRST_COME && now - other.failed > ASK_LAPSES * 2) return this.deny('another has held short longer', id);
    }
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      const p = this.position(id);
      // On a runway that takes no landings a departure may line up and wait while traffic crosses
      // downfield: it is not cleared to roll until the crossing is over.
      if (occupant.kind === 'crossing' && !this.takesLandings(runway)) continue;
      // Someone still on the pavement behind where this aircraft will start, or yet to pass it.
      if (occupant.kind === 'crossing' || occupant.kind === 'linedUp') return this.deny(`runway has one ${occupant.kind}`, id);
      if (occupant.end !== end) return this.deny('runway in use the other way', id);
      if (!p || p.along < LINE_UP_BEHIND) return this.deny(`runway has one ${occupant.kind} not yet past`, id);
    }
    // On a runway that also takes landings there must be room before the next one: from when it
    // can roll, lined up and clear of the last departure's wake, the take-off clearance's own margin.
    const next = runway.inbound[0];
    const last = runway.lastDeparture;
    const rollAt = Math.max(now + lineUpSeconds, last && last.end === end ? last.time + CONFIG.runway.departureGap[last.wake] : now);
    if (next && next.threshold - rollAt < rollSeconds + ROLL_MARGIN + LINE_UP_MARGIN) return this.deny('landing too close to line up', next.aircraft);
    runway.cleared = aircraft;
    return true;
  }

  /** Does the plan in use land aircraft on this runway? */
  private takesLandings(runway: RunwayState): boolean {
    return this.arrivalEnds.some((end) => this.net.runwayEnds.get(end)!.runway.id === runway.id);
  }

  /** Is a departure waiting to go on a runway that is also landing aircraft? */
  private squeezed(runway: RunwayState): boolean {
    return runway.cleared !== null && this.takesLandings(runway);
  }

  /**
   * Seconds from now until the departure cleared onto a runway that takes no landings could start
   * its roll if nobody crossed: when it is lined up, or soon after if it is still lining up, and
   * clear of the last departure's wake.
   */
  private readyToRoll(runway: RunwayState, now: number): number {
    const lined = runway.cleared !== null && runway.occupants.get(runway.cleared)?.kind === 'linedUp';
    const last = runway.lastDeparture;
    const wake = last ? last.time + CONFIG.runway.departureGap[last.wake] - now : 0;
    return Math.max(lined ? 0 : CROSS_LINING_UP, wake);
  }

  /** The aircraft is on the centreline, stopped. */
  linedUp(aircraft: number, end: string): void {
    const runway = this.runwayOf(end);
    runway.occupants.set(aircraft, { end, kind: 'linedUp' });
    runway.asking.delete(aircraft);
  }

  /** The aircraft could not take its clearance to line up, or gave up its place at the hold line (rerouted, or the plan changed). */
  cancelLineUp(aircraft: number, end: string, now: number): void {
    const runway = this.runwayOf(end);
    if (runway.cleared === aircraft) runway.cleared = null;
    runway.occupants.delete(aircraft);
    const mine = runway.asking.get(aircraft);
    if (mine) mine.failed = now;
  }

  /**
   * May the lined-up aircraft start its roll now? `toCrossings` says how long after brake release
   * it reaches, and has passed, each crossing runway.
   */
  mayTakeOff(aircraft: number, end: string, now: number, wake: WakeClass, rollSeconds: number, toCrossings: { across: string; from: number; to: number }[]): boolean {
    const runway = this.runwayOf(end);
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      const p = this.position(id);
      if (occupant.kind === 'departing' && occupant.end === end && p && p.along > DEPARTED_ALONG_FOR_TAKEOFF) continue;
      return this.deny(`runway has one ${occupant.kind}`, id);
    }
    const last = runway.lastDeparture;
    if (last && last.end === end && now - last.time < CONFIG.runway.departureGap[last.wake]) return this.deny('wake gap behind the last departure');
    const headOn = this.landingTowards(end, now);
    if (headOn !== null) return this.deny('landing the other way', headOn);
    const next = runway.inbound[0];
    if (next && next.threshold - now < rollSeconds + ROLL_MARGIN) return this.deny('landing too close to take off', next.aircraft);
    const margin = CONFIG.runway.crossingMargin;
    for (const c of toCrossings) {
      // A departure fitted between landings on the other runway goes first: its gap will not wait.
      if (!this.squeezed(runway) && this.squeezed(this.runways.get(c.across)!)) return this.deny('a squeezed departure on the crossing runway goes first', this.runways.get(c.across)!.cleared ?? -1);
      const from = now + c.from - margin;
      const to = now + c.to + margin;
      // Anything holding the same crossing point from the other runway.
      for (const w of this.windows) {
        if (w.aircraft === aircraft) continue;
        if (w.on === c.across && w.across === runway.id && w.from < to && from < w.to) return this.deny('crossing runway in use at the crossing point', w.aircraft);
      }
      // Anyone standing or taxiing on the other runway near the crossing.
      const other = this.runways.get(c.across)!;
      for (const [id, occupant] of other.occupants) if (occupant.kind === 'crossing') return this.deny('someone taxiing across the crossing runway', id);
    }
    for (const c of toCrossings) this.windows.push({ on: runway.id, across: c.across, from: now + c.from - margin, to: now + c.to + margin, aircraft });
    runway.occupants.set(aircraft, { end, kind: 'departing' });
    runway.lastDeparture = { time: now, wake, end };
    runway.cleared = null;
    this.stats.takeoffs += 1;
    return true;
  }

  /** The departure is clear of the far end of the runway. */
  departed(aircraft: number, end: string): void {
    this.runwayOf(end).occupants.delete(aircraft);
    this.windows = this.windows.filter((w) => w.aircraft !== aircraft);
  }

  // ---- crossings ------------------------------------------------------------------------

  /**
   * May a taxiing aircraft cross the runway at `along` metres from the pavement edge of
   * `referenceEnd`? Grants hold the runway until `crossed` is called.
   */
  mayCross(aircraft: number, runwayId: string, referenceEnd: string, along: number, now: number): boolean {
    const runway = this.runways.get(runwayId)!;
    const length = this.net.runwayEnds.get(referenceEnd)!.runway.length;
    const squeezed = this.squeezed(runway);
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      if (occupant.kind === 'crossing') continue;
      // A departure lined up on a runway that takes no landings waits for the crossing to be over
      // before it is cleared to roll; how long it may be kept is judged below.
      if (occupant.kind === 'linedUp' && !squeezed) continue;
      const p = this.position(id);
      if (!p) return this.deny(`runway has one ${occupant.kind}`, id);
      const at = occupant.end === referenceEnd ? p.along : length - p.along;
      const towards = occupant.end === referenceEnd ? 1 : -1;
      // Already past the crossing point and moving away from it: no conflict.
      const passed = (along - at) * towards < -CROSSING_PASSED;
      if (!passed) return this.deny(`runway has one ${occupant.kind} not yet past`, id);
    }
    if (runway.cleared !== null) {
      // Nobody crosses in front of a departure that has only a gap between landings to go in.
      if (squeezed) return this.deny('a squeezed departure is cleared onto the runway', runway.cleared);
      // Cleared to line up, not yet to take off (that clearance clears `cleared`): traffic may
      // cross in front of it as long as it holds the departure up by no more than a little.
      if (CONFIG.runway.crossTime - this.readyToRoll(runway, now) > CROSS_HOLDS_DEPARTURE) return this.deny('a departure is ready to go', runway.cleared);
    }
    const next = runway.inbound[0];
    if (next && next.threshold - now < CONFIG.runway.crossBeforeLanding) return this.deny('landing too close to cross', next.aircraft);
    runway.occupants.set(aircraft, { end: referenceEnd, kind: 'crossing' });
    this.stats.crossings += 1;
    return true;
  }

  crossed(aircraft: number, runwayId: string): void {
    this.runways.get(runwayId)!.occupants.delete(aircraft);
  }

  /** True while a taxiing aircraft is on the runway, which holds any take-off clearance. */
  crossingInProgress(end: string): boolean {
    for (const occupant of this.runwayOf(end).occupants.values()) if (occupant.kind === 'crossing') return true;
    return false;
  }

  /** Drop windows that have passed, and slots and gaps an hour gone: no slot is asked for in the past. */
  tidy(now: number): void {
    if (this.windows.length > 64) this.windows = this.windows.filter((w) => w.to > now - 5);
    for (const map of [this.slots, this.holes]) {
      for (const [end, list] of map) if (list.length > 16) map.set(end, list.filter((h) => h.at + h.length > now - 3600));
    }
  }
}

/**
 * The shortest runway an aircraft of a body class may take off from: the longest roll to rotation
 * of its types, with a sixth more and room to line up.
 */
export function shortestRunway(body: BodyClass): number {
  let vRot = 0;
  for (const type of Object.values(AIRCRAFT)) if (type.body === body) vRot = Math.max(vRot, type.vRot);
  return (ROLL_SHARE * vRot * vRot) / (2 * CONFIG.runway.takeoffAccel[body]) + LINE_UP_LENGTH;
}
