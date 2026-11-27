// One aircraft, from short final to the stand and back into the air.

import type { RunwayEndInfo, RunwayExit, TaxiNet } from '../airfield/net.ts';
import { arcPieces, buildPath, coveredPieces, fuselageAt, newFuselage, speedFor, type Fuselage, type Path, type Piece, type Shape } from '../airfield/path.ts';
import { newMover, type Mover, type Traffic } from '../airfield/traffic.ts';
import { CONFIG } from '../config.ts';
import type { AircraftType, Airline } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import { NOT_YET, type Visit } from './flights.ts';
import { pushPieces, pushbackOptions, type PushbackOption } from './pushback.ts';
import type { Tower } from './tower.ts';

export type Phase = 'approach' | 'landing' | 'taxiIn' | 'parked' | 'pushback' | 'starting' | 'taxiOut' | 'lineUp' | 'takeoff' | 'climb' | 'goAround' | 'gone';

/** Metres between the places along a path at which it is checked for being on a runway. */
const STRIP_STEP = 2;
/** Metres beyond each end of a runway that still count as on it. */
const STRIP_END = 40;
const TAN_GLIDE = Math.tan(CONFIG.approach.glideSlope);
/** The nose sits this far behind the lead point of its path. */
const FRONT = CONFIG.taxi.bodyMargin / 3;
/** Length of centreline a departure turns onto before stopping to line up, beyond its own length. */
const LINE_UP_RUN = 55;
/** Metres beyond its stopping distance for which an aircraft takes the ground ahead of it. */
const LOOK_AHEAD = 15;

export interface AirsideServices {
  net: TaxiNet;
  traffic: Traffic;
  tower: Tower;
  rng: Rng;
  now: number;
  /** Extra cost of using an arc: against the habitual flow, or against where others are routed. */
  arcCost(arc: number): number;
  /** Mark the arcs every other aircraft has still to taxi along, for choosing a route that meets few of them. */
  planFor(aircraft: number): void;
  /** Is someone else routed along this arc the other way? Valid after `planFor`. */
  opposed(arc: number): boolean;
  /** Is the stand empty, clear of its neighbours for this visit's aircraft, and not promised to another about to arrive? */
  standFree(stand: string, forVisit: number): boolean;
  /** Another stand for a visit whose own is taken, none of `avoid`; null if there is none. */
  otherStand(visit: Visit, avoid?: ReadonlySet<string>): string | null;
  /** Aircraft queued or on their way to depart from a runway end. */
  departuresFor(end: string): number;
  /**
   * Leave a landing slot on arrival runway end `end` empty at or soon after `after`, for a
   * departure that needs it; returns the time of the gap.
   */
  openGap(end: string, after: number): number;
  /** Can a departure facing along `arc` taxi from there to runway `end` at all, whoever is in the way? */
  leadsTo(arc: number, end: string): boolean;
  event(kind: string, text: string, aircraft: number): void;
}

interface Crossing {
  runway: string;
  /** Runway end the distance is measured from, and the distance along the runway. */
  refEnd: string;
  along: number;
}

interface Stop {
  /** Lead-point distance at which to stop. */
  s: number;
  kind: 'cross' | 'lineUp' | 'runway' | 'stand' | 'pushed';
  /** For a crossing: the runways crossed in one go, and where the tail is clear of the last. */
  crossings?: Crossing[];
  clearAt?: number;
}

/** One way of pushing back from a stand, with the path the push follows and where on it the push ends. */
export interface PushPlan {
  push: PushbackOption;
  path: Path;
  pushEnd: number;
  speed: number;
}

/** The ways of pushing an aircraft of a type back from the stand whose stop point is `standNode`. */
export function pushPlansFor(net: TaxiNet, standNode: number, type: AircraftType): PushPlan[] {
  const body = type.length + CONFIG.taxi.bodyMargin;
  // Put on the push where it stands: nose the same distance short of the stop point.
  const origin = type.length + 2 * FRONT;
  const plans: PushPlan[] = [];
  for (const push of pushbackOptions(net, standNode, body + 10)) {
    // A swing is slower than a push down the painted line.
    const speed = push.pieces ? CONFIG.taxi.pushbackSpeed * 0.7 : CONFIG.taxi.pushbackSpeed;
    const path = buildPath(net, pushPieces(net, push).map((p) => ({ ...p, speed })), { length: type.length, front: FRONT, reversing: true }, origin);
    const pushEnd = Math.min(path.total, push.joinAt + body + 9);
    if (pushEnd >= origin + 1) plans.push({ push, path, pushEnd, speed });
  }
  return plans;
}

/** The path an aircraft of a length follows along a stand's own line from the taxiway to the stop. */
export function leadInPath(net: TaxiNet, stand: string, length: number): Path | null {
  const arcs = net.standLine(stand)?.arcsIn ?? [];
  if (!arcs.length) return null;
  return buildPath(net, arcPieces(net, arcs), { length, front: FRONT, reversing: false }, 0);
}

/** A way from a runway turn-off to a stand, as a landing aircraft would follow it. */
export interface WayIn {
  exit: RunwayExit;
  arcs: number[];
  cost: number;
  /** Built when first asked for, by `wayInPath`. */
  path: Path | null;
}

/** How many of the best ways in a landing tries before it gives up on its stand. */
const WAYS_TRIED = 5;

/**
 * The ways a landing on runway end `end` could take to the stand at `standNode`, best first, as
 * many as it would try: from each turn-off it can still make, rolling at `speed` from
 * `fromThreshold` metres beyond the threshold, the route that meets nobody if there is one, else
 * the usual route. Call `svc.planFor` first, so that the routes of others are known.
 */
export function waysIn(svc: AirsideServices, end: string, stand: string, standNode: number, fromThreshold: number, speed: number): WayIn[] {
  const net = svc.net;
  const options: WayIn[] = [];
  for (const exit of net.exits(end)) {
    const run = exit.along - fromThreshold;
    const needed = Math.max(0, speed * speed - exit.speed * exit.speed) / (2 * 2.2) + 80;
    if (run < needed) continue;
    const settings = { stand, arcCost: svc.arcCost };
    const clear = svc.opposed(exit.arc) ? null : net.route([exit.arc], standNode, { ...settings, closed: svc.opposed });
    const route = clear ?? net.route([exit.arc], standNode, settings);
    if (!route) continue;
    options.push({ exit, arcs: [exit.arc, ...route.arcs], cost: run / 32 + route.seconds + (exit.angle > 1.2 ? 12 : 0) + (clear ? 0 : 600), path: null });
    if (options.length >= 8) break;
  }
  options.sort((a, b) => a.cost - b.cost);
  return options.slice(0, WAYS_TRIED);
}

/** The path of a way in for an aircraft of a type, starting on the runway behind the turn-off so the body has somewhere to be. */
export function wayInPath(net: TaxiNet, info: RunwayEndInfo, way: WayIn, type: AircraftType): Path {
  if (way.path) return way.path;
  const node = net.nodes[way.exit.node];
  const lead = type.length + CONFIG.taxi.bodyMargin + 14;
  const runUp: Piece = { pts: [node.x - info.ux * lead, node.y - info.uy * lead, node.x, node.y], speed: way.exit.speed };
  way.path = buildPath(net, [runUp, ...arcPieces(net, way.arcs)], { length: type.length, front: FRONT, reversing: false }, lead);
  return way.path;
}

/** Seconds from the landing threshold until the nose is `distance` metres beyond it. */
export function landingRollSeconds(vApp: number, distance: number): number {
  const touch = CONFIG.approach.touchdownBeyondThreshold;
  if (distance <= touch) return distance / vApp;
  const v0 = vApp - 3;
  const coast = 28;
  const a = 1.9;
  const brakeDistance = (v0 * v0 - coast * coast) / (2 * a);
  const d = distance - touch;
  if (d <= brakeDistance) return touch / vApp + (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * a * d))) / a;
  return touch / vApp + (v0 - coast) / a + (d - brakeDistance) / coast;
}

function approachSpeed(distance: number, vApp: number): number {
  const { slowFrom, slowTo, initialSpeed } = CONFIG.approach;
  if (distance >= slowFrom) return initialSpeed;
  if (distance <= slowTo) return vApp;
  return vApp + ((initialSpeed - vApp) * (distance - slowTo)) / (slowFrom - slowTo);
}

/** Seconds to fly the approach from `distance` out to the touchdown point. */
export function approachSeconds(distance: number, vApp: number): number {
  let t = 0;
  for (let d = distance; d > 0; d -= 250) t += Math.min(250, d) / approachSpeed(Math.max(0, d - 125), vApp);
  return t;
}

/** One runway as a strip of ground: its centreline from one end, and the end distances are measured from. */
interface Strip {
  runway: string;
  refEnd: string;
  x: number;
  y: number;
  ux: number;
  uy: number;
  length: number;
}

const strips = new WeakMap<TaxiNet, Strip[]>();

function stripsOf(net: TaxiNet): Strip[] {
  let list = strips.get(net);
  if (!list) {
    list = [];
    const seen = new Set<string>();
    for (const info of net.runwayEnds.values()) {
      if (seen.has(info.runway.id)) continue;
      seen.add(info.runway.id);
      list.push({ runway: info.runway.id, refEnd: info.end.name, x: info.end.x, y: info.end.y, ux: info.ux, uy: info.uy, length: info.runway.length });
    }
    strips.set(net, list);
  }
  return list;
}

/** A stretch of a path over which the fuselage is on a runway's strip. */
export interface Stretch {
  runway: string;
  refEnd: string;
  /** Distance along the runway from `refEnd` where the fuselage comes nearest its centreline. */
  along: number;
  nearest: number;
  /** Lead-point distances: the nose comes onto the strip after `enter`, the tail is off it by `leave`. -Infinity and Infinity when already on at the start, or still on at the end. */
  enter: number;
  leave: number;
}

/**
 * Where along a path, from `from` on, the fuselage is on a runway: within the strip either side of
 * its centreline and between its ends. This is the ground the tower gives out, whatever lines the
 * map draws on it: a taxiway mapped along the pavement is the runway as much as the runway is.
 */
export function runwayStretches(net: TaxiNet, path: Path, from: number): Stretch[] {
  const body = newFuselage();
  const open = new Map<string, Stretch>();
  const done: Stretch[] = [];
  const half = CONFIG.runway.strip;
  const list = stripsOf(net);
  for (let s = from; ; s = Math.min(path.total, s + STRIP_STEP)) {
    fuselageAt(path, s, body);
    for (const r of list) {
      const an = (body.nx - r.x) * r.ux + (body.ny - r.y) * r.uy;
      const cn = -(body.nx - r.x) * r.uy + (body.ny - r.y) * r.ux;
      const at = (body.tx - r.x) * r.ux + (body.ty - r.y) * r.uy;
      const ct = -(body.tx - r.x) * r.uy + (body.ty - r.y) * r.ux;
      const on = Math.min(cn, ct) < half && Math.max(cn, ct) > -half && Math.max(an, at) > -STRIP_END && Math.min(an, at) < r.length + STRIP_END;
      const current = open.get(r.runway);
      if (on) {
        const along = (body.x - r.x) * r.ux + (body.y - r.y) * r.uy;
        const nearest = Math.abs(-(body.x - r.x) * r.uy + (body.y - r.y) * r.ux);
        if (!current) open.set(r.runway, { runway: r.runway, refEnd: r.refEnd, along, nearest, enter: s <= from ? -Infinity : s - STRIP_STEP, leave: s });
        else {
          current.leave = s;
          if (nearest < current.nearest) {
            current.nearest = nearest;
            current.along = along;
          }
        }
      } else if (current) {
        // The last place still on was `leave`; the tail is off by the next.
        current.leave += STRIP_STEP;
        done.push(current);
        open.delete(r.runway);
      }
    }
    if (s >= path.total) break;
  }
  for (const current of open.values()) {
    current.leave = Infinity;
    done.push(current);
  }
  return done.sort((p, q) => p.enter - q.enter || p.leave - q.leave);
}

/** The path an aircraft of a length stands on when parked at a stand: its line, with the lead point at the stop. */
export function standPath(net: TaxiNet, stand: string, length: number): Path | null {
  const arcs = net.standLine(stand)?.arcsIn ?? [];
  if (!arcs.length) return null;
  return buildPath(net, arcPieces(net, arcs), { length, front: FRONT, reversing: false }, Infinity);
}

export class Aircraft {
  readonly id: number;
  readonly visit: Visit;
  readonly type: AircraftType;
  readonly airline: Airline;
  phase: Phase = 'approach';

  /** Pose now and one step ago, for drawing between steps. Heading is radians from east. */
  x = 0;
  y = 0;
  alt = 0;
  heading = 0;
  pitch = 0;
  bank = 0;
  px = 0;
  py = 0;
  palt = 0;
  pheading = 0;
  ppitch = 0;
  speed = 0;

  /** Runway end in use; distance to go to touchdown on approach; distance along the runway on it. */
  runwayEnd = '';
  distance = 0;
  along = 0;
  thresholdTime = 0;
  /** True while the path is being followed tail first. */
  reversing = false;
  /** When the aircraft last found itself unable to move though it wanted to; -1 while moving. */
  waitingSince = -1;
  /**
   * For the instruments: why it is standing when it wants to move, the aircraft in its way (-1 if
   * none is known) and the tile of ground in question (-1 if none).
   */
  holdKind = '';
  holdBy = -1;
  holdRes = -1;
  /** For the instruments: why its last request to start a journey was refused. */
  refusal = '';
  /** The ground of the ways in to its stand it may take, given when its approach starts, until its way is fixed. */
  wayIn: ReadonlySet<number> | null = null;
  /** What last kept it at a stop, kept until it moves. */
  private limitKind = '';
  private limitBy = -1;

  /** True once a landing has its way off the runway and on to its stand. */
  get wayFixed(): boolean {
    return this.exit !== null;
  }

  /** The ground an arrival still has to pass over to its stand: its path once fixed, else the ways in it was given. */
  wayInGround(): { has(tile: number): boolean } | null {
    if (this.phase === 'landing' || this.phase === 'taxiIn' || (this.phase === 'approach' && this.exit)) return this.mover.path?.index ?? null;
    return this.phase === 'approach' ? this.wayIn : null;
  }

  readonly mover: Mover;
  /** The aircraft's length plus a margin, for sizing the room it needs. */
  readonly body: number;

  private info: RunwayEndInfo | null = null;
  private decided = false;
  private exit: RunwayExit | null = null;
  private exitAlong = 0;
  private vacateAt = 0;
  private nextReport = 0;
  private stops: Stop[] = [];
  private crossing: Stop | null = null;
  private nextAsk = 0;
  /** A gap in the landings has been asked for and is good until this time. */
  private gapUntil = 0;
  private timer = 0;
  private departureArcs: number[] = [];
  /** Taxiway arcs the pushback runs along, tail first. */
  private pushArcs: number[] = [];
  private taxiStops: Stop[] = [];
  private lineUpNodeAlong = 0;
  private rollFrom = 0;
  private clearOfRunway = false;
  /** While parked: the ways of pushing back from the stand, and the ways out already worked out. */
  private pushPlans: PushPlan[] | null = null;
  private readonly taxiPaths = new Map<string, { path: Path; stops: Stop[]; ok: boolean }>();
  /** Since when it has been ready to push back and asking; -1 when not. */
  private readySince = -1;
  /** The path it stands on when parked, built when a failed push has to put it back there. */
  private parkedPath: Path | null = null;
  /** Stands found unreachable on this arrival: a parked neighbour is in the way in. */
  private readonly avoid = new Set<string>();
  private readonly fuse: Fuselage = newFuselage();

  constructor(id: number, visit: Visit, type: AircraftType, airline: Airline) {
    this.id = id;
    this.visit = visit;
    this.type = type;
    this.airline = airline;
    this.mover = newMover(id);
    this.body = type.length + CONFIG.taxi.bodyMargin;
  }

  private shape(reversing: boolean): Shape {
    return { length: this.type.length, front: FRONT, reversing };
  }

  /** The arcs this aircraft has still to taxi along, each in the direction it will travel it. */
  routeAhead(out: number[]): void {
    const path = this.mover.path;
    if (this.phase === 'pushback' || this.phase === 'starting') {
      // The stretch it is pushed along is taken both ways: tail first now, nose first on the way out.
      for (const arc of this.pushArcs) out.push(arc, arc ^ 1);
      for (const arc of this.departureArcs) out.push(arc);
      return;
    }
    if (!path || (this.phase !== 'taxiIn' && this.phase !== 'taxiOut' && this.phase !== 'landing' && this.phase !== 'approach')) return;
    const behind = this.mover.s - this.body;
    for (let i = 0; i < path.arcs.length; i += 1) {
      const ends = i + 1 < path.arcs.length ? path.arcStart[i + 1] : path.total;
      if (ends > behind) out.push(path.arcs[i]);
    }
  }

  private noteLimit(kind: string, by: number): void {
    this.limitKind = kind;
    this.limitBy = by;
  }

  /** Position on a runway for the tower, or null when not on one. */
  runwayPosition(): { along: number; speed: number } | null {
    if (this.phase === 'landing' || this.phase === 'takeoff' || this.phase === 'lineUp') return { along: this.along, speed: this.speed };
    if (this.phase === 'climb' && !this.clearOfRunway) return { along: this.along, speed: this.speed };
    return null;
  }

  // ---- starting points ------------------------------------------------------------------

  /** Begin on final approach to `end`, due over the threshold at `threshold`. */
  startApproach(svc: AirsideServices, end: string, threshold: number): void {
    this.phase = 'approach';
    this.runwayEnd = end;
    this.info = svc.net.runwayEnds.get(end)!;
    this.thresholdTime = threshold;
    const vApp = this.type.vApp;
    // Start as far out as puts the aircraft over the threshold on time.
    const beyond = CONFIG.approach.touchdownBeyondThreshold;
    const toGo = threshold - svc.now + beyond / vApp;
    let distance: number = CONFIG.approach.startDistance;
    while (distance > 3000 && approachSeconds(distance, vApp) > toGo) distance -= 250;
    this.distance = distance;
    this.speed = approachSpeed(distance, vApp);
    this.decided = false;
    this.visit.state = 'approach';
    this.visit.arrivalRunway = end;
    this.visit.aircraft = this.id;
    svc.tower.addInbound(this.id, end, threshold, this.type.wake);
    this.flyApproach(svc, 0);
    this.snapPose();
  }

  /** Begin parked at the visit's stand, as if it had arrived earlier. */
  startParked(svc: AirsideServices): boolean {
    const path = standPath(svc.net, this.visit.stand, this.type.length);
    if (!path || !svc.traffic.open(this.mover, path)) return false;
    svc.traffic.place(this.mover, path, svc.now);
    this.phase = 'parked';
    this.reversing = false;
    this.visit.state = 'atStand';
    this.visit.aircraft = this.id;
    if (this.visit.onBlockAt === NOT_YET) this.visit.onBlockAt = this.visit.sta;
    this.speed = 0;
    this.poseOnPath();
    this.snapPose();
    return true;
  }

  // ---- stepping -------------------------------------------------------------------------

  step(svc: AirsideServices, dt: number): void {
    this.px = this.x;
    this.py = this.y;
    this.palt = this.alt;
    this.pheading = this.heading;
    this.ppitch = this.pitch;
    switch (this.phase) {
      case 'approach':
        this.flyApproach(svc, dt);
        break;
      case 'goAround':
        this.flyGoAround(svc, dt);
        break;
      case 'landing':
        this.rollOut(svc, dt);
        break;
      case 'taxiIn':
      case 'taxiOut':
      case 'pushback':
        this.taxi(svc, dt);
        break;
      case 'starting':
        this.timer -= dt;
        if (this.timer <= 0) this.beginTaxiOut(svc);
        break;
      case 'lineUp':
        this.holdOnRunway(svc);
        break;
      case 'takeoff':
      case 'climb':
        this.flyDeparture(svc, dt);
        break;
      default:
        break;
    }
  }

  private snapPose(): void {
    this.px = this.x;
    this.py = this.y;
    this.palt = this.alt;
    this.pheading = this.heading;
    this.ppitch = this.pitch;
  }

  // ---- approach and landing -------------------------------------------------------------

  private flyApproach(svc: AirsideServices, dt: number): void {
    const info = this.info!;
    const vApp = this.type.vApp;
    const target = approachSpeed(this.distance, vApp);
    this.speed += Math.max(-1.2 * dt, Math.min(1.2 * dt, target - this.speed));
    this.distance -= this.speed * dt;
    const beyond = CONFIG.approach.touchdownBeyondThreshold;
    const touchdownAlong = info.end.displaced + beyond;
    const along = touchdownAlong - this.distance;
    this.x = info.end.x + info.ux * along;
    this.y = info.end.y + info.uy * along;
    this.heading = info.heading;
    // Down the glide path, then a flare that eases the last few metres.
    const onSlope = Math.max(0, this.distance) * TAN_GLIDE;
    const flare = CONFIG.approach.flareHeight;
    this.alt = onSlope > flare ? onSlope : flare * Math.pow(onSlope / flare, 1.6);
    this.pitch = onSlope > flare ? 0.045 : 0.045 + 0.06 * (1 - onSlope / flare);
    this.bank = 0;

    if (svc.now >= this.nextReport) {
      this.nextReport = svc.now + 4;
      const toThreshold = this.distance - beyond;
      this.thresholdTime = toThreshold > 0 ? svc.now + approachSeconds(toThreshold, vApp) : svc.now + toThreshold / vApp;
      const crossings = svc.tower
        .crossingsAlong(this.runwayEnd)
        .filter((c) => c.along - info.end.displaced < 2600)
        .map((c) => ({ across: c.across, seconds: landingRollSeconds(vApp, c.along - info.end.displaced + 70) }));
      svc.tower.updateInbound(this.id, this.runwayEnd, this.thresholdTime, crossings);
      this.visit.eta = Math.max(this.visit.eta, this.thresholdTime + 6 * 60);
    }
    if (!this.decided && this.alt <= CONFIG.approach.decisionHeight) {
      this.decided = true;
      let reason = svc.tower.mayLand(this.id, this.runwayEnd) ? '' : `runway ${this.runwayEnd} not clear`;
      // The way off the runway and on to a stand is fixed before the wheels touch: a landing that
      // could find none would be left standing on the runway with nowhere to go.
      if (!reason && !this.chooseExit(svc, CONFIG.approach.touchdownBeyondThreshold, vApp - 3, Math.max(0, this.thresholdTime - svc.now))) {
        reason = `no way off the runway (${this.refusal})`;
        const key = `no way off: ${this.refusal.replace(/#\d+/, '#')}`;
        svc.tower.goAroundReasons[key] = (svc.tower.goAroundReasons[key] ?? 0) + 1;
      }
      if (reason) {
        this.phase = 'goAround';
        this.visit.goArounds += 1;
        svc.tower.wentAround(this.id, this.runwayEnd);
        svc.event('go-around', `${this.visit.rotation.arrFlight} going around, ${reason}`, this.id);
        return;
      }
    }
    if (this.distance <= 0) {
      this.phase = 'landing';
      this.alt = 0;
      this.along = touchdownAlong - this.distance;
      this.speed = Math.min(this.speed, vApp - 3);
      this.visit.state = 'landed';
      this.visit.landedAt = svc.now;
      this.nextAsk = 0;
      svc.tower.touchedDown(this.id, this.runwayEnd);
      svc.event('landed', `${this.visit.rotation.arrFlight} landed ${this.runwayEnd}`, this.id);
    }
  }

  private flyGoAround(svc: AirsideServices, dt: number): void {
    const info = this.info!;
    this.speed = Math.min(88, this.speed + 1.6 * dt);
    this.distance -= this.speed * dt;
    this.alt += Math.min(11, 5 + this.alt * 0.04) * dt;
    this.pitch += (0.17 - this.pitch) * Math.min(1, dt * 0.8);
    const along = info.end.displaced + CONFIG.approach.touchdownBeyondThreshold - this.distance;
    this.x = info.end.x + info.ux * along;
    this.y = info.end.y + info.uy * along;
    if (along > info.runway.length + 6500) {
      this.phase = 'gone';
      // Back into the arrival flow for another try.
      this.visit.state = 'scheduled';
      this.visit.aircraft = -1;
      this.visit.eta = svc.now + svc.rng.range(11, 15) * 60;
      this.visit.delayNote = 'Go-around';
    }
  }

  /**
   * Pick where to leave the runway, fix the route to the stand, and take the ground to get off the
   * runway. Done before the wheels touch, so that no landing is ever left on a runway with nowhere
   * to go. `fromThreshold` and `speed` are where and how fast the aircraft will be when it starts
   * to roll towards a turn-off, `inSeconds` from now. False when no way off can be had.
   */
  private chooseExit(svc: AirsideServices, fromThreshold: number, speed: number, inSeconds: number): boolean {
    // A stand whose every way in runs over ground a parked aircraft rests on is passed over for
    // another; the stands nearby are often shut in by the same aircraft, so several are tried.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = this.chooseExitTo(svc, fromThreshold, speed, inSeconds);
      if (result !== 'shut in') return result === 'ok';
    }
    return false;
  }

  private chooseExitTo(svc: AirsideServices, fromThreshold: number, speed: number, inSeconds: number): 'ok' | 'no' | 'shut in' {
    const info = this.info!;
    const net = svc.net;
    const traffic = svc.traffic;
    const standNode = this.resolveStand(svc);
    if (standNode === null) return 'no';
    svc.planFor(this.id);
    let parkedInTheWay = 0;
    const tried = waysIn(svc, this.runwayEnd, this.visit.stand, standNode, fromThreshold, speed);
    this.refusal = tried.length ? '' : 'no way to the stand';
    for (const option of tried) {
      const path = wayInPath(net, info, option, this.type);
      const parked = traffic.restingOn(this.mover, path);
      if (parked !== -1) {
        this.refusal = `way in runs over ground #${parked} rests on`;
        parkedInTheWay += 1;
        continue;
      }
      if (!traffic.open(this.mover, path)) {
        this.refusal = 'turn-off is held';
        continue;
      }
      const found = this.findStops(net, path, path.origin, 'stand', info.runway.id);
      if (!found.ok || found.vacateAt <= 0) {
        this.refusal = 'no room to stop short of a runway after the turn-off';
        continue;
      }
      // The way has to be free at least far enough to get the tail off the runway, and it cannot wait.
      if (!traffic.begin(this.mover, path, null, true, svc.now) || !traffic.reserve(this.mover, found.vacateAt + 2, svc.now, true)) {
        this.refusal = `turn-off not clear of #${this.mover.blockedBy}`;
        traffic.remove(this.mover);
        continue;
      }
      this.refusal = '';
      this.mover.startAt = svc.now + inSeconds + (option.exit.along - fromThreshold) / Math.max(20, (speed + option.exit.speed) / 2);
      this.exit = option.exit;
      this.exitAlong = option.exit.along + info.end.displaced;
      this.vacateAt = found.vacateAt;
      this.stops = found.stops;
      return 'ok';
    }
    this.exit = null;
    // Every way in runs over ground a parked aircraft rests on: this stand cannot be reached now.
    if (tried.length && parkedInTheWay === tried.length) {
      this.avoid.add(this.visit.stand);
      return 'shut in';
    }
    return 'no';
  }

  /** The node of the stand to taxi to, changing stand if the planned one is taken or cannot be reached. */
  private resolveStand(svc: AirsideServices): number | null {
    if (this.avoid.has(this.visit.stand) || !svc.standFree(this.visit.stand, this.visit.id)) {
      const other = svc.otherStand(this.visit, this.avoid);
      if (other && other !== this.visit.stand) {
        svc.event('gate-change', `${this.visit.rotation.arrFlight} gate changed ${this.visit.stand} to ${other}`, this.id);
        this.visit.stand = other;
      } else if (!other) {
        // Nothing else is free: the stands found blocked are worth another look.
        this.refusal = 'no stand free';
        this.avoid.clear();
        return null;
      }
    }
    return svc.net.standNode.get(this.visit.stand) ?? null;
  }

  private rollOut(svc: AirsideServices, dt: number): void {
    const info = this.info!;
    if (!this.exit && svc.now >= this.nextAsk) {
      // Only for an aircraft that touched down without a way off, which the decision height rules out.
      this.nextAsk = svc.now + 1.5;
      this.chooseExit(svc, this.along - info.end.displaced, this.speed, 0);
    }
    const exitSpeed = this.exit ? this.exit.speed : 0;
    const remaining = this.exit ? this.exitAlong - this.along : info.runway.length - 60 - this.along;
    const allowed = Math.sqrt(exitSpeed * exitSpeed + 2 * CONFIG.runway.brakingEasy * Math.max(0, remaining));
    const coast = Math.max(exitSpeed, 28);
    let accel = 0;
    if (this.speed > allowed) accel = -Math.min(CONFIG.runway.brakingHard, (this.speed * this.speed - exitSpeed * exitSpeed) / (2 * Math.max(1, remaining)) + 0.3);
    else if (this.speed > coast) accel = -1.9;
    else if (this.speed < Math.min(coast, allowed) - 0.5 && remaining > 5) accel = 0.6;
    this.speed = Math.max(0, this.speed + accel * dt);
    this.along += this.speed * dt;
    this.x = info.end.x + info.ux * this.along;
    this.y = info.end.y + info.uy * this.along;
    this.heading = info.heading;
    this.pitch += (0 - this.pitch) * Math.min(1, dt * 1.5);
    if (this.exit && this.along >= this.exitAlong) {
      // Onto the turn-off: from here the aircraft follows its path. The runway places it by its
      // middle and the path by a lead point ahead of its nose: carry it on from exactly where it is.
      this.phase = 'taxiIn';
      const [wasX, wasY] = [this.x, this.y];
      this.mover.s = this.body + 14 + (this.along - this.exitAlong);
      this.poseOnPath();
      this.mover.s += (wasX - this.x) * info.ux + (wasY - this.y) * info.uy;
      this.poseOnPath();
      this.mover.v = this.speed;
      this.mover.startAt = svc.now;
      this.reversing = false;
      this.nextAsk = svc.now;
    }
  }

  // ---- taxiing --------------------------------------------------------------------------

  /**
   * Where the path makes the aircraft stop for the tower: with its nose short of each runway strip
   * it comes onto, and at its end. `from` is where the aircraft is put on the path. A stretch it is
   * on from the start can only be the roll-out of a landing on `own`; it ends at `vacateAt`, with
   * the tail off the strip. `ok` is false when the path cannot be followed under the tower's rules:
   * it starts on another runway, ends on one it was not cleared to stay on, or has no room to stop
   * short of a runway it must stop for.
   */
  private findStops(net: TaxiNet, path: Path, from: number, purpose: 'stand' | 'depart', own: string | null): { stops: Stop[]; vacateAt: number; ok: boolean } {
    const stops: Stop[] = [];
    let vacateAt = 0;
    let ok = true;
    let earliest = from;
    for (const stretch of runwayStretches(net, path, from)) {
      if (stretch.enter === -Infinity) {
        if (stretch.runway !== own || stretch.leave === Infinity) ok = false;
        vacateAt = Math.max(vacateAt, stretch.leave);
        earliest = Math.max(earliest, stretch.leave);
        continue;
      }
      const holdAt = stretch.enter - 1;
      const crossing: Crossing = { runway: stretch.runway, refEnd: stretch.refEnd, along: stretch.along };
      if (stretch.leave === Infinity) {
        // Only a departure ends on a runway, the one it lines up on.
        if (purpose !== 'depart' || holdAt < earliest + 2) ok = false;
        stops.push({ s: Math.max(holdAt, earliest + 2), kind: 'lineUp' });
        break;
      }
      const last = stops[stops.length - 1];
      if (last && last.kind === 'cross' && holdAt < last.clearAt! + 2) {
        // No room to stop between two runways: cross both in one go.
        last.crossings!.push(crossing);
        last.clearAt = Math.max(last.clearAt!, stretch.leave);
      } else {
        if (holdAt < earliest + 2) ok = false;
        stops.push({ s: Math.max(holdAt, earliest + 2), kind: 'cross', crossings: [crossing], clearAt: stretch.leave });
      }
      earliest = Math.max(earliest, stretch.leave);
    }
    stops.push({ s: path.total, kind: purpose === 'stand' ? 'stand' : 'runway' });
    return { stops, vacateAt, ok };
  }

  private taxi(svc: AirsideServices, dt: number): void {
    const mover = this.mover;
    const path = mover.path!;
    const stop = this.stops[0];
    const stopAt = stop ? stop.s : path.total;
    // Take the ground ahead as far as it takes to stop, and a little more.
    const reach = mover.s + (mover.v * mover.v) / (2 * CONFIG.taxi.decel) + LOOK_AHEAD;
    const limit = svc.traffic.limit(mover, Math.min(stopAt, reach), svc.now);
    const cap = this.phase === 'pushback' ? CONFIG.taxi.pushbackSpeed : Infinity;
    const target = Math.min(cap, speedFor(path, mover.s, limit, CONFIG.taxi.decel));
    mover.v += Math.max(-2.2 * dt, Math.min(CONFIG.taxi.accel * dt, target - mover.v));
    if (mover.v < 0.05 && target < 0.05) mover.v = 0;
    mover.s = Math.min(limit, mover.s + mover.v * dt);
    if (mover.s >= limit - 0.02) mover.v = Math.min(mover.v, target);
    this.speed = mover.v;
    svc.traffic.release(mover);
    this.poseOnPath();

    if (this.vacateAt > 0 && mover.s >= this.vacateAt) {
      this.vacateAt = 0;
      svc.tower.vacated(this.id, this.runwayEnd);
    }
    if (this.crossing && mover.s >= this.crossing.clearAt!) {
      for (const c of this.crossing.crossings!) svc.tower.crossed(this.id, c.runway);
      this.crossing = null;
    }
    if (mover.v < 0.2 && mover.s < path.total - 0.5) {
      if (this.waitingSince < 0) this.waitingSince = svc.now;
      const ground = mover.s < stopAt - 0.6 ? svc.traffic.waitingOn(mover) : null;
      if (svc.now < mover.startAt) {
        this.holdKind = 'planned start';
        this.holdBy = -1;
        this.holdRes = -1;
      } else if (ground) {
        this.holdKind = svc.traffic.holderOf(ground.res) === ground.by ? 'ground held' : 'right of way';
        this.holdBy = ground.by;
        this.holdRes = ground.res;
      } else {
        this.holdKind = this.limitKind || 'stop';
        this.holdBy = this.limitBy;
        this.holdRes = -1;
      }
    } else {
      this.waitingSince = -1;
      this.holdKind = '';
      this.holdBy = -1;
      this.holdRes = -1;
      if (mover.v > 0.5) this.limitKind = '';
    }
    // Standing time is kept as a whole number of stretches: each is added when it ends.
    if (this.waitingSince < 0 && mover.waitingSince >= 0) mover.stood += svc.now - mover.waitingSince;
    mover.waitingSince = this.waitingSince;
    if (stop && mover.v === 0 && mover.s >= stop.s - 0.6) this.atStop(svc, stop);
  }

  private atStop(svc: AirsideServices, stop: Stop): void {
    const mover = this.mover;
    switch (stop.kind) {
      case 'stand':
        this.stops = [];
        this.phase = 'parked';
        svc.traffic.finish(mover);
        // Parked, it rests on its stand's ground and no more, which is what its neighbours are planned around.
        this.parkedPath = standPath(svc.net, this.visit.stand, this.type.length);
        if (this.parkedPath) svc.traffic.trim(mover, this.parkedPath);
        this.waitingSince = -1;
        mover.waitingSince = -1;
        this.avoid.clear();
        this.visit.state = 'atStand';
        this.visit.onBlockAt = svc.now;
        this.visit.eta = svc.now;
        svc.event('on-block', `${this.visit.rotation.arrFlight} on stand ${this.visit.stand}`, this.id);
        return;
      case 'pushed':
        this.stops = [];
        this.phase = 'starting';
        this.waitingSince = -1;
        mover.waitingSince = -1;
        this.timer = svc.rng.range(CONFIG.taxi.engineStart[0], CONFIG.taxi.engineStart[1]);
        mover.pauseUntil = svc.now + this.timer;
        return;
      case 'runway': {
        const info = this.info!;
        this.stops = [];
        this.phase = 'lineUp';
        this.waitingSince = -1;
        mover.waitingSince = -1;
        this.along = this.lineUpNodeAlong + this.body + LINE_UP_RUN - FRONT - this.type.length / 2;
        this.rollFrom = this.along;
        this.speed = 0;
        this.heading = info.heading;
        this.clearOfRunway = false;
        svc.tower.linedUp(this.id, this.runwayEnd);
        return;
      }
      default:
        break;
    }
    if (svc.now < this.nextAsk) return;
    this.nextAsk = svc.now + 3;
    if (stop.kind === 'cross') {
      const granted: Crossing[] = [];
      for (const c of stop.crossings!) {
        if (!svc.tower.mayCross(this.id, c.runway, c.refEnd, c.along, svc.now)) {
          this.noteLimit(`cross: ${svc.tower.denial}`, svc.tower.deniedBy);
          break;
        }
        granted.push(c);
      }
      let room = false;
      if (granted.length === stop.crossings!.length) {
        // Never onto a runway without the ground to get off it on the far side.
        room = svc.traffic.reserve(mover, stop.clearAt! + 2, svc.now, false);
        if (!room) this.noteLimit('cross: no room beyond the runway', mover.blockedBy);
        // With the tower's leave in hand it wants its ground now: nobody new is let past it.
        mover.firm = !room;
      }
      if (!room) {
        // Not every runway is free, or there is no room on the far side: give them back and wait.
        for (const c of granted) svc.tower.crossed(this.id, c.runway);
        return;
      }
      this.crossing = stop;
      this.stops.shift();
      this.nextAsk = svc.now;
      return;
    }
    if (stop.kind === 'lineUp') {
      // The same time on the runway the take-off clearance will ask for, after the time it takes to
      // roll onto the runway and stop there: cleared any later, it would stand lined up in the way
      // of the next landing.
      const rollSeconds = (this.type.vRot + 4) / CONFIG.runway.takeoffAccel[this.type.body] + 6;
      const lineUpSeconds = (mover.path!.total - mover.s) / 4 + 12;
      if (!svc.tower.mayLineUp(this.id, this.runwayEnd, svc.now, lineUpSeconds, rollSeconds)) {
        this.noteLimit(`line up: ${svc.tower.denial}`, svc.tower.deniedBy);
        // The gap asked for on the way out has gone by: ask for another.
        const landing = svc.tower.arrivalEndOn(this.runwayEnd);
        if (landing && svc.now > this.gapUntil) this.gapUntil = svc.openGap(landing, svc.now + 120) + 150;
        return;
      }
      if (!svc.traffic.reserve(mover, mover.path!.total, svc.now, false)) {
        this.noteLimit('line up: no room on the runway', mover.blockedBy);
        svc.tower.cancelLineUp(this.id, this.runwayEnd, svc.now);
        return;
      }
      this.stops.shift();
      this.nextAsk = svc.now;
    }
  }

  // ---- parked, pushback, taxi out -------------------------------------------------------

  /** Called while parked, once the flight is ready to go: push back if the way is clear. */
  tryPushback(svc: AirsideServices): boolean {
    if (this.phase !== 'parked' || svc.now < this.nextAsk) return false;
    this.nextAsk = svc.now + 12;
    const standNode = svc.net.standNode.get(this.visit.stand);
    if (standNode === undefined) return false;
    if (this.readySince < 0) this.readySince = svc.now;
    // The ways of pushing back from this stand, each with the path it follows: worked out once.
    this.pushPlans ??= pushPlansFor(svc.net, standNode, this.type);
    // The runway with the shortest queue first. Another of the same kind only when there is no way
    // to that one at all from here: a way that is only blocked for now is waited for.
    const planned = { done: false };
    for (const end of svc.tower.departureEnds(this.type.body, (e) => svc.departuresFor(e))) {
      if (svc.departuresFor(end) >= CONFIG.taxi.queueLimit) {
        this.refusal = 'runway queue full';
        return false;
      }
      const result = this.pushTo(svc, end, planned);
      if (result !== 'no way') return result === 'pushed';
    }
    return false;
  }

  /** Push back for runway `end` if the way is clear: 'no way' when no way of pushing back leads there. */
  private pushTo(svc: AirsideServices, end: string, planned: { done: boolean }): 'pushed' | 'held' | 'no way' {
    const net = svc.net;
    const traffic = svc.traffic;
    const info = net.runwayEnds.get(end);
    const lineUps = new Set(net.lineUpNodes(end).map((n) => n.node));
    if (!info || !lineUps.size || !this.pushPlans) return 'no way';
    const goal = (node: number, arc: number): boolean => lineUps.has(node) && net.arcBlock(arc).kind === 'twy';
    const origin = this.type.length + 2 * FRONT;
    this.refusal = this.pushPlans.length ? '' : 'no way to push back';
    const options: { plan: PushPlan; route: number[]; cost: number }[] = [];
    // Whether any way of pushing back leads to the runway, free or not.
    let leads = false;
    for (const plan of this.pushPlans) {
      // A push that is blocked for now, and leads to this runway once it is clear, is waited for;
      // one that leads elsewhere is no way to this runway, blocked or not.
      const parked = traffic.restingOn(this.mover, plan.path, plan.pushEnd);
      if (parked !== -1) {
        this.refusal = `push runs over ground #${parked} rests on`;
        if (svc.leadsTo(plan.push.forward, end)) leads = true;
        continue;
      }
      const held = traffic.heldAhead(this.mover, plan.path, plan.pushEnd);
      if (held !== -1) {
        this.refusal = `push not clear of #${held}`;
        if (svc.leadsTo(plan.push.forward, end)) leads = true;
        continue;
      }
      if (!planned.done) {
        svc.planFor(this.id);
        planned.done = true;
      }
      // A way out that meets nobody if there is one; else the usual way, waiting where it must.
      const settings = { arcCost: svc.arcCost, stand: this.visit.stand };
      const clear = net.route([plan.push.forward], goal, { ...settings, closed: svc.opposed });
      const route = clear ?? net.route([plan.push.forward], goal, settings);
      if (!route || !route.arcs.length) {
        if (!this.refusal) this.refusal = 'no way out';
        continue;
      }
      leads = true;
      // A long push costs its own time and keeps the taxilane shut while it lasts.
      options.push({ plan, route: route.arcs, cost: route.seconds + (2 * (plan.push.joinAt + this.body)) / CONFIG.taxi.pushbackSpeed + (clear ? 0 : 300) });
    }
    options.sort((a, b) => a.cost - b.cost);
    for (const option of options.slice(0, 3)) {
      const { push, path: pushPath, pushEnd, speed } = option.plan;
      // The way out: from the tail forward through the nose to the taxiway junction, then the
      // route to the runway and a short way down its centreline.
      const last = net.nodes[net.arcTo(option.route[option.route.length - 1])];
      const run = this.body + LINE_UP_RUN;
      const key = `${this.pushPlans.indexOf(option.plan)}:${end}:${option.route.join(',')}`;
      let way = this.taxiPaths.get(key);
      if (!way) {
        const covered = coveredPieces(net, pushPath, pushEnd, push.joinAt, 12);
        const onRunway: Piece = { pts: [last.x, last.y, last.x + info.ux * run, last.y + info.uy * run], speed: 8 };
        const built = buildPath(net, [...covered, ...(push.link ?? []), ...arcPieces(net, option.route), onRunway], this.shape(false), origin);
        const found = this.findStops(net, built, origin, 'depart', null);
        way = { path: built, stops: found.stops, ok: found.ok };
        if (this.taxiPaths.size > 12) this.taxiPaths.clear();
        this.taxiPaths.set(key, way);
      }
      if (!way.ok) {
        this.refusal = 'way out has no room to stop short of a runway';
        continue;
      }
      const taxiPath = way.path;
      const parkedOut = traffic.restingOn(this.mover, taxiPath);
      if (parkedOut !== -1) {
        this.refusal = `way out runs over ground #${parkedOut} rests on`;
        continue;
      }
      const begun = traffic.begin(this.mover, pushPath, taxiPath, false, svc.now);
      this.mover.pauseUntil = svc.now + (pushEnd - origin) / speed + CONFIG.taxi.engineStart[0];
      this.mover.askingSince = this.readySince;
      // The whole push at once, or stay on the stand: nobody stops half way out of a gate.
      if (!begun || !traffic.reserve(this.mover, pushEnd, svc.now, false)) {
        this.refusal = `push not clear of #${this.mover.blockedBy}`;
        this.parkedPath ??= standPath(net, this.visit.stand, this.type.length)!;
        traffic.place(this.mover, this.parkedPath, svc.now);
        this.mover.askingSince = -1;
        continue;
      }
      this.refusal = '';
      this.readySince = -1;
      this.mover.askingSince = -1;
      this.phase = 'pushback';
      this.reversing = true;
      this.runwayEnd = end;
      this.info = info;
      this.stops = [{ s: pushEnd, kind: 'pushed' }];
      this.departureArcs = option.route;
      this.pushArcs = push.out.filter((arc) => net.arcBlock(arc).kind === 'twy');
      this.pushPlans = null;
      this.parkedPath = null;
      this.taxiPaths.clear();
      this.taxiStops = [...way.stops];
      if (!this.taxiStops.some((s) => s.kind === 'lineUp')) this.taxiStops.splice(this.taxiStops.length - 1, 0, { s: Math.max(origin + 1, taxiPath.total - run - CONFIG.runway.holdDistance), kind: 'lineUp' });
      this.lineUpNodeAlong = (last.x - info.end.x) * info.ux + (last.y - info.end.y) * info.uy;
      this.visit.state = 'pushback';
      this.visit.offBlockAt = svc.now;
      this.visit.departureRunway = end;
      this.nextAsk = svc.now;
      svc.event('pushback', `${this.visit.rotation.depFlight} pushing back from ${this.visit.stand} for runway ${end}`, this.id);
      return 'pushed';
    }
    return leads ? 'held' : 'no way';
  }

  private beginTaxiOut(svc: AirsideServices): void {
    const mover = this.mover;
    svc.traffic.advance(mover, svc.now);
    this.reversing = false;
    this.phase = 'taxiOut';
    this.visit.state = 'taxiOut';
    this.stops = this.taxiStops;
    this.taxiStops = [];
    this.nextAsk = svc.now;
    // A departure from a runway that also takes landings, either way, needs a hole in the arrivals.
    const landing = svc.tower.arrivalEndOn(this.runwayEnd);
    if (landing) {
      const lineUp = this.stops.find((s) => s.kind === 'lineUp')!;
      this.gapUntil = svc.openGap(landing, svc.now + (lineUp.s - mover.s) / 11 + 40) + 150;
    }
  }

  /** Lined up and waiting: ask to go. */
  private holdOnRunway(svc: AirsideServices): void {
    if (svc.now < this.nextAsk) return;
    this.nextAsk = svc.now + 1;
    const accel = CONFIG.runway.takeoffAccel[this.type.body];
    const toRotate = (this.type.vRot + 4) / accel;
    const crossings = svc.tower
      .crossingsAlong(this.runwayEnd)
      .filter((c) => c.along > this.along)
      .map((c) => ({ across: c.across, from: Math.sqrt((2 * Math.max(1, c.along - 80 - this.along)) / accel), to: Math.sqrt((2 * (c.along + 80 - this.along)) / accel) }));
    if (!svc.tower.mayTakeOff(this.id, this.runwayEnd, svc.now, this.type.wake, toRotate + 6, crossings)) {
      this.refusal = `take off: ${svc.tower.denial}`;
      return;
    }
    this.refusal = '';
    this.phase = 'takeoff';
    this.visit.state = 'airborne';
    svc.event('takeoff', `${this.visit.rotation.depFlight} cleared for take-off ${this.runwayEnd}`, this.id);
  }

  private flyDeparture(svc: AirsideServices, dt: number): void {
    const info = this.info!;
    const accel = CONFIG.runway.takeoffAccel[this.type.body];
    if (this.phase === 'takeoff') {
      this.speed += accel * dt;
      if (this.speed >= this.type.vRot) this.pitch = Math.min(0.2, this.pitch + 0.055 * dt);
      if (this.speed >= this.type.vRot + 4) {
        this.phase = 'climb';
        this.visit.airborneAt = svc.now;
      }
    } else {
      this.speed = Math.min(98, this.speed + 1.1 * dt);
      this.pitch = Math.min(0.24, this.pitch + 0.03 * dt);
      this.alt += Math.min(CONFIG.runway.climbRate, 2 + this.alt * 0.25) * dt;
    }
    this.along += this.speed * Math.cos(Math.min(0.2, this.pitch)) * dt;
    this.x = info.end.x + info.ux * this.along;
    this.y = info.end.y + info.uy * this.along;
    this.heading = info.heading;
    // The ground it lined up on is its own until the tail has rolled well off it.
    if (this.mover.path && this.along - this.rollFrom > this.type.length + 25) svc.traffic.remove(this.mover);
    if (!this.clearOfRunway && this.along > info.runway.length + 350) {
      this.clearOfRunway = true;
      svc.tower.departed(this.id, this.runwayEnd);
    }
    if (this.along > info.runway.length + 9000 || this.alt > 1500) {
      if (!this.clearOfRunway) svc.tower.departed(this.id, this.runwayEnd);
      this.phase = 'gone';
      this.visit.state = 'done';
    }
  }

  /** Put the aircraft where its path says: nose wheel and main wheels on the line. */
  private poseOnPath(): void {
    const mover = this.mover;
    const path = mover.path;
    if (!path) return;
    const at = fuselageAt(path, mover.s, this.fuse);
    if (at.ok) this.heading = at.heading;
    this.x = at.x;
    this.y = at.y;
    this.alt = 0;
    this.pitch = 0;
    this.bank = 0;
  }
}
