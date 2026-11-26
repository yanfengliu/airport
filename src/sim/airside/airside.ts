// The airside: every aircraft, the tower and the ground traffic control, stepped together.

import { parkedClearance, type Parked } from '../../shared/footprint.ts';
import type { TaxiNet } from '../airfield/net.ts';
import { fuselageAt, newFuselage } from '../airfield/path.ts';
import { Traffic } from '../airfield/traffic.ts';
import { CONFIG } from '../config.ts';
import { AIRCRAFT, AIRLINE_BY_CODE, type AircraftType } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import type { Rotation } from '../schedule.ts';
import { Aircraft, approachSeconds, standPath, type AirsideServices } from './aircraft.ts';
import { FlightBook, TAXI_IN_NOMINAL, type Visit } from './flights.ts';
import { flowCosts } from './flows.ts';
import type { UsableStands } from './stands.ts';
import { Tower } from './tower.ts';

/** Seconds of route cost for each block taken against the way another aircraft is routed along it. */
const AGAINST_TRAFFIC = 240;
/** Room kept between the outlines of two aircraft on neighbouring stands, wings included, metres. */
const BESIDE = 2;

export interface SimEvent {
  time: number;
  kind: string;
  text: string;
  aircraft: number;
}

interface PendingArrival {
  visit: Visit;
  end: string;
  threshold: number;
}

export class Airside {
  readonly net: TaxiNet;
  readonly traffic: Traffic;
  readonly tower: Tower;
  readonly book: FlightBook;
  readonly aircraft: Aircraft[] = [];
  readonly events: SimEvent[] = [];
  now: number;

  private readonly byId = new Map<number, Aircraft>();
  private readonly pending: PendingArrival[] = [];
  /** Stands an aircraft can both reach and leave; see stands.ts. */
  private readonly usable: ReadonlyMap<string, number>;
  /** Stands that share a lead-in line and so cannot be occupied together. */
  private readonly conflicts: ReadonlyMap<string, readonly string[]>;
  private readonly svc: AirsideServices;
  private readonly outlines = new Map<string, Parked | null>();
  private nextId = 1;
  private nextHousekeeping = 0;
  /** Totals for the tests and the operations panel. */
  totals = { arrived: 0, departed: 0, gateChanges: 0, longestWait: 0, heldForStand: 0 };

  constructor(net: TaxiNet, usable: UsableStands, rotations: readonly Rotation[], rng: Rng, startTime: number) {
    this.net = net;
    this.usable = usable.span;
    this.conflicts = usable.conflicts;
    const flow = flowCosts(net);
    // Arcs other aircraft are routed along, refreshed whenever one plans a route.
    const routed = new Uint8Array(net.blocks.length * 2);
    const ahead: number[] = [];
    this.traffic = new Traffic(this.net);
    this.tower = new Tower(this.net, (id) => this.byId.get(id)?.runwayPosition() ?? null);
    this.book = new FlightBook(rotations);
    this.now = startTime;
    this.svc = {
      net: this.net,
      traffic: this.traffic,
      tower: this.tower,
      rng: rng.fork('aircraft'),
      now: startTime,
      arcCost: (arc) => flow[arc] + (routed[arc ^ 1] ? AGAINST_TRAFFIC : 0),
      planFor: (aircraft) => {
        routed.fill(0);
        for (const a of this.aircraft) {
          if (a.id === aircraft) continue;
          ahead.length = 0;
          a.routeAhead(ahead);
          for (const arc of ahead) routed[arc] = 1;
        }
      },
      opposed: (arc) => routed[arc ^ 1] === 1,
      standFree: (stand, forVisit) => this.standFree(stand, forVisit),
      otherStand: (visit, avoid) => this.otherStand(visit, avoid),
      departuresFor: (end) => this.aircraft.reduce((n, a) => n + (a.runwayEnd === end && (a.phase === 'pushback' || a.phase === 'starting' || a.phase === 'taxiOut' || a.phase === 'lineUp') ? 1 : 0), 0),
      event: (kind, text, aircraft) => this.event(kind, text, aircraft),
    };
    this.book.extendTo(startTime + 8 * 3600);
    // Aircraft that arrived before the simulation starts are at their stands.
    for (const visit of this.book.parkedAt(startTime)) {
      if (!this.standFree(visit.stand, visit.id)) {
        const other = this.otherStand(visit);
        if (!other) continue;
        visit.stand = other;
      }
      const aircraft = this.create(visit);
      if (!aircraft.startParked(this.svc)) this.discard(aircraft);
    }
    // Anything due in before the start that is not parked has been and gone.
    for (const visit of this.book.visits.values()) {
      if (visit.state === 'scheduled' && visit.std <= startTime) visit.state = 'done';
    }
  }

  get byIdMap(): ReadonlyMap<number, Aircraft> {
    return this.byId;
  }

  private create(visit: Visit): Aircraft {
    const aircraft = new Aircraft(this.nextId, visit, AIRCRAFT[visit.rotation.type], AIRLINE_BY_CODE[visit.rotation.airline]);
    this.nextId += 1;
    this.aircraft.push(aircraft);
    this.byId.set(aircraft.id, aircraft);
    return aircraft;
  }

  private discard(aircraft: Aircraft): void {
    this.traffic.remove(aircraft.mover);
    this.byId.delete(aircraft.id);
    const at = this.aircraft.indexOf(aircraft);
    if (at >= 0) this.aircraft.splice(at, 1);
  }

  private event(kind: string, text: string, aircraft: number): void {
    this.events.push({ time: this.now, kind, text, aircraft });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 300);
    if (kind === 'gate-change') this.totals.gateChanges += 1;
    if (kind === 'on-block') this.totals.arrived += 1;
  }

  /** The outline of an aircraft of a type as it stands parked at a stand; null for a stand with no line. */
  private outlineAt(stand: string, type: AircraftType): Parked | null {
    const key = `${stand}:${type.id}`;
    const known = this.outlines.get(key);
    if (known !== undefined) return known;
    const path = standPath(this.net, stand, type.length);
    let outline: Parked | null = null;
    if (path) {
      const at = fuselageAt(path, path.total, newFuselage());
      // The outline is placed by the nose wheel, four metres behind the nose.
      const ahead = type.length / 2 - 4;
      outline = { x: at.x + Math.cos(at.heading) * ahead, y: at.y + Math.sin(at.heading) * ahead, heading: at.heading, span: type.span, length: type.length };
    }
    this.outlines.set(key, outline);
    return outline;
  }

  /**
   * No aircraft is on the stand or on one that shares its line, none but `forVisit` is on its way
   * to either, and the visit's aircraft parked there would touch none parked on, or bound for, a
   * stand nearby.
   */
  private standFree(stand: string, forVisit: number): boolean {
    const shared = this.conflicts.get(stand);
    const visit = this.book.visits.get(forVisit);
    const mine = visit ? this.outlineAt(stand, AIRCRAFT[visit.rotation.type]) : null;
    for (const a of this.aircraft) {
      if (a.visit.id === forVisit) continue;
      const there = a.phase === 'parked' || a.phase === 'taxiIn' || a.phase === 'landing' || (a.phase === 'pushback' && a.mover.s < a.body + 30);
      if (!there) continue;
      if (a.visit.stand === stand || shared?.includes(a.visit.stand)) return false;
      if (!mine) continue;
      const theirs = this.outlineAt(a.visit.stand, a.type);
      if (theirs && parkedClearance(mine, theirs) < BESIDE) return false;
    }
    return true;
  }

  private otherStand(visit: Visit, avoid?: ReadonlySet<string>): string | null {
    const type = AIRCRAFT[visit.rotation.type];
    const airline = AIRLINE_BY_CODE[visit.rotation.airline];
    const wanted = visit.rotation.customs || visit.rotation.internationalOut ? airline.internationalAreas : airline.areas;
    const allowed = visit.rotation.customs ? ['G', 'A'] : ['B', 'C', 'D', 'E', 'F', 'A', 'G'];
    const rank = (area: string): number => {
      const i = wanted.indexOf(area);
      if (i >= 0) return i;
      const j = allowed.indexOf(area);
      return j >= 0 ? 10 + j : 100;
    };
    // A stand another flight is due on within the hour is not really free.
    const soon = new Set<string>();
    for (const v of this.book.visits.values()) {
      if (v.id !== visit.id && v.state === 'scheduled' && v.eta - this.now < 3600 && v.eta > this.now - 600) soon.add(v.stand);
    }
    let best: string | null = null;
    let bestScore = Infinity;
    for (const stand of this.net.stands.values()) {
      const span = this.usable.get(stand.id);
      if (span === undefined || span + 0.5 < type.span || avoid?.has(stand.id)) continue;
      if (!this.standFree(stand.id, visit.id)) continue;
      const score = (stand.contact ? rank(stand.area) : 50) * 100 + (soon.has(stand.id) ? 40 : 0) + (span - type.span);
      if (score < bestScore) {
        bestScore = score;
        best = stand.id;
      }
    }
    return best;
  }

  step(dt: number): void {
    this.now += dt;
    this.svc.now = this.now;
    if (this.now >= this.nextHousekeeping) {
      this.nextHousekeeping = this.now + 5;
      this.schedule();
      this.turnarounds();
      this.tower.tidy(this.now);
    }
    this.launchArrivals();
    for (const aircraft of this.aircraft) aircraft.step(this.svc, dt);
    for (let i = this.aircraft.length - 1; i >= 0; i -= 1) {
      const a = this.aircraft[i];
      if (a.waitingSince >= 0) this.totals.longestWait = Math.max(this.totals.longestWait, this.now - a.waitingSince);
      if (a.phase !== 'gone') continue;
      if (a.visit.state === 'done') this.totals.departed += 1;
      this.discard(a);
    }
  }

  /** Give arrivals due soon a landing slot. */
  private schedule(): void {
    this.book.extendTo(this.now + 8 * 3600);
    this.book.prune(this.now);
    const lead = approachSeconds(CONFIG.approach.startDistance, 70) + 90;
    for (const visit of this.book.inboundAfter(this.now - 3600)) {
      const wantThreshold = visit.eta - TAXI_IN_NOMINAL;
      // The list is in timetable order, and a delayed flight can be due after a later one.
      if (wantThreshold - this.now > lead) continue;
      if (this.pending.some((p) => p.visit === visit) || visit.aircraft >= 0) continue;
      const type = AIRCRAFT[visit.rotation.type];
      const earliest = Math.max(wantThreshold, this.now + approachSeconds(CONFIG.approach.startDistance, type.vApp) + 5);
      const slot = this.tower.assignSlot(earliest, type.wake, null);
      this.pending.push({ visit, end: slot.end, threshold: slot.threshold });
      visit.eta = Math.max(visit.eta, slot.threshold + TAXI_IN_NOMINAL);
      if (slot.threshold - wantThreshold > 600 && !visit.delayNote) visit.delayNote = 'Arrival flow';
    }
  }

  /** Put an aircraft on final when it is time for it to start down the approach. */
  private launchArrivals(): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const p = this.pending[i];
      const type = AIRCRAFT[p.visit.rotation.type];
      if (this.now < p.threshold - approachSeconds(CONFIG.approach.startDistance, type.vApp)) continue;
      if (p.visit.state === 'scheduled' && !this.standFree(p.visit.stand, p.visit.id) && !this.otherStand(p.visit)) {
        // Nowhere to park it: it holds off the approach, and takes a later landing slot.
        const slot = this.tower.assignSlot(this.now + approachSeconds(CONFIG.approach.startDistance, type.vApp) + 60, type.wake, null);
        p.end = slot.end;
        p.threshold = slot.threshold;
        p.visit.eta = Math.max(p.visit.eta, slot.threshold + TAXI_IN_NOMINAL);
        if (!p.visit.delayNote) p.visit.delayNote = 'Holding for a stand';
        this.totals.heldForStand += 1;
        continue;
      }
      this.pending.splice(i, 1);
      if (p.visit.state !== 'scheduled') continue;
      this.create(p.visit).startApproach(this.svc, p.end, p.threshold);
    }
  }

  /** Time-driven turnaround: when boarding opens, when doors close, when to ask to push. */
  private turnarounds(): void {
    for (const a of this.aircraft) {
      if (a.phase !== 'parked') continue;
      const v = a.visit;
      const type = a.type;
      const earliest = v.onBlockAt + type.turn[0] * 60;
      v.etd = Math.max(v.std, earliest, v.etd);
      if (v.etd - v.std > 600 && !v.delayNote) v.delayNote = 'Late inbound aircraft';
      // Until passengers are simulated, people get off and on at a steady rate.
      if (v.deplaned < v.rotation.paxIn && this.now > v.onBlockAt + 100) v.deplaned = Math.min(v.rotation.paxIn, v.deplaned + 5 * 0.45 * type.doors);
      const boardingAt = v.etd - CONFIG.turnaround.boardingStarts[type.body] * 60;
      if (!v.boardingOpen && this.now >= boardingAt && v.deplaned >= v.rotation.paxIn) v.boardingOpen = true;
      if (v.boardingOpen && v.boarded < v.rotation.paxOut) v.boarded = Math.min(v.rotation.paxOut, v.boarded + 5 * 0.3 * type.doors);
      if (!v.doorsClosed && v.boardingOpen && v.boarded >= v.rotation.paxOut && this.now >= v.etd - CONFIG.turnaround.doorsClose * 60) {
        v.doorsClosed = true;
        v.boardingOpen = false;
      }
      if (v.doorsClosed && this.now >= v.etd) a.tryPushback(this.svc);
    }
  }

  /** A number that changes if anything about the aircraft does; for the determinism test. */
  checksum(): number {
    let h = 2166136261;
    const mix = (value: number): void => {
      h ^= Math.round(value * 16) | 0;
      h = Math.imul(h, 16777619);
    };
    for (const a of this.aircraft) {
      mix(a.id);
      mix(a.x);
      mix(a.y);
      mix(a.alt);
      mix(a.speed);
      mix(a.phase.length);
    }
    mix(this.tower.stats.landings);
    mix(this.tower.stats.takeoffs);
    return h >>> 0;
  }
}
