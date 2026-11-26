// One aircraft, from short final to the stand and back into the air.

import { MAX_TURN, type RunwayEndInfo, type RunwayExit, type TaxiNet } from '../airfield/net.ts';
import { arcPieces, buildPath, coveredPieces, pointAt, speedFor, type Path, type PathPoint, type Piece } from '../airfield/path.ts';
import { newMover, type Mover, type Traffic } from '../airfield/traffic.ts';
import { CONFIG } from '../config.ts';
import type { AircraftType, Airline } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import type { Visit } from './flights.ts';
import { pushPieces, pushbackOptions, type PushbackOption } from './pushback.ts';
import type { Tower } from './tower.ts';

export type Phase = 'approach' | 'landing' | 'taxiIn' | 'parked' | 'pushback' | 'starting' | 'taxiOut' | 'lineUp' | 'takeoff' | 'climb' | 'goAround' | 'gone';

/** Distance from a runway centreline at which a tail is clear of the pavement. */
const RUNWAY_VACATED = 26;
const TAN_GLIDE = Math.tan(CONFIG.approach.glideSlope);
/** The nose sits this far behind the lead point of the reserved ground. */
const FRONT = CONFIG.taxi.bodyMargin / 3;
/** Length of centreline a departure turns onto before stopping to line up, beyond its own length. */
const LINE_UP_RUN = 55;

export interface AirsideServices {
  net: TaxiNet;
  traffic: Traffic;
  tower: Tower;
  rng: Rng;
  now: number;
  /** Extra cost of using an arc: against the habitual flow, or against where others are routed. */
  arcCost(arc: number): number;
  /** Count where everyone but one aircraft is routed, before that aircraft plans a route. */
  planFor(aircraft: number): void;
  /** Is someone else routed along this arc the other way? Valid after `planFor`. */
  opposed(arc: number): boolean;
  /** Is the stand empty and not promised to another aircraft about to arrive? */
  standFree(stand: string, forVisit: number): boolean;
  /** Another stand for a visit whose own is taken; null if there is none. */
  otherStand(visit: Visit): string | null;
  /** Aircraft queued or on their way to depart from a runway end. */
  departuresFor(end: string): number;
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

  readonly mover: Mover;
  /** Ground reserved along the path: the aircraft plus a margin. */
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
  private timer = 0;
  private departureArcs: number[] = [];
  private departureFrom = 0;
  private departureLink: Piece[] = [];
  private parkedPath: Path | null = null;
  private parkedS = 0;
  private lineUpNodeAlong = 0;
  private clearOfRunway = false;
  private readonly point: PathPoint = { x: 0, y: 0, heading: 0 };
  private readonly point2: PathPoint = { x: 0, y: 0, heading: 0 };

  constructor(id: number, visit: Visit, type: AircraftType, airline: Airline) {
    this.id = id;
    this.visit = visit;
    this.type = type;
    this.airline = airline;
    this.mover = newMover(id);
    this.body = type.length + CONFIG.taxi.bodyMargin;
  }

  /** Add the arcs this aircraft still means to taxi along, for others planning round it. */
  routeAhead(out: number[]): void {
    if (this.phase === 'pushback' || this.phase === 'starting') {
      for (const arc of this.departureArcs) out.push(arc);
      return;
    }
    const path = this.mover.path;
    if (!path || (this.phase !== 'taxiIn' && this.phase !== 'taxiOut' && this.phase !== 'landing')) return;
    const behind = this.mover.s - this.body;
    for (let i = 0; i < path.arcs.length; i += 1) {
      const ends = i + 1 < path.arcs.length ? path.arcStart[i + 1] : path.total;
      if (ends > behind) out.push(path.arcs[i]);
    }
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
    const node = svc.net.standNode.get(this.visit.stand);
    if (node === undefined) return false;
    // The lead-in the aircraft would have come down: walk back from the stop point.
    const arcs = leadIn(svc.net, node, this.body + 20);
    if (!arcs.length) return false;
    const path = buildPath(svc.net, arcPieces(svc.net, arcs), this.body);
    svc.traffic.place(this.mover, path, path.total, svc.now);
    this.parkedPath = path;
    this.parkedS = path.total;
    this.phase = 'parked';
    this.mover.turnsBack = true;
    this.reversing = false;
    this.visit.state = 'atStand';
    this.visit.aircraft = this.id;
    if (this.visit.onBlockAt < 0) this.visit.onBlockAt = this.visit.sta;
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
      if (!svc.tower.mayLand(this.id, this.runwayEnd)) {
        this.phase = 'goAround';
        this.visit.goArounds += 1;
        svc.tower.wentAround(this.id, this.runwayEnd);
        svc.event('go-around', `${this.visit.rotation.arrFlight} going around, runway ${this.runwayEnd} not clear`, this.id);
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
      this.exit = null;
      this.nextAsk = 0;
      svc.tower.touchedDown(this.id, this.runwayEnd);
      svc.event('landed', `${this.visit.rotation.arrFlight} landed ${this.runwayEnd}`, this.id);
      this.chooseExit(svc);
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

  /** Pick where to leave the runway and reserve the way off it. */
  private chooseExit(svc: AirsideServices): void {
    const info = this.info!;
    const net = svc.net;
    const standNode = this.resolveStand(svc);
    if (standNode === null) return;
    svc.planFor(this.id);
    const fromThreshold = this.along - info.end.displaced;
    const options: { exit: RunwayExit; arcs: number[]; cost: number }[] = [];
    for (const exit of net.exits(this.runwayEnd)) {
      const run = exit.along - fromThreshold;
      const needed = Math.max(0, this.speed * this.speed - exit.speed * exit.speed) / (2 * 2.2) + 80;
      if (run < needed) continue;
      const route = net.route([exit.arc], standNode, { stand: this.visit.stand, arcCost: svc.arcCost });
      if (!route) continue;
      options.push({ exit, arcs: [exit.arc, ...route.arcs], cost: run / 32 + route.seconds + (exit.angle > 1.2 ? 12 : 0) });
      if (options.length >= 8) break;
    }
    options.sort((a, b) => a.cost - b.cost);
    for (const option of options.slice(0, 5)) {
      const node = net.nodes[option.exit.node];
      // Start the path on the runway behind the turn-off, so the body has somewhere to be.
      const lead = this.body + 14;
      const runUp: Piece = { pts: [node.x - info.ux * lead, node.y - info.uy * lead, node.x, node.y], speed: option.exit.speed };
      const path = buildPath(net, [runUp, ...arcPieces(net, option.arcs)], this.body);
      const first = path.spans.find((sp) => sp.res < net.blocks.length);
      if (first && svc.traffic.holder(first.res) !== -1) continue;
      const vacateAt = lead + RUNWAY_VACATED + FRONT + this.type.length;
      const stops = this.findStops(net, path, vacateAt, 'stand');
      // Up to its first stop the aircraft will be standing in the way of anything coming the
      // other way, between two runways as likely as not: never turn off into someone's route.
      let against = false;
      for (let i = 0; i < path.arcs.length && path.arcStart[i] < stops[0].s; i += 1) if (svc.opposed(path.arcs[i])) against = true;
      if (against) continue;
      svc.traffic.place(this.mover, path, lead, svc.now);
      this.mover.turnsBack = false;
      this.mover.startAt = svc.now + (option.exit.along - fromThreshold) / Math.max(20, (this.speed + option.exit.speed) / 2);
      // All the way to the first stop if the plan allows; if not, at least clear of the runway.
      let result = svc.traffic.clear(this.mover, stops[0].s, svc.now, 0, false);
      if (!result.ok) result = svc.traffic.clear(this.mover, Math.min(stops[0].s, vacateAt + 30), svc.now, 0, false);
      if (!result.ok) {
        svc.traffic.remove(this.mover);
        continue;
      }
      this.exit = option.exit;
      this.exitAlong = option.exit.along + info.end.displaced;
      this.vacateAt = vacateAt;
      this.stops = stops;
      return;
    }
    this.exit = null;
  }

  /** The node of the stand to taxi to, changing stand if the planned one is taken. */
  private resolveStand(svc: AirsideServices): number | null {
    if (!svc.standFree(this.visit.stand, this.visit.id)) {
      const other = svc.otherStand(this.visit);
      if (other && other !== this.visit.stand) {
        svc.event('gate-change', `${this.visit.rotation.arrFlight} gate changed ${this.visit.stand} to ${other}`, this.id);
        this.visit.stand = other;
      }
    }
    return svc.net.standNode.get(this.visit.stand) ?? null;
  }

  private rollOut(svc: AirsideServices, dt: number): void {
    const info = this.info!;
    if (!this.exit && svc.now >= this.nextAsk) {
      this.nextAsk = svc.now + 1.5;
      this.chooseExit(svc);
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
      // Onto the turn-off: from here the aircraft follows its path.
      this.phase = 'taxiIn';
      this.mover.s = this.body + 14 + (this.along - this.exitAlong);
      this.mover.v = this.speed;
      this.mover.startAt = svc.now;
      this.reversing = false;
      this.nextAsk = svc.now;
    }
  }

  // ---- taxiing --------------------------------------------------------------------------

  /**
   * Where the path makes the aircraft stop for someone's permission: short of each runway it
   * crosses, and at its end. `from` is the first distance at which a stop may be put.
   */
  private findStops(net: TaxiNet, path: Path, from: number, purpose: 'stand' | 'depart'): Stop[] {
    const stops: Stop[] = [];
    let earliest = from;
    const count = path.arcs.length;
    for (let i = 0; i < count; i += 1) {
      const arcEnd = path.arcStart[i] + net.arcBlock(path.arcs[i]).len;
      if (arcEnd <= from + 1) continue;
      const node = net.nodes[net.arcTo(path.arcs[i])];
      if (!node.rwy.length) continue;
      // The mapped hold bar before this runway, else a set distance short of the centreline.
      let holdAt = arcEnd - CONFIG.runway.holdDistance;
      for (let k = i; k >= 0 && path.arcStart[k] > arcEnd - 190; k -= 1) {
        if (net.nodes[net.arcFrom(path.arcs[k])].hold && path.arcStart[k] < arcEnd - 40) {
          holdAt = path.arcStart[k] - 2;
          break;
        }
      }
      if (i === count - 1 && purpose === 'depart') {
        stops.push({ s: Math.max(holdAt, earliest + 2), kind: 'lineUp' });
        break;
      }
      const clearAt = arcEnd + RUNWAY_VACATED + FRONT + this.type.length;
      const crossings: Crossing[] = node.rwy.map((runway) => {
        const ref = [...net.runwayEnds.values()].find((e) => e.runway.id === runway)!;
        return { runway, refEnd: ref.end.name, along: (node.x - ref.end.x) * ref.ux + (node.y - ref.end.y) * ref.uy };
      });
      const last = stops[stops.length - 1];
      if (last && last.kind === 'cross' && holdAt < last.clearAt! + 2) {
        // No room to stop between two runways: cross both in one go.
        last.crossings!.push(...crossings);
        last.clearAt = clearAt;
      } else {
        stops.push({ s: Math.max(holdAt, earliest + 2), kind: 'cross', crossings, clearAt });
      }
      earliest = clearAt;
    }
    stops.push({ s: path.total, kind: purpose === 'stand' ? 'stand' : 'runway' });
    return stops;
  }

  private taxi(svc: AirsideServices, dt: number): void {
    const mover = this.mover;
    const path = mover.path!;
    this.manageClearance(svc);
    const limit = svc.traffic.limit(mover, svc.now);
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
    } else {
      this.waitingSince = -1;
    }
    const stop = this.stops[0];
    if (stop && mover.v === 0 && mover.s >= stop.s - 0.6) this.atStop(svc, stop);
  }

  /** Keep asking for the way ahead, far enough in advance not to brake for nothing. */
  private manageClearance(svc: AirsideServices): void {
    const mover = this.mover;
    const stop = this.stops[0];
    if (!stop || svc.now < this.nextAsk) return;
    if (mover.end >= stop.s - 0.05) return;
    const braking = (mover.v * mover.v) / (2 * CONFIG.taxi.decel) + 45;
    if (mover.end - mover.s > braking) return;
    const { result } = svc.traffic.clearAsFarAs(mover, stop.s, svc.now, 45, false);
    this.nextAsk = svc.now + (result.ok ? 1 : CONFIG.taxi.retry);
  }

  private atStop(svc: AirsideServices, stop: Stop): void {
    const mover = this.mover;
    switch (stop.kind) {
      case 'stand':
        this.stops = [];
        this.phase = 'parked';
        this.mover.turnsBack = true;
        this.parkedPath = mover.path;
        this.parkedS = mover.s;
        this.waitingSince = -1;
        this.visit.state = 'atStand';
        this.visit.onBlockAt = svc.now;
        this.visit.eta = svc.now;
        svc.event('on-block', `${this.visit.rotation.arrFlight} on stand ${this.visit.stand}`, this.id);
        return;
      case 'pushed':
        this.stops = [];
        this.phase = 'starting';
        this.mover.turnsBack = true;
        this.waitingSince = -1;
        this.timer = svc.rng.range(CONFIG.taxi.engineStart[0], CONFIG.taxi.engineStart[1]);
        return;
      case 'runway': {
        const info = this.info!;
        this.stops = [];
        this.phase = 'lineUp';
        this.waitingSince = -1;
        this.along = this.lineUpNodeAlong + this.body + LINE_UP_RUN - FRONT - this.type.length / 2;
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
        if (!svc.tower.mayCross(this.id, c.runway, c.refEnd, c.along, svc.now)) break;
        granted.push(c);
      }
      const next = this.stops[1];
      if (granted.length === stop.crossings!.length) svc.traffic.clearAsFarAs(mover, next ? next.s : mover.path!.total, svc.now, 0, false);
      if (granted.length < stop.crossings!.length || mover.end < stop.clearAt! - 0.5) {
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
      const rollSeconds = Math.sqrt((2 * 1500) / CONFIG.runway.takeoffAccel[this.type.body]) + 8;
      if (!svc.tower.mayLineUp(this.id, this.runwayEnd, svc.now, 42, rollSeconds)) return;
      const result = svc.traffic.clear(mover, mover.path!.total, svc.now, 0, false);
      if (!result.ok) {
        svc.tower.cancelLineUp(this.id, this.runwayEnd);
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
    svc.planFor(this.id);
    const net = svc.net;
    const end = svc.tower.departureEnd(this.type.body, (e) => svc.departuresFor(e));
    if (svc.departuresFor(end) >= CONFIG.taxi.queueLimit) return false;
    const standNode = net.standNode.get(this.visit.stand);
    const info = net.runwayEnds.get(end);
    if (standNode === undefined || !info) return false;
    const lineUps = new Set(net.lineUpNodes(end).map((n) => n.node));
    if (!lineUps.size) return false;
    const goal = (node: number, arc: number): boolean => lineUps.has(node) && net.arcBlock(arc).kind === 'twy';

    const options: { push: PushbackOption; joinAt: number; route: number[]; cost: number }[] = [];
    for (const push of pushbackOptions(net, standNode, this.body + 10)) {
      const route = net.route([push.forward], goal, { arcCost: svc.arcCost, stand: this.visit.stand });
      if (!route || !route.arcs.length) continue;
      // A long push costs its own time and keeps the taxilane shut while it lasts.
      options.push({ push, joinAt: push.joinAt, route: route.arcs, cost: route.seconds + (2 * (push.joinAt + this.body)) / CONFIG.taxi.pushbackSpeed });
    }
    options.sort((a, b) => a.cost - b.cost);
    for (const option of options.slice(0, 3)) {
      // A swing is slower than a push down the painted line.
      const speed = option.push.pieces ? CONFIG.taxi.pushbackSpeed * 0.7 : CONFIG.taxi.pushbackSpeed;
      const pieces = pushPieces(net, option.push).map((p) => ({ ...p, speed }));
      const path = buildPath(net, pieces, this.body);
      const pushEnd = Math.min(path.total, option.joinAt + this.body + 9);
      svc.traffic.replace(this.mover, path, Math.min(this.body, path.total), svc.now);
      const result = svc.traffic.clear(this.mover, pushEnd, svc.now, CONFIG.taxi.maxGateHold, true);
      if (!result.ok) {
        svc.traffic.replace(this.mover, this.parkedPath!, this.parkedS, svc.now);
        continue;
      }
      this.phase = 'pushback';
      this.mover.turnsBack = false;
      this.reversing = true;
      this.runwayEnd = end;
      this.info = info;
      this.stops = [{ s: pushEnd, kind: 'pushed' }];
      this.departureArcs = option.route;
      this.departureFrom = option.joinAt;
      this.departureLink = option.push.link ?? [];
      this.visit.state = 'pushback';
      this.visit.offBlockAt = svc.now + result.delay;
      this.visit.departureRunway = end;
      this.nextAsk = svc.now;
      svc.event('pushback', `${this.visit.rotation.depFlight} pushing back from ${this.visit.stand} for runway ${end}`, this.id);
      return true;
    }
    return false;
  }

  private beginTaxiOut(svc: AirsideServices): void {
    const net = svc.net;
    const mover = this.mover;
    const pushPath = mover.path!;
    const info = this.info!;
    // The new path starts at the tail, runs forward through the nose to the taxiway junction, then
    // follows the route to the runway and a short way down its centreline.
    const covered = coveredPieces(net, pushPath, mover.s, this.departureFrom, 12);
    const last = net.nodes[net.arcTo(this.departureArcs[this.departureArcs.length - 1])];
    const run = this.body + LINE_UP_RUN;
    const onRunway: Piece = { pts: [last.x, last.y, last.x + info.ux * run, last.y + info.uy * run], speed: 8 };
    const path = buildPath(net, [...covered, ...this.departureLink, ...arcPieces(net, this.departureArcs), onRunway], this.body);
    svc.traffic.replace(mover, path, this.body, svc.now);
    this.reversing = false;
    this.phase = 'taxiOut';
    this.mover.turnsBack = false;
    this.visit.state = 'taxiOut';
    this.stops = this.findStops(net, path, this.body, 'depart');
    if (!this.stops.some((s) => s.kind === 'lineUp')) this.stops.splice(this.stops.length - 1, 0, { s: Math.max(this.body + 1, path.total - run - CONFIG.runway.holdDistance), kind: 'lineUp' });
    this.lineUpNodeAlong = (last.x - info.end.x) * info.ux + (last.y - info.end.y) * info.uy;
    this.nextAsk = svc.now;
    // A departure from a runway that also takes landings needs a hole in the arrivals.
    if (svc.tower.plan.arrivals.includes(this.runwayEnd)) svc.tower.openGap(this.runwayEnd, svc.now + 240);
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
    if (!svc.tower.mayTakeOff(this.id, this.runwayEnd, svc.now, this.type.wake, toRotate + 6, crossings)) return;
    this.phase = 'takeoff';
    svc.traffic.remove(this.mover);
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
    const length = this.type.length;
    const nose = this.reversing ? mover.s - FRONT - length : mover.s - FRONT;
    const sign = this.reversing ? 1 : -1;
    pointAt(path, nose + sign * 0.12 * length, this.point);
    pointAt(path, nose + sign * 0.55 * length, this.point2);
    const dx = this.point.x - this.point2.x;
    const dy = this.point.y - this.point2.y;
    if (dx * dx + dy * dy > 0.01) this.heading = Math.atan2(dy, dx);
    // The model's origin is half a length behind the nose, a little ahead of the main wheels.
    this.x = this.point.x + (this.point2.x - this.point.x) * 0.88;
    this.y = this.point.y + (this.point2.y - this.point.y) * 0.88;
    this.alt = 0;
    this.pitch = 0;
    this.bank = 0;
  }
}

/** Arcs leading down to a stand's stop point from far enough back to hold `length` of aircraft. */
export function leadIn(net: TaxiNet, standNode: number, length: number): number[] {
  const arcs: number[] = [];
  let node = standNode;
  let covered = 0;
  while (covered < length) {
    // Among the arcs that arrive at this node, the one that carries straight on into the next.
    let best = -1;
    let bestTurn = MAX_TURN;
    for (const out of net.arcsFrom(node)) {
      const arriving = out ^ 1;
      if (arcs.length && arriving === (arcs[0] ^ 1)) continue;
      const turn = arcs.length ? net.turn(arriving, arcs[0]) : 0;
      if (turn < bestTurn || best === -1) {
        if (turn > MAX_TURN) continue;
        bestTurn = turn;
        best = arriving;
      }
    }
    if (best === -1) break;
    arcs.unshift(best);
    covered += net.arcBlock(best).len;
    node = net.arcFrom(best);
  }
  return arcs;
}
