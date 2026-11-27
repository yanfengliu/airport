// Road traffic: every vehicle follows the one ahead by the Intelligent Driver Model, keeps to
// lanes that lead where it is going, changes lane when it must or when it pays, merges in turn,
// and stops for signals and for the curb.
//
// Each lane of each link holds its vehicles in order, so the one ahead is the next in the list.
// A driver who cannot get into the lane for a turn does what drivers do: carries on where the
// lane leads and finds another way, rather than stopping in a moving lane.

import type { Rng } from '../rng.ts';
import type { Connection, Link, RoadNet } from './net.ts';

export type VehicleKind = 'car' | 'suv' | 'van' | 'taxi' | 'shuttle' | 'bus' | 'truck';

export const VEHICLE_LENGTH: Record<VehicleKind, number> = { car: 4.6, suv: 4.9, van: 5.4, taxi: 4.7, shuttle: 7.4, bus: 12, truck: 13.5 };

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  length: number;
  /** Paint colour, sRGB hex. */
  colour: number;
  /** Links still to drive after the current one, in order. */
  route: number[];
  routeAt: number;
  /** The link the vehicle is making for, or -1 when any way off the map will do. */
  goal: number;
  link: number;
  lane: number;
  /** Distance of the front bumper along the link, and speed. */
  s: number;
  v: number;
  accel: number;
  /** How fast this driver likes to go relative to the limit. */
  keenness: number;
  /** Lane the vehicle is sliding from while it changes lane, and how far through the slide it is. */
  fromLane: number;
  slide: number;
  /** A planned stop: on which link, where, and for how long. */
  stopLink: number;
  stopS: number;
  stopFor: number;
  /** Times it has gone round again for its stop, after driving past it or missing a turn on the way. */
  stopTries: number;
  /** While stopped: when the stop ends. Negative when not stopped. */
  stoppedUntil: number;
  /** What the vehicle is on the road for; the owner of the vehicle gives it meaning. */
  purpose: number;
  /** Seconds it has been unable to move. */
  stuck: number;
  /** Pose now and a step ago, for drawing. */
  x: number;
  y: number;
  z: number;
  heading: number;
  px: number;
  py: number;
  pz: number;
  pheading: number;
  gone: boolean;
  /** Lanes of the current link from which the route can be followed, inclusive. */
  laneLo: number;
  laneHi: number;
  nextChange: number;
  /** A vehicle in the next lane that has asked to come in ahead; this one eases off for it. */
  letIn: Vehicle | null;
  letInUntil: number;
  /** The lanes for the junctions ahead have been worked out from close enough to matter. */
  sorted: boolean;
}

const MIN_GAP = 2.2;
const HEADWAY = 1.2;
const ACCEL = 1.8;
const BRAKE = 2.6;
const LANE_CHANGE_SECONDS = 2.4;
/**
 * How far across, in lane widths, a vehicle changing lane has to be before it is clear of the
 * lane it is leaving: two vehicles side by side closer than this would be inside each other.
 */
const CLEAR_OF_LANE = 0.6;
/** Times a driver who passed the curb, or missed a turn on the way to it, goes round to try again. */
const STOP_TRIES = 2;
/** How many junctions ahead the choice of lane looks, and how far. */
const LOOK_AHEAD = 4;
/** How far ahead a driver sorts into lane: about forty seconds of driving, as the signs allow. */
const lookDistance = (link: Link): number => Math.max(320, link.speed * 40);
const SIGNAL_CYCLE = 64;
/** Links shorter than this are the inside of a junction, where lanes are not kept. */
const JUNCTION_LENGTH = 60;

export interface TrafficStats {
  spawned: number;
  finished: number;
  /** Times a driver missed a turn and went another way. */
  missedTurns: number;
  /**
   * Planned curb stops made, and given up: by a driver who has driven past the curb or missed a
   * turn on the way once too often, or who leaves the map with the stop still to make. Every stop
   * planned is one or the other once it is over.
   */
  stopsMade: number;
  stopsMissed: number;
  /** The longest any vehicle has stood still, seconds, signals included, planned curb stops not. */
  longestStuck: number;
}

export class RoadTraffic {
  readonly vehicles: Vehicle[] = [];
  readonly stats: TrafficStats = { spawned: 0, finished: 0, missedTurns: 0, stopsMade: 0, stopsMissed: 0, longestStuck: 0 };
  /** Per link, per lane: vehicles in order of increasing distance along the link. */
  private readonly lanes: Vehicle[][][];
  /** Per link, vehicles that began a change of lane there and may still be partly in the lane they left; checked before use. */
  private readonly changing: Vehicle[][];
  /** Links whose list of vehicles changing lane is not empty. */
  private readonly changingOn: number[] = [];
  private nextId = 1;
  private readonly point = { x: 0, y: 0, z: 0, heading: 0 };
  onArrive: ((vehicle: Vehicle) => void) | null = null;
  onLeave: ((vehicle: Vehicle) => void) | null = null;
  readonly net: RoadNet;

  constructor(net: RoadNet) {
    this.net = net;
    this.lanes = net.links.map((link) => Array.from({ length: link.lanes }, () => []));
    this.changing = net.links.map(() => []);
  }

  /** Vehicles on a link, for measuring flow and speed. */
  count(link: number): number {
    let n = 0;
    for (const lane of this.lanes[link]) n += lane.length;
    return n;
  }

  /**
   * Pairs of vehicles in one lane of one link that are inside each other, or out of order; zero
   * always, if the model is right. For the tests.
   */
  overlaps(): number {
    let bad = 0;
    for (const byLane of this.lanes) {
      for (const list of byLane) {
        for (let i = 1; i < list.length; i += 1) {
          const behind = list[i - 1];
          const ahead = list[i];
          // A vehicle waiting at the end of its link for room on the next may sit level with the
          // one ahead of it there; that is not an overlap on this link.
          if (behind.s > ahead.s - ahead.length + 0.05) bad += 1;
        }
      }
    }
    // A vehicle changing lane is partly in both until it is across: nobody may be beside it in
    // either, closer sideways than CLEAR_OF_LANE.
    const across = (v: Vehicle): number => v.fromLane + (v.lane - v.fromLane) * smooth(v.slide);
    for (const byLane of this.lanes) {
      for (const list of byLane) {
        for (const v of list) {
          if (v.slide >= 1 || v.fromLane === v.lane) continue;
          const at = across(v);
          for (const other of [...byLane[v.fromLane], ...list]) {
            if (other === v || other.s <= v.s - v.length || other.s - other.length >= v.s) continue;
            if (Math.abs(across(other) - at) < CLEAR_OF_LANE) bad += 1;
          }
        }
      }
    }
    return bad;
  }

  meanSpeed(link: number): number {
    let n = 0;
    let sum = 0;
    for (const lane of this.lanes[link]) {
      for (const v of lane) {
        n += 1;
        sum += v.v;
      }
    }
    return n ? sum / n : this.net.links[link].speed;
  }

  /**
   * Put a vehicle at the start of a link if there is room. `route` lists the links after it.
   * Returns null when the entry is blocked.
   */
  spawn(rng: Rng, kind: VehicleKind, colour: number, link: number, route: number[], speed: number): Vehicle | null {
    const l = this.net.links[link];
    const length = VEHICLE_LENGTH[kind];
    const vehicle: Vehicle = {
      id: this.nextId,
      kind,
      length,
      colour,
      route,
      routeAt: 0,
      goal: route.length ? route[route.length - 1] : -1,
      link,
      lane: 0,
      s: length,
      v: speed,
      accel: 0,
      keenness: kind === 'truck' || kind === 'bus' ? rng.range(0.82, 0.94) : rng.range(0.93, 1.12),
      fromLane: 0,
      slide: 1,
      stopLink: -1,
      stopS: 0,
      stopFor: 0,
      stopTries: 0,
      stoppedUntil: -1,
      purpose: 0,
      stuck: 0,
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      px: 0,
      py: 0,
      pz: 0,
      pheading: 0,
      gone: false,
      laneLo: 0,
      laneHi: l.lanes - 1,
      nextChange: 0,
      letIn: null,
      letInUntil: 0,
      sorted: false,
    };
    this.setLaneRange(vehicle);
    // Enter in the allowed lane with the most room.
    let best = -1;
    let bestGap = 0;
    for (let lane = vehicle.laneLo; lane <= vehicle.laneHi; lane += 1) {
      const first = this.lanes[link][lane][0];
      const gap = first ? first.s - first.length - vehicle.s : Infinity;
      if (gap > bestGap) {
        bestGap = gap;
        best = lane;
      }
    }
    const needed = MIN_GAP + speed * 0.9;
    if (best === -1 || bestGap < needed) return null;
    vehicle.lane = best;
    vehicle.fromLane = best;
    this.nextId += 1;
    this.lanes[link][best].unshift(vehicle);
    this.vehicles.push(vehicle);
    this.place(vehicle);
    vehicle.px = vehicle.x;
    vehicle.py = vehicle.y;
    vehicle.pz = vehicle.z;
    vehicle.pheading = vehicle.heading;
    this.stats.spawned += 1;
    return vehicle;
  }

  /**
   * Which lanes of its current link keep a vehicle on its route, looking several junctions
   * ahead so the lane for a turn two junctions on is taken in good time.
   */
  private setLaneRange(vehicle: Vehicle): void {
    const net = this.net;
    const link = net.links[vehicle.link];
    // The connections the route takes from here, as far as the driver is thinking: the junctions
    // within the next few hundred metres. Sorting into lane any earlier wastes the other lanes.
    const chain: Connection[] = [];
    const sources: Link[] = [];
    let from = vehicle.link;
    let reach = link.len - vehicle.s;
    const look = lookDistance(link);
    vehicle.sorted = reach <= look;
    // A curb stop ahead is as far as the driver plans: it has to be reached in the curb lane.
    let curbLane = -1;
    for (let k = 0; k < LOOK_AHEAD && reach <= look; k += 1) {
      const nextId = vehicle.route[vehicle.routeAt + k];
      if (nextId === undefined) break;
      const c = net.connection(from, nextId);
      if (!c) break;
      chain.push(c);
      sources.push(net.links[from]);
      from = nextId;
      reach += net.links[nextId].len;
      if (nextId === vehicle.stopLink) {
        curbLane = net.links[nextId].lanes - 1;
        break;
      }
    }
    let lo = 0;
    let hi = link.lanes - 1;
    if (chain.length) {
      // Backwards from the furthest junction: a lane is good if it lands in a good lane.
      let goodLo = curbLane >= 0 ? curbLane : 0;
      let goodHi = curbLane >= 0 ? curbLane : Infinity;
      for (let k = chain.length - 1; k >= 0; k -= 1) {
        const c = chain[k];
        let newLo = -1;
        let newHi = -1;
        for (let lane = c.lo; lane <= c.hi; lane += 1) {
          const landed = net.landingLane(c, lane);
          if (landed < goodLo || landed > goodHi) continue;
          if (newLo === -1) newLo = lane;
          newHi = lane;
        }
        // Nothing lines up that far ahead: settle for the next turn and sort the rest out later.
        if (newLo === -1) {
          newLo = c.lo;
          newHi = c.hi;
        }
        // Inside a junction any lane will do: there is no room to choose one, and no need.
        if (sources[k].len < JUNCTION_LENGTH) {
          newLo = 0;
          newHi = sources[k].lanes - 1;
        }
        goodLo = newLo;
        goodHi = newHi;
      }
      lo = goodLo;
      hi = goodHi;
    }
    if (vehicle.stopLink === vehicle.link) lo = hi = link.lanes - 1;
    vehicle.laneLo = lo;
    vehicle.laneHi = Math.min(hi, link.lanes - 1);
  }

  /** Give a vehicle somewhere to pull up: at `s` on `link`, at the curb, for `seconds`. */
  planStop(vehicle: Vehicle, link: number, s: number, seconds: number): void {
    vehicle.stopLink = link;
    vehicle.stopS = s;
    vehicle.stopFor = seconds;
    if (vehicle.link === link) this.setLaneRange(vehicle);
  }

  /** Let a stopped vehicle go, for example when its passengers are aboard. */
  release(vehicle: Vehicle): void {
    vehicle.stoppedUntil = -1;
    vehicle.stopLink = -1;
    this.setLaneRange(vehicle);
  }

  private green(link: Link, now: number): boolean {
    if (!link.signal) return true;
    // Two phases by compass axis; each junction's cycle is offset by its own number.
    const axis = Math.abs(Math.sin(link.headOut)) > 0.7071 ? 0 : 1;
    const t = (now + link.junction * 17) % SIGNAL_CYCLE;
    const half = SIGNAL_CYCLE / 2;
    return axis === 0 ? t < half - 4 : t >= half && t < SIGNAL_CYCLE - 4;
  }

  /** Acceleration from the Intelligent Driver Model for a gap to something moving at `leadV`. */
  private follow(v: number, desired: number, gap: number, leadV: number): number {
    const dv = v - leadV;
    const wanted = MIN_GAP + Math.max(0, v * HEADWAY + (v * dv) / (2 * Math.sqrt(ACCEL * BRAKE)));
    const free = 1 - Math.pow(v / Math.max(1, desired), 4);
    const interaction = gap > 0.1 ? (wanted / gap) * (wanted / gap) : 50;
    return Math.max(-7, ACCEL * (free - interaction));
  }

  /** Still partly in the lane it is changing out of: not yet far enough across to be clear of it. */
  private stillLeaving(vehicle: Vehicle, linkId: number, lane: number): boolean {
    return vehicle.link === linkId && !vehicle.gone && vehicle.fromLane === lane && vehicle.lane !== lane && smooth(vehicle.slide) < CLEAR_OF_LANE;
  }

  /** Note a vehicle that has begun to change lane, so that those in the lane it leaves still see it. */
  private addChanging(vehicle: Vehicle): void {
    const list = this.changing[vehicle.link];
    if (list.includes(vehicle)) return;
    if (!list.length) this.changingOn.push(vehicle.link);
    list.push(vehicle);
  }

  /**
   * The nearest vehicle ahead of `s` that is still pulling out of `lane` into a lane beside it:
   * until it is clear, it is in the way of both. Null for none within `reach` metres.
   */
  private leavingAhead(linkId: number, lane: number, s: number, reach: number): Vehicle | null {
    let best: Vehicle | null = null;
    for (const other of this.changing[linkId]) {
      if (!this.stillLeaving(other, linkId, lane) || other.s <= s || other.s - other.length > s + reach) continue;
      if (!best || other.s < best.s) best = other;
    }
    return best;
  }

  /** For a vehicle part way through a change of lane, the one ahead of it in the lane it is leaving. */
  private aheadInLaneLeft(vehicle: Vehicle, linkId: number): Vehicle | null {
    if (!this.stillLeaving(vehicle, linkId, vehicle.fromLane)) return null;
    const list = this.lanes[linkId][vehicle.fromLane];
    return list[this.firstBeyond(list, vehicle.s)] ?? null;
  }

  /** A vehicle pulling out of `lane` whose body overlaps the stretch from `rear` to `front`, or comes within `margin`. */
  private leavingBeside(linkId: number, lane: number, rear: number, front: number, margin: number): Vehicle | null {
    for (const other of this.changing[linkId]) {
      if (this.stillLeaving(other, linkId, lane) && other.s > rear - margin && other.s - other.length < front + margin) return other;
    }
    return null;
  }

  /** Index of the first vehicle in an ordered lane whose front is beyond `s`. */
  private firstBeyond(list: readonly Vehicle[], s: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s > s) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** The connection a lane of a link actually leads into, whatever the route says. */
  private leadsTo(link: Link, lane: number, wanted: number | undefined): Connection | undefined {
    let fallback: Connection | undefined;
    let near: Connection | undefined;
    // A link a few metres long is the inside of a junction: from there every lane reaches every exit.
    if (wanted !== undefined && link.len < JUNCTION_LENGTH) {
      const direct = this.net.connection(link.id, wanted);
      if (direct) return direct;
    }
    for (const c of link.next) {
      // One lane out is near enough: the driver cuts across as the junction opens.
      if (c.link === wanted && lane >= c.lo - 1 && lane <= c.hi + 1) near = c;
      if (lane < c.lo || lane > c.hi) continue;
      if (c.link === wanted) return c;
      fallback ??= c;
    }
    return near ?? fallback;
  }

  /**
   * What is ahead of the front vehicle of a lane, beyond the end of its link: a red signal, the
   * last vehicle on the lane it will land in, or nothing.
   */
  private beyond(vehicle: Vehicle, link: Link, now: number): { gap: number; v: number } {
    const toEnd = link.len - vehicle.s;
    if (toEnd > 260) return FREE;
    if (!this.green(link, now)) return { gap: toEnd - 1.5, v: 0 };
    let gap = toEnd;
    let fromLink = link;
    let lane = vehicle.lane;
    for (let k = 0; k < 3; k += 1) {
      const c = this.leadsTo(fromLink, lane, vehicle.route[vehicle.routeAt + k]);
      if (!c) return k === 0 && !fromLink.exits && fromLink.next.length ? { gap: toEnd - 1, v: 0 } : FREE;
      const next = this.net.links[c.link];
      lane = this.net.landingLane(c, lane);
      let first: Vehicle | undefined = this.lanes[c.link][lane][0];
      // Someone at the start of that lane who is pulling out of it is still in the way.
      const leaving = this.leavingAhead(c.link, lane, -50, (first ? first.s : 260 - gap) + 50);
      if (leaving && (!first || leaving.s < first.s)) first = leaving;
      if (first) return { gap: gap + first.s - first.length, v: first.v };
      gap += next.len;
      if (gap > 260) return FREE;
      if (!this.green(next, now)) return { gap: gap - 1.5, v: 0 };
      fromLink = next;
    }
    return FREE;
  }

  /**
   * Someone merging into the same lane from another approach who is nearer the junction than
   * this vehicle: treat them as the one to follow, so two streams take turns.
   */
  private mergePartner(vehicle: Vehicle, link: Link, now: number): { gap: number; v: number } | null {
    const nextId = vehicle.route[vehicle.routeAt];
    if (nextId === undefined) return null;
    const next = this.net.links[nextId];
    const toEnd = link.len - vehicle.s;
    if (toEnd > 120) return null;
    const c = this.net.connection(link.id, nextId);
    if (!c) return null;
    // Two streams run together where another road joins, or where this road loses a lane.
    if (next.prev.length < 2 && c.hi - c.lo < next.lanes) return null;
    const landed = this.net.landingLane(c, vehicle.lane);
    let best: { gap: number; v: number } | null = null;
    for (const otherLinkId of next.prev) {
      const otherLink = this.net.links[otherLinkId];
      // A road held at a red light has no turn to go first: its traffic is waiting at the line.
      if (otherLinkId !== link.id && !this.green(otherLink, now)) continue;
      const oc = this.net.connection(otherLinkId, nextId);
      if (!oc) continue;
      for (let lane = oc.lo; lane <= oc.hi; lane += 1) {
        if (otherLinkId === link.id && lane === vehicle.lane) continue;
        if (this.net.landingLane(oc, lane) !== landed) continue;
        const list = this.lanes[otherLinkId][lane];
        const other = list[list.length - 1];
        if (!other || other.route[other.routeAt] !== nextId) continue;
        const otherToEnd = otherLink.len - other.s;
        // The nearer one goes first; a tie goes to the bigger road, then the lower id.
        // Distances to the metre, so that the order is the same whichever pair is compared and
        // three streams cannot each wait for another: a strict order, never a ring.
        const theirs = Math.round(otherToEnd);
        const mine = Math.round(toEnd);
        const ahead = theirs < mine || (theirs === mine && (otherLink.speed > link.speed || (otherLink.speed === link.speed && other.id < vehicle.id)));
        if (!ahead) continue;
        const gap = toEnd - otherToEnd - other.length;
        if (!best || gap < best.gap) best = { gap, v: other.v };
      }
    }
    return best;
  }

  step(dt: number, now: number): void {
    const net = this.net;
    // Forget the vehicles that are clear of the lane they left, or gone from the link.
    const links = this.changingOn.splice(0);
    for (const linkId of links) {
      const list = this.changing[linkId];
      const kept = list.filter((v) => this.stillLeaving(v, linkId, v.fromLane));
      list.length = 0;
      for (const v of kept) this.addChanging(v);
    }
    // First decide every acceleration from the present state, lane by lane from the front.
    for (let linkId = 0; linkId < this.lanes.length; linkId += 1) {
      const link = net.links[linkId];
      const byLane = this.lanes[linkId];
      for (let lane = 0; lane < byLane.length; lane += 1) {
        const list = byLane[lane];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const vehicle = list[i];
          vehicle.px = vehicle.x;
          vehicle.py = vehicle.y;
          vehicle.pz = vehicle.z;
          vehicle.pheading = vehicle.heading;
          if (vehicle.stoppedUntil >= 0) {
            vehicle.accel = 0;
            vehicle.v = 0;
            if (now >= vehicle.stoppedUntil && vehicle.stopFor < 1e8) this.release(vehicle);
            continue;
          }
          const desired = link.speed * vehicle.keenness;
          const leader = list[i + 1];
          let accel: number;
          if (leader) accel = this.follow(vehicle.v, desired, leader.s - leader.length - vehicle.s, leader.v);
          else {
            const lead = this.beyond(vehicle, link, now);
            accel = this.follow(vehicle.v, desired, lead.gap, lead.v);
            const partner = this.mergePartner(vehicle, link, now);
            if (partner) accel = Math.min(accel, this.follow(vehicle.v, desired, partner.gap, partner.v));
          }
          // Someone ahead pulling out of this lane is still in it until they are across.
          const leaving = this.leavingAhead(linkId, lane, vehicle.s, leader ? leader.s - vehicle.s : 200);
          if (leaving) accel = Math.min(accel, this.follow(vehicle.v, desired, leaving.s - leaving.length - vehicle.s, leaving.v));
          // Ease off for someone who has asked to come in ahead.
          const guest = vehicle.letIn;
          if (guest) {
            // Only for someone wholly ahead, and not for ever: a driver alongside goes on past.
            const gap = guest.s - guest.length - vehicle.s;
            if (guest.gone || guest.link !== vehicle.link || guest.lane === vehicle.lane || gap < 1 || now > vehicle.letInUntil) vehicle.letIn = null;
            else accel = Math.min(accel, this.follow(vehicle.v, desired, gap, guest.v) + 0.4);
          }
          // A planned stop at the curb.
          if (vehicle.stopLink === linkId && vehicle.lane === link.lanes - 1) {
            const gap = vehicle.stopS - vehicle.s;
            if (gap > -3) accel = Math.min(accel, this.follow(vehicle.v, desired, Math.max(0.05, gap + MIN_GAP), 0));
          }
          vehicle.accel = accel;
        }
      }
    }

    // Then move everyone, each lane from the front, so nobody can end up inside the one ahead.
    for (let linkId = 0; linkId < this.lanes.length; linkId += 1) {
      const byLane = this.lanes[linkId];
      for (let lane = 0; lane < byLane.length; lane += 1) {
        const list = byLane[lane];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const vehicle = list[i];
          if (vehicle.stoppedUntil >= 0) continue;
          vehicle.v = Math.max(0, vehicle.v + vehicle.accel * dt);
          let s = vehicle.s + vehicle.v * dt;
          const leader = list[i + 1];
          if (leader) {
            const room = leader.s - leader.length - 0.4;
            if (s > room) {
              s = Math.max(vehicle.s, room);
              vehicle.v = Math.min(vehicle.v, leader.v);
            }
          }
          // Nor into someone still pulling out of this lane, nor, while this one is still partly in
          // the lane it is leaving, into whoever is ahead there: it is moving out of their way and
          // need not keep its distance, only not touch.
          for (const other of [this.leavingAhead(linkId, lane, vehicle.s, s - vehicle.s + 1), this.aheadInLaneLeft(vehicle, linkId)]) {
            if (!other) continue;
            const room = other.s - other.length - 0.4;
            if (s > room) {
              s = Math.max(vehicle.s, room);
              vehicle.v = Math.min(vehicle.v, other.v);
            }
          }
          vehicle.s = s;
        }
      }
    }

    // Then the things that move a vehicle from one list to another. Over the whole fleet rather
    // than lane by lane, since the lanes change under them.
    for (const vehicle of this.vehicles) {
      if (vehicle.stoppedUntil >= 0 || vehicle.gone) continue;
      const link = net.links[vehicle.link];
      if (vehicle.slide < 1) vehicle.slide = Math.min(1, vehicle.slide + dt / LANE_CHANGE_SECONDS);
      // Standing at a light counts too: a red phase is far shorter than any wait worth reporting,
      // and a jam at a junction must not hide behind its signal.
      vehicle.stuck = vehicle.v < 0.3 ? vehicle.stuck + dt : 0;
      if (vehicle.stuck > this.stats.longestStuck) this.stats.longestStuck = vehicle.stuck;
      // Close enough to the junctions ahead now to choose a lane for them.
      if (!vehicle.sorted && link.len - vehicle.s <= lookDistance(link)) this.setLaneRange(vehicle);

      // Arrived at a planned stop?
      if (vehicle.stopLink === vehicle.link && vehicle.v < 0.4 && Math.abs(vehicle.stopS - vehicle.s) < 22 && vehicle.lane === link.lanes - 1) {
        vehicle.v = 0;
        vehicle.stuck = 0;
        vehicle.stoppedUntil = now + vehicle.stopFor;
        this.stats.stopsMade += 1;
        this.onArrive?.(vehicle);
        continue;
      }
      if (now >= vehicle.nextChange && vehicle.slide >= 1) this.considerLaneChange(vehicle, link, now);
      if (vehicle.s >= link.len) this.advance(vehicle, link);
    }

    // Tidy: drop the gone and refresh poses.
    for (let i = this.vehicles.length - 1; i >= 0; i -= 1) {
      const vehicle = this.vehicles[i];
      if (vehicle.gone) {
        this.vehicles[i] = this.vehicles[this.vehicles.length - 1];
        this.vehicles.pop();
        continue;
      }
      this.place(vehicle);
    }
  }

  private removeFromLane(vehicle: Vehicle): void {
    const list = this.lanes[vehicle.link][vehicle.lane];
    const at = list.indexOf(vehicle);
    if (at >= 0) list.splice(at, 1);
  }

  private advance(vehicle: Vehicle, link: Link): void {
    const wanted = vehicle.route[vehicle.routeAt];
    const c = this.leadsTo(link, vehicle.lane, wanted);
    if (!c) {
      // The end of the road: off the map, or into a car park the map does not show. A stop it has
      // not made by now it never will.
      this.giveUpStop(vehicle);
      this.removeFromLane(vehicle);
      vehicle.gone = true;
      this.stats.finished += 1;
      this.onLeave?.(vehicle);
      return;
    }
    const landed = this.net.landingLane(c, vehicle.lane);
    const target = this.lanes[c.link][landed];
    const s = vehicle.s - link.len;
    // No room at the start of the next link, counting anyone still pulling out of that lane: wait
    // at the end of this one.
    const first = target[0];
    const blocked = first && first.s - first.length < s + 0.5 ? first : this.leavingBeside(c.link, landed, s - vehicle.length, s, 0.5);
    if (blocked) {
      vehicle.s = link.len - 0.01;
      vehicle.v = Math.min(vehicle.v, blocked.v);
      return;
    }
    this.removeFromLane(vehicle);
    vehicle.s = s;
    vehicle.link = c.link;
    vehicle.lane = landed;
    vehicle.fromLane = landed;
    vehicle.slide = 1;
    vehicle.letIn = null;
    target.unshift(vehicle);
    // Driven past the curb without stopping: round the loop for another go, as drivers do, a
    // couple of times at most; then on its way. The way on from the curb is the rest of its route.
    if (vehicle.stopLink === link.id && vehicle.stoppedUntil < 0) {
      const back = this.roundToStop(vehicle, c.link, vehicle.route.slice(vehicle.routeAt));
      if (back) {
        vehicle.route = back;
        vehicle.routeAt = 0;
        this.setLaneRange(vehicle);
        return;
      }
      this.giveUpStop(vehicle);
    }
    if (c.link === wanted) vehicle.routeAt += 1;
    else {
      // Missed the turn: find another way from where the lane has led, by the curb if it has yet
      // to stop there.
      this.stats.missedTurns += 1;
      const goal = vehicle.goal;
      let route: number[] | null = null;
      if (vehicle.stopLink >= 0) {
        const at = vehicle.route.indexOf(vehicle.stopLink, vehicle.routeAt);
        const onward = at >= 0 ? vehicle.route.slice(at + 1) : this.routeOn(vehicle.stopLink, goal);
        route = c.link === vehicle.stopLink ? onward : onward && this.roundToStop(vehicle, c.link, onward);
        if (!route) this.giveUpStop(vehicle);
      }
      route ??= this.routeOn(c.link, goal);
      vehicle.route = route ?? [];
      vehicle.routeAt = 0;
      if (!route) vehicle.goal = -1;
    }
    this.setLaneRange(vehicle);
  }

  /** The way from the end of a link to the goal, or off the map anywhere without one. */
  private routeOn(from: number, goal: number): number[] | null {
    return goal >= 0 ? this.net.route(from, (l) => l.id === goal) : this.net.route(from, (l) => l.exits);
  }

  /**
   * The way from the end of link `from` round to a vehicle's stop and then `onward` from it, if it
   * has not been round for its stop too often already; null if not.
   */
  private roundToStop(vehicle: Vehicle, from: number, onward: number[]): number[] | null {
    if (vehicle.stopTries >= STOP_TRIES) return null;
    const stop = vehicle.stopLink;
    const back = this.net.route(from, (l) => l.id === stop);
    if (!back) return null;
    vehicle.stopTries += 1;
    return [...back, ...onward];
  }

  /** A stop the vehicle will not make now: counted as missed, so that every stop planned is counted once. */
  private giveUpStop(vehicle: Vehicle): void {
    if (vehicle.stopLink < 0) return;
    this.stats.stopsMissed += 1;
    vehicle.stopLink = -1;
  }

  /**
   * Room for `vehicle` in `lane` beside where it is now? `keen` is 0 for a change of choice, up
   * to 1 for one that has to be made now. Returns the vehicle that would be behind, if any, so it
   * can be asked to ease off.
   */
  private roomIn(vehicle: Vehicle, lane: number, keen: number): { ok: boolean; behind: Vehicle | null } {
    const list = this.lanes[vehicle.link][lane];
    const index = this.firstBeyond(list, vehicle.s);
    const front = list[index];
    const behind = index > 0 ? list[index - 1] : null;
    let ok = true;
    // Someone still sliding out of that lane is in it until they are across.
    const margin = MIN_GAP * (1 - 0.5 * keen) + 0.25 * vehicle.v * (1 - keen);
    if (this.leavingBeside(vehicle.link, lane, vehicle.s - vehicle.length, vehicle.s, margin)) ok = false;
    if (front) {
      const gap = front.s - front.length - vehicle.s;
      const need = MIN_GAP * (1 - 0.5 * keen) + Math.max(0, (vehicle.v - front.v) * 1.6 * (1 - keen));
      if (gap < need) ok = false;
    }
    if (behind) {
      const gap = vehicle.s - vehicle.length - behind.s;
      const need = MIN_GAP * (1 - 0.5 * keen) + (Math.max(0, (behind.v - vehicle.v) * 1.8) + behind.v * 0.25) * (1 - keen);
      if (gap < need) ok = false;
    } else if (vehicle.s - vehicle.length < 40) {
      // Nobody behind on this link, but someone may be about to come onto this lane from the link
      // before: cutting in at the very start of a link would leave them no way in.
      const rear = vehicle.s - vehicle.length;
      for (const feederId of this.net.links[vehicle.link].prev) {
        const feeder = this.net.links[feederId];
        const c = this.net.connection(feederId, vehicle.link);
        if (!c) continue;
        for (let from = c.lo; from <= c.hi; from += 1) {
          if (this.net.landingLane(c, from) !== lane) continue;
          const queue = this.lanes[feederId][from];
          const coming = queue[queue.length - 1];
          if (!coming || coming.route[coming.routeAt] !== vehicle.link) continue;
          const gap = rear + (feeder.len - coming.s);
          const need = MIN_GAP + (Math.max(0, (coming.v - vehicle.v) * 1.8) + coming.v * 0.25) * (1 - keen);
          if (gap < need) ok = false;
        }
      }
    }
    return { ok, behind };
  }

  private moveToLane(vehicle: Vehicle, lane: number, now: number): void {
    this.removeFromLane(vehicle);
    const to = this.lanes[vehicle.link][lane];
    to.splice(this.firstBeyond(to, vehicle.s), 0, vehicle);
    vehicle.fromLane = vehicle.lane;
    vehicle.lane = lane;
    vehicle.slide = 0;
    vehicle.letIn = null;
    vehicle.nextChange = now + 4;
    this.addChanging(vehicle);
  }

  private considerLaneChange(vehicle: Vehicle, link: Link, now: number): void {
    vehicle.nextChange = now + 0.5;
    // Not at the very end of the link: a move there would be a dive past whoever is waiting. Nor
    // before the whole vehicle is on it, where those coming on behind cannot see it.
    if (link.lanes < 2 || vehicle.s > link.len - 3 || vehicle.s - vehicle.length < 1) return;
    // Must: towards a lane that continues on the route.
    if (vehicle.lane < vehicle.laneLo || vehicle.lane > vehicle.laneHi) {
      const step = vehicle.lane < vehicle.laneLo ? 1 : -1;
      const toEnd = link.len - vehicle.s;
      // The nearer the junction, the smaller the gap that will do.
      const keen = Math.max(0, Math.min(1, 1 - (toEnd - 60) / (lookDistance(link) * 0.7)));
      const room = this.roomIn(vehicle, vehicle.lane + step, keen);
      if (room.ok) {
        this.moveToLane(vehicle, vehicle.lane + step, now);
        // With more lanes still to cross, the next move follows as soon as this one is made.
        vehicle.nextChange = now + LANE_CHANGE_SECONDS + 0.2;
      } else if (room.behind && room.behind.letIn === null && keen > 0.55 && vehicle.v - room.behind.v < 4) {
        // Running out of road, and going no faster than the lane it wants: ask to be let in.
        room.behind.letIn = vehicle;
        room.behind.letInUntil = now + 10;
      }
      return;
    }
    // May: a faster lane within those that still lead the right way.
    const desired = link.speed * vehicle.keenness;
    if (vehicle.v > desired * 0.86) return;
    const list = this.lanes[vehicle.link][vehicle.lane];
    const mine = list[this.firstBeyond(list, vehicle.s)];
    const here = mine ? this.follow(vehicle.v, desired, mine.s - mine.length - vehicle.s, mine.v) : this.follow(vehicle.v, desired, Infinity, 0);
    let best = -1;
    let bestGain = 0.35;
    for (const step of [-1, 1]) {
      const lane = vehicle.lane + step;
      if (lane < vehicle.laneLo || lane > vehicle.laneHi) continue;
      const other = this.lanes[vehicle.link][lane];
      const front = other[this.firstBeyond(other, vehicle.s)];
      const there = front ? this.follow(vehicle.v, desired, front.s - front.length - vehicle.s, front.v) : this.follow(vehicle.v, desired, Infinity, 0);
      if (there - here > bestGain && this.roomIn(vehicle, lane, 0).ok) {
        bestGain = there - here;
        best = lane;
      }
    }
    if (best >= 0) this.moveToLane(vehicle, best, now);
  }

  private place(vehicle: Vehicle): void {
    const link = this.net.links[vehicle.link];
    const lane = vehicle.fromLane + (vehicle.lane - vehicle.fromLane) * smooth(vehicle.slide);
    // Drawn at its middle: `s` is the front bumper.
    this.net.point(link, vehicle.s - vehicle.length / 2, lane, this.point);
    vehicle.x = this.point.x;
    vehicle.y = this.point.y;
    vehicle.z = this.point.z;
    vehicle.heading = this.point.heading;
  }
}

const FREE = { gap: Infinity, v: 0 } as const;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
