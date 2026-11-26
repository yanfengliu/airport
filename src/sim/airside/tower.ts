// The tower: which runways are in use, when each arrival lands, and who may line up, take off or
// cross. Runways that cross each other are shared ground: a movement holds a window of time at
// each crossing point, and nothing else is cleared into that window.

import type { TaxiNet } from '../airfield/net.ts';
import { CONFIG } from '../config.ts';
import type { BodyClass, WakeClass } from '../fleet.ts';

export interface RunwayPlan {
  name: 'West' | 'Southeast';
  /** Runway ends used for landing, for ordinary departures and for departures needing length. */
  arrivals: string[];
  departures: string[];
  longDepartures: string[];
}

export const WEST_PLAN: RunwayPlan = { name: 'West', arrivals: ['28L', '28R'], departures: ['01L', '01R'], longDepartures: ['28L', '28R'] };
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

interface RunwayState {
  id: string;
  /** Aircraft on the pavement, with where they are heading along it. */
  occupants: Map<number, { end: string; kind: 'landing' | 'departing' | 'crossing' | 'linedUp' }>;
  inbound: Inbound[];
  lastDeparture: { time: number; wake: WakeClass; end: string } | null;
  /** Aircraft told to line up or cleared to go, not yet airborne. */
  cleared: number | null;
}

/** What the tower needs to know about an aircraft on a runway. */
export interface RunwayPosition {
  /** Distance from the pavement edge of the end it is using, and speed along the runway. */
  along: number;
  speed: number;
}

export class Tower {
  plan: RunwayPlan = WEST_PLAN;
  /** Side-by-side visual approaches are possible. */
  visual = true;
  readonly runways = new Map<string, RunwayState>();
  private readonly crossings: Crossing[] = [];
  private windows: Window[] = [];
  /** Landing slots taken, by slot number and runway end. */
  private readonly slots = new Map<string, number>();
  private readonly holes = new Set<string>();
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
      this.runways.set(id, { id, occupants: new Map(), inbound: [], lastDeparture: null, cleared: null });
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

  /**
   * Give an arrival the first free landing slot at or after `earliest`. Slots are a fixed beat;
   * in visual conditions each takes one aircraft per arrival runway, landing side by side.
   */
  assignSlot(earliest: number, wake: WakeClass, prefer: string | null): { end: string; threshold: number } {
    const length = this.slotLength;
    const ends = this.visual ? this.plan.arrivals : this.plan.arrivals.slice(-1);
    const order = prefer && ends.includes(prefer) ? [prefer, ...ends.filter((e) => e !== prefer)] : ends;
    for (let k = Math.ceil(earliest / length); ; k += 1) {
      for (const end of order) {
        const key = `${k}:${end}`;
        if (this.slots.has(key) || this.holes.has(key)) continue;
        this.slots.set(key, 1);
        if (wake === 'J') for (let n = 1; n <= CONFIG.runway.slotsBehindSuper; n += 1) this.holes.add(`${k + n}:${end}`);
        return { end, threshold: k * length };
      }
    }
  }

  /** Leave the next unassigned landing slot on a runway empty, for a departure that needs it. */
  openGap(end: string, after: number): number {
    const length = this.slotLength;
    for (let k = Math.ceil(after / length); ; k += 1) {
      const key = `${k}:${end}`;
      if (this.slots.has(key)) continue;
      if (!this.holes.has(key)) this.holes.add(key);
      return k * length;
    }
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
      if (occupant.kind === 'departing' && occupant.end === end && p && p.along > 1500 && p.speed > 55) continue;
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

  /** Which runway end a departure should use: the long runways for the big aircraft. */
  departureEnd(body: BodyClass, queued: (end: string) => number): string {
    const ends = body === 'wide' || body === 'super' ? this.plan.longDepartures : this.plan.departures;
    return [...ends].sort((a, b) => queued(a) - queued(b) || a.localeCompare(b))[0];
  }

  /** May the aircraft at the hold line enter the runway and line up? */
  mayLineUp(aircraft: number, end: string, now: number, lineUpSeconds: number, rollSeconds: number): boolean {
    const runway = this.runwayOf(end);
    if (runway.cleared !== null && runway.cleared !== aircraft) return this.deny('another cleared to line up', runway.cleared);
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      const p = this.position(id);
      // Someone still on the pavement behind where this aircraft will start, or yet to pass it.
      if (occupant.kind === 'crossing' || occupant.kind === 'linedUp') return this.deny(`runway has one ${occupant.kind}`, id);
      if (occupant.end !== end) return this.deny('runway in use the other way', id);
      if (!p || p.along < 600) return this.deny(`runway has one ${occupant.kind} not yet past`, id);
    }
    // On a runway that also takes landings there must be room before the next one.
    const next = runway.inbound[0];
    if (next && next.threshold - now < lineUpSeconds + rollSeconds + 22) return this.deny('landing too close to line up', next.aircraft);
    runway.cleared = aircraft;
    return true;
  }

  /** Is a departure waiting to go on a runway that is also landing aircraft? */
  private squeezed(runway: RunwayState): boolean {
    if (runway.cleared === null) return false;
    return this.plan.arrivals.some((end) => this.net.runwayEnds.get(end)!.runway.id === runway.id);
  }

  /** The aircraft is on the centreline, stopped. */
  linedUp(aircraft: number, end: string): void {
    this.runwayOf(end).occupants.set(aircraft, { end, kind: 'linedUp' });
  }

  /** The aircraft gave up its place at the hold line (rerouted, or the plan changed). */
  cancelLineUp(aircraft: number, end: string): void {
    const runway = this.runwayOf(end);
    if (runway.cleared === aircraft) runway.cleared = null;
    runway.occupants.delete(aircraft);
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
      if (occupant.kind === 'departing' && occupant.end === end && p && p.along > 1700) continue;
      return this.deny(`runway has one ${occupant.kind}`, id);
    }
    const last = runway.lastDeparture;
    if (last && last.end === end && now - last.time < CONFIG.runway.departureGap[last.wake]) return this.deny('wake gap behind the last departure');
    const next = runway.inbound[0];
    if (next && next.threshold - now < rollSeconds + 20) return this.deny('landing too close to take off', next.aircraft);
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
    for (const [id, occupant] of runway.occupants) {
      if (id === aircraft) continue;
      if (occupant.kind === 'crossing') continue;
      const p = this.position(id);
      if (!p) return this.deny(`runway has one ${occupant.kind}`, id);
      const at = occupant.end === referenceEnd ? p.along : length - p.along;
      const towards = occupant.end === referenceEnd ? 1 : -1;
      // Already past the crossing point and moving away from it: no conflict.
      const passed = (along - at) * towards < -90;
      if (!passed) return this.deny(`runway has one ${occupant.kind} not yet past`, id);
    }
    if (runway.cleared !== null) {
      // Nobody crosses in front of a departure that has only a gap between landings to go in.
      if (this.squeezed(runway)) return this.deny('a squeezed departure is cleared onto the runway', runway.cleared);
      const p = this.position(runway.cleared);
      // Someone cleared onto the runway who has not started to roll may be held; anyone else not.
      if (p && p.speed > 1) return this.deny('a departure is rolling', runway.cleared);
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

  /** Drop windows that have passed. */
  tidy(now: number): void {
    if (this.windows.length > 64) this.windows = this.windows.filter((w) => w.to > now - 5);
  }
}
