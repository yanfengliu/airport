// The airside: every aircraft, the tower and the ground traffic control, stepped together.

import { parkedClearance, shapeClearance, shapeOf, type Parked, type Shape } from '../../shared/footprint.ts';
import type { TaxiNet } from '../airfield/net.ts';
import { fuselageAt, newFuselage } from '../airfield/path.ts';
import { Traffic, newMover } from '../airfield/traffic.ts';
import { CONFIG } from '../config.ts';
import { AIRCRAFT, AIRLINE_BY_CODE, type AircraftType } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import type { Rotation } from '../schedule.ts';
import { Aircraft, approachSeconds, leadInPath, pushPlansFor, standPath, wayInPath, waysIn, type AirsideServices } from './aircraft.ts';
import { FlightBook, NOT_YET, TAXI_IN_NOMINAL, type Visit } from './flights.ts';
import { flowCosts } from './flows.ts';
import { CLEAR_WEST, pairedApproaches, planFor, type Weather } from '../weather.ts';
import type { UsableStands } from './stands.ts';
import { Tower } from './tower.ts';

/** Seconds of route cost for each block taken against the way another aircraft is routed along it. */
const AGAINST_TRAFFIC = 240;
/** Room kept between the outlines of two aircraft on neighbouring stands, wings included, metres. */
const BESIDE = 2;
const { slotHorizon: SLOT_HORIZON, changeover: CHANGEOVER } = CONFIG.runway;

export interface SimEvent {
  time: number;
  kind: string;
  text: string;
  aircraft: number;
}

/** The ground a stand asks of one type of aircraft, as tiles. */
interface StandGround {
  /** Where it rests, parked. */
  rest: number[];
  restBox: [number, number, number, number];
  /** The stand's own line, followed in. The rest of the way in is judged by the arrival's own ways, `Aircraft.wayIn`. */
  lineIn: Set<number>;
  /** Each way of pushing back that leads to a runway, as far as the push goes. */
  pushes: Set<number>[];
  /** A box round the lead-in and every push. */
  reachBox: [number, number, number, number];
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
  private readonly startTime: number;

  private readonly byId = new Map<number, Aircraft>();
  private readonly pending: PendingArrival[] = [];
  /** Stands an aircraft can both reach and leave; see stands.ts. */
  private readonly usable: ReadonlyMap<string, number>;
  /** Stands that share a lead-in line and so cannot be occupied together. */
  private readonly conflicts: ReadonlyMap<string, readonly string[]>;
  private readonly svc: AirsideServices;
  private readonly poses = new Map<string, { x: number; y: number; heading: number } | null>();
  private readonly outlines = new Map<string, Parked | null>();
  private readonly shapes = new Map<string, Shape | null>();
  private readonly grounds = new Map<string, StandGround | null>();
  private readonly shut = new Map<string, { lineIn: boolean; out: boolean }>();
  /** Per runway end: the arcs from which a departure can taxi to it, and the arcs that arrive at its line-up. */
  private readonly towards = new Map<string, { reaching: Uint8Array; goals: Set<number> }>();
  /** Stands in for an aircraft not yet on the ground, for asking what ground is taken. */
  private readonly probe = newMover(-2);
  private nextId = 1;
  private nextHousekeeping = 0;
  /** Set when the terminals simulate passengers: they then count people off and on. */
  passengersElsewhere = false;
  /** The weather the runways are run for; set with `setWeather`. */
  weather: Weather = CLEAR_WEST;
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
    // On their way to the end, on it, or still climbing out from it along the line an arrival to
    // the other end would come in on.
    this.tower.departuresWaiting = (end) => this.aircraft.some((a) => a.runwayEnd === end && (a.phase === 'pushback' || a.phase === 'starting' || a.phase === 'taxiOut' || a.phase === 'lineUp' || a.phase === 'takeoff' || a.phase === 'climb'));
    this.book = new FlightBook(rotations);
    this.now = startTime;
    this.startTime = startTime;
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
      openGap: (end, after) => this.openGap(end, after),
      leadsTo: (arc, end) => this.leadsTo(arc, end),
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

  /** Where an aircraft of a type rests parked at a stand, as it is drawn there: the middle of its fuselage and its heading; null for a stand with no line. */
  private poseAt(stand: string, type: AircraftType): { x: number; y: number; heading: number } | null {
    const key = `${stand}:${type.id}`;
    const known = this.poses.get(key);
    if (known !== undefined) return known;
    const path = standPath(this.net, stand, type.length);
    const at = path ? fuselageAt(path, path.total, newFuselage()) : null;
    const pose = at ? { x: at.x, y: at.y, heading: at.heading } : null;
    this.poses.set(key, pose);
    return pose;
  }

  /** The lines of an aircraft of a type parked at a stand, as the map's stand rule draws it; null for a stand with no line. */
  private outlineAt(stand: string, type: AircraftType): Parked | null {
    const key = `${stand}:${type.id}`;
    const known = this.outlines.get(key);
    if (known !== undefined) return known;
    const at = this.poseAt(stand, type);
    let outline: Parked | null = null;
    if (at) {
      // The lines are placed by the nose wheel, four metres behind the nose.
      const ahead = type.length / 2 - 4;
      outline = { x: at.x + Math.cos(at.heading) * ahead, y: at.y + Math.sin(at.heading) * ahead, heading: at.heading, span: type.span, length: type.length };
    }
    this.outlines.set(key, outline);
    return outline;
  }

  /**
   * An aircraft of a type parked at a stand, drawn at true size as the model draws it there, ready
   * to compare: once per stand and type. Null for a stand with no line.
   */
  parkedShape(stand: string, type: AircraftType): Shape | null {
    const key = `${stand}:${type.id}`;
    const known = this.shapes.get(key);
    if (known !== undefined) return known;
    const at = this.poseAt(stand, type);
    const shape = at ? shapeOf(type, at.x, at.y, at.heading) : null;
    this.shapes.set(key, shape);
    return shape;
  }

  /**
   * May an aircraft of `type` rest on `stand` while one of `otherType` rests on `other`, by the
   * stand rule: drawn as the map's stand rule draws them, three lines, they are BESIDE apart, and
   * drawn as the model draws them, every part at its true size, a metre apart at least.
   */
  fitTogether(stand: string, type: AircraftType, other: string, otherType: AircraftType): boolean {
    const mine = this.outlineAt(stand, type);
    const theirs = this.outlineAt(other, otherType);
    if (mine && theirs && parkedClearance(mine, theirs) < BESIDE) return false;
    const mineShape = this.parkedShape(stand, type);
    const theirShape = this.parkedShape(other, otherType);
    return !(mineShape && theirShape && shapeClearance(mineShape, theirShape, CONFIG.taxi.outlineGap) < CONFIG.taxi.outlineGap);
  }

  /**
   * No aircraft is on the stand or on one that shares its line, none but `forVisit` is on its way
   * to either, and the visit's aircraft parked there would touch none parked on, or bound for, a
   * stand nearby, nor shut one in, nor be shut in by one.
   */
  private standFree(stand: string, forVisit: number): boolean {
    const shared = this.conflicts.get(stand);
    const visit = this.book.visits.get(forVisit);
    const type = visit ? AIRCRAFT[visit.rotation.type] : null;
    const mine = type ? this.outlineAt(stand, type) : null;
    const mineRest = type ? this.groundOf(stand, type)?.rest : undefined;
    for (const a of this.aircraft) {
      if (a.visit.id === forVisit) continue;
      // An arrival is bound for its stand from the start of its approach.
      const there = a.phase === 'parked' || a.phase === 'taxiIn' || a.phase === 'landing' || a.phase === 'approach' || (a.phase === 'pushback' && a.mover.s < a.body + 30);
      if (!there) continue;
      if (a.visit.stand === stand || shared?.includes(a.visit.stand)) return false;
      if (!mine || !type) continue;
      // Clear of it by the stand rule, and drawn as they are a metre apart at least.
      if (!this.fitTogether(stand, type, a.visit.stand, a.type)) return false;
      // A parked aircraft needs only its way out; one still coming needs its way in as well.
      const coming = a.phase !== 'parked' && a.phase !== 'pushback';
      if (this.shutsIn(a.visit.stand, a.type, stand, type, true) || this.shutsIn(stand, type, a.visit.stand, a.type, coming)) return false;
      // Nor may it rest on ground an arrival has still to pass over to reach its own stand.
      if (coming && mineRest) {
        const way = a.wayInGround();
        if (way && mineRest.some((tile) => way.has(tile))) return false;
      }
    }
    return true;
  }

  /** Can a departure facing along `arc` taxi from there to runway `end`, as the router would find? */
  private leadsTo(arc: number, end: string): boolean {
    let known = this.towards.get(end);
    if (!known) {
      const goals: number[] = [];
      for (const { node } of this.net.lineUpNodes(end)) for (const a of this.net.arcsFrom(node)) if (this.net.arcBlock(a).kind === 'twy') goals.push(a ^ 1);
      known = { reaching: this.net.reaching(goals), goals: new Set(goals) };
      this.towards.set(end, known);
    }
    // The route has to go somewhere after the push, so the arc it faces alone is not enough.
    return known.reaching[arc] === 1 && !known.goals.has(arc);
  }

  /**
   * The ground a stand asks of an aircraft of a type: where it rests, its lead-in, and each way of
   * pushing back that leads to a runway it may take off from under the plan in use. A push that
   * leads nowhere is no way out, however clear it is.
   */
  /** The runways closed, as part of a cache key: which ways out lead anywhere depends on them. */
  private closedKey(): string {
    return [...this.tower.closed].sort().join(',');
  }

  private groundOf(stand: string, type: AircraftType): StandGround | null {
    const plan = this.tower.plan;
    const key = `${stand}:${type.id}:${plan.name}:${this.closedKey()}`;
    const known = this.grounds.get(key);
    if (known !== undefined) return known;
    const ends = this.tower.departureEndsFor(type.body);
    let ground: StandGround | null = null;
    const node = this.net.standNode.get(stand);
    const rest = standPath(this.net, stand, type.length);
    const lead = leadInPath(this.net, stand, type.length);
    if (node !== undefined && rest && lead) {
      const lineIn = new Set(lead.tiles);
      const leading = pushPlansFor(this.net, node, type).filter((plan) => ends.some((end) => this.leadsTo(plan.push.forward, end)));
      const pushes = leading.map((plan) => {
        const tiles = new Set<number>();
        for (let i = 0; i < plan.path.tiles.length && plan.path.from[i] <= plan.pushEnd; i += 1) tiles.add(plan.path.tiles[i]);
        return tiles;
      });
      const restTiles = Array.from(rest.tiles);
      const all = [...lead.tiles, ...pushes.flatMap((p) => [...p])];
      ground = { rest: restTiles, restBox: this.boxOf(restTiles), lineIn, pushes, reachBox: this.boxOf(all) };
    }
    this.grounds.set(key, ground);
    return ground;
  }

  private boxOf(tiles: readonly number[]): [number, number, number, number] {
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const tile of tiles) {
      const c = this.net.grid.centre(tile);
      box[0] = Math.min(box[0], c.x);
      box[1] = Math.min(box[1], c.y);
      box[2] = Math.max(box[2], c.x);
      box[3] = Math.max(box[3], c.y);
    }
    return box;
  }

  /**
   * Would an aircraft of type `a` resting at stand `s` leave one of type `b` at stand `t` no way
   * to push back, or, with `comingIn`, no way in? Then the two cannot be parked together: one would
   * wait at its stand, or on the taxiway, for as long as the other stays.
   */
  private shutsIn(s: string, a: AircraftType, t: string, b: AircraftType, comingIn: boolean): boolean {
    const from = this.groundOf(s, a);
    const to = this.groundOf(t, b);
    if (!from || !to) return false;
    const [ax0, ay0, ax1, ay1] = from.restBox;
    const [bx0, by0, bx1, by1] = to.reachBox;
    if (ax0 > bx1 || bx0 > ax1 || ay0 > by1 || by0 > ay1) return false;
    const key = `${s}:${a.id}>${t}:${b.id}:${this.tower.plan.name}:${this.closedKey()}`;
    let known = this.shut.get(key);
    if (known === undefined) {
      const hits = (tiles: ReadonlySet<number>): boolean => from.rest.some((tile) => tiles.has(tile));
      known = { lineIn: hits(to.lineIn), out: to.pushes.length > 0 && to.pushes.every(hits) };
      this.shut.set(key, known);
    }
    return known.out || (comingIn && known.lineIn);
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
    // Landing slots are given out only a little ahead of the approach, so that the sequence can
    // still make room for a departure that needs a gap; arrivals beyond it wait their turn.
    const horizon = this.now + lead + SLOT_HORIZON;
    // Arrivals left waiting for a slot are shown on the boards as landing in turn after it, as
    // many at a time as there are runways landing.
    const streams = Math.max(1, this.tower.arrivalEnds.length);
    let queued = 0;
    // However late, an arrival is waited for until it lands; but not one due before the day
    // started that found no stand to be put on at the start, which is not flown.
    for (const visit of this.book.inboundAfter(this.startTime - 3600)) {
      const wantThreshold = visit.eta - TAXI_IN_NOMINAL;
      // The list is in timetable order, and a delayed flight can be due after a later one.
      if (wantThreshold - this.now > lead) continue;
      if (this.pending.some((p) => p.visit === visit) || visit.aircraft >= 0) continue;
      const type = AIRCRAFT[visit.rotation.type];
      const earliest = Math.max(wantThreshold, this.now + approachSeconds(CONFIG.approach.startDistance, type.vApp) + 5);
      const slot = this.tower.assignSlot(earliest, type.wake, null, horizon);
      if (!slot) {
        const expected = Math.max(horizon, this.tower.notBefore) + (Math.floor(queued / streams) + 1) * this.tower.slotLength;
        queued += 1;
        visit.queuedEta = expected + TAXI_IN_NOMINAL;
        if (expected - wantThreshold > 600 && !visit.delayNote) visit.delayNote = 'Arrival flow';
        continue;
      }
      this.pending.push({ visit, end: slot.end, threshold: slot.threshold });
      visit.eta = Math.max(visit.eta, slot.threshold + TAXI_IN_NOMINAL);
      visit.queuedEta = NOT_YET;
      if (slot.threshold - wantThreshold > 600 && !visit.delayNote) visit.delayNote = 'Arrival flow';
    }
  }

  /** Put an aircraft on final when it is time for it to start down the approach. */
  private launchArrivals(): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const p = this.pending[i];
      const type = AIRCRAFT[p.visit.rotation.type];
      if (this.now < p.threshold - approachSeconds(CONFIG.approach.startDistance, type.vApp)) continue;
      let wayIn: Set<number> | null = null;
      if (p.visit.state === 'scheduled') {
        // Its stand is fixed before the approach starts, and is its own from then on.
        const found = this.standFor(p);
        if (!found) {
          // Nowhere to park it: it holds off the approach, and takes a later landing slot.
          this.tower.releaseSlot(p.end, p.threshold);
          const slot = this.tower.assignSlot(this.now + approachSeconds(CONFIG.approach.startDistance, type.vApp) + 60, type.wake, null);
          if (!p.visit.delayNote) p.visit.delayNote = 'Holding for a stand';
          this.totals.heldForStand += 1;
          if (!slot) {
            // No slot to be had now: it is given one again when there is.
            this.pending.splice(i, 1);
            continue;
          }
          p.end = slot.end;
          p.threshold = slot.threshold;
          p.visit.eta = Math.max(p.visit.eta, slot.threshold + TAXI_IN_NOMINAL);
          continue;
        }
        if (found.stand !== p.visit.stand) {
          this.event('gate-change', `${p.visit.rotation.arrFlight} gate changed ${p.visit.stand} to ${found.stand}`, -1);
          p.visit.stand = found.stand;
        }
        wayIn = found.wayIn;
      }
      this.pending.splice(i, 1);
      if (p.visit.state !== 'scheduled') continue;
      const aircraft = this.create(p.visit);
      aircraft.startApproach(this.svc, p.end, p.threshold);
      aircraft.wayIn = wayIn;
    }
  }

  /**
   * A stand for an arrival about to start its approach, with the ground of its ways in: free, and
   * with some way in from the runway it lands on that runs over no ground an aircraft rests on or
   * will rest on. Null when there is none.
   */
  private standFor(p: PendingArrival): { stand: string; wayIn: Set<number> } | null {
    const avoid = new Set<string>();
    let stand = p.visit.stand;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (avoid.has(stand) || !this.standFree(stand, p.visit.id)) {
        const other = this.otherStand(p.visit, avoid);
        if (!other) return null;
        stand = other;
      }
      const wayIn = this.openWaysIn(p.visit, stand, p.end);
      if (wayIn) return { stand, wayIn };
      avoid.add(stand);
    }
    return null;
  }

  /**
   * The ground of the ways a landing on `end` would try to `stand` that no aircraft parked, or
   * bound for a stand of its own, rests on; null when there are none.
   */
  private openWaysIn(visit: Visit, stand: string, end: string): Set<number> | null {
    const node = this.net.standNode.get(stand);
    const info = this.net.runwayEnds.get(end);
    if (node === undefined || !info) return null;
    const type = AIRCRAFT[visit.rotation.type];
    // Where the arrivals already on their way will rest: their ground is not yet marked as theirs.
    const coming: number[][] = [];
    for (const a of this.aircraft) {
      if (a.phase !== 'approach' || a.wayFixed) continue;
      const ground = this.groundOf(a.visit.stand, a.type);
      if (ground) coming.push(ground.rest);
    }
    this.svc.planFor(-1);
    const tiles = new Set<number>();
    for (const way of waysIn(this.svc, end, stand, node, CONFIG.approach.touchdownBeyondThreshold, type.vApp - 3)) {
      const path = wayInPath(this.net, info, way, type);
      if (this.traffic.restingOn(this.probe, path) !== -1) continue;
      if (coming.some((rest) => rest.some((tile) => path.index.has(tile)))) continue;
      for (const tile of path.tiles) tiles.add(tile);
    }
    return tiles.size ? tiles : null;
  }

  /**
   * New weather: the runway plan and the pairing of approaches follow it. A change of plan takes
   * the runways out of the arrival flow for a while, unless `immediate` (as before the day starts).
   * Arrivals not yet on their approach are given new landing slots under the new arrangement.
   */
  setWeather(weather: Weather, immediate = false): void {
    this.weather = weather;
    const plan = planFor(weather, this.tower.plan);
    const paired = pairedApproaches(weather);
    if (plan === this.tower.plan && paired === this.tower.visual) return;
    this.reslot(() => {
      if (this.tower.setPlan(plan, this.now, immediate ? 0 : CHANGEOVER)) {
        this.event('runways', `Runways change to the ${plan.name} Plan: landing ${plan.arrivals.join(' and ')}, taking off from ${plan.departures.join(' and ')}`, -1);
      }
      if (this.tower.setPaired(paired)) this.event('runways', paired ? 'Paired approaches resume on the parallel runways' : 'Cloud too low for paired approaches: one arrival stream', -1);
    });
  }

  /** Close a runway to new movements, or open it again. What is already cleared onto it goes on. */
  setRunwayClosed(runway: string, closed: boolean): void {
    if (this.tower.closed.has(runway) === closed || !this.tower.runways.has(runway)) return;
    this.reslot(() => {
      if (closed) this.tower.closed.add(runway);
      else this.tower.closed.delete(runway);
    });
    this.event('runways', closed ? `Runway ${runway} closed to new traffic: aircraft already on their way to it still use it` : `Runway ${runway} open again`, -1);
  }

  /**
   * Leave a landing slot empty on `end`, the first at or after `after` that is free or given to an
   * arrival not yet on its approach: that arrival is moved back to the next free slot, as approach
   * control stretches the arrival stream to let a departure go. Returns the time of the gap.
   */
  private openGap(end: string, after: number): number {
    const length = this.tower.slotLength;
    for (let k = Math.ceil(after / length); ; k += 1) {
      const at = k * length;
      const taken = this.tower.slotTaken(end, at);
      // A gap already planned there, behind a super-heavy arrival say, serves as well, but only if
      // no arrival has any of the slot: after a change of beat, a gap and a slot given in the old
      // beat can both overlap it (review 1, R4).
      if (this.tower.isHole(end, at) && !taken) return at;
      const taker = this.pending.find((p) => p.end === end && Math.abs(p.threshold - at) < 1);
      if (taken && !taker) continue;
      this.tower.addHole(end, at);
      if (taker) {
        this.tower.releaseSlot(taker.end, taker.threshold);
        const slot = this.tower.assignSlot(at, AIRCRAFT[taker.visit.rotation.type].wake, taker.end);
        if (slot) {
          taker.end = slot.end;
          taker.threshold = slot.threshold;
          taker.visit.eta = Math.max(taker.visit.eta, slot.threshold + TAXI_IN_NOMINAL);
        } else {
          this.pending.splice(this.pending.indexOf(taker), 1);
        }
      }
      return at;
    }
  }

  /** Arrivals not yet on their approach give back their landing slots, `change` is made, and they are given new ones. */
  private reslot(change: () => void): void {
    for (const p of this.pending) this.tower.releaseSlot(p.end, p.threshold);
    this.pending.length = 0;
    change();
    this.schedule();
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
      // When the terminals are simulated they count people off and on, and close the doors;
      // otherwise people get off and on at a steady rate.
      if (!this.passengersElsewhere && v.deplaned < v.rotation.paxIn && this.now > v.onBlockAt + 100) v.deplaned = Math.min(v.rotation.paxIn, v.deplaned + 5 * 0.45 * type.doors);
      const boardingAt = v.etd - CONFIG.turnaround.boardingStarts[type.body] * 60;
      if (!v.boardingOpen && !v.doorsClosed && this.now >= boardingAt && v.deplaned >= v.rotation.paxIn) v.boardingOpen = true;
      if (!this.passengersElsewhere && v.boardingOpen && v.boarded < v.rotation.paxOut) v.boarded = Math.min(v.rotation.paxOut, v.boarded + 5 * 0.3 * type.doors);
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
