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
  /** The longest any vehicle has stood still away from a stop or a signal, seconds. */
  longestStuck: number;
}

export class RoadTraffic {
  readonly vehicles: Vehicle[] = [];
  readonly stats: TrafficStats = { spawned: 0, finished: 0, missedTurns: 0, longestStuck: 0 };
  /** Per link, per lane: vehicles in order of increasing distance along the link. */
  private readonly lanes: Vehicle[][][];
  private nextId = 1;
  private readonly point = { x: 0, y: 0, z: 0, heading: 0 };
  onArrive: ((vehicle: Vehicle) => void) | null = null;
  onLeave: ((vehicle: Vehicle) => void) | null = null;
  readonly net: RoadNet;

  constructor(net: RoadNet) {
    this.net = net;
    this.lanes = net.links.map((link) => Array.from({ length: link.lanes }, () => []));
  }

  /** Vehicles on a link, for measuring flow and speed. */
  count(link: number): number {
    let n = 0;
    for (const lane of this.lanes[link]) n += lane.length;
    return n;
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
    for (let k = 0; k < LOOK_AHEAD && reach <= look; k += 1) {
      const nextId = vehicle.route[vehicle.routeAt + k];
      if (nextId === undefined) break;
      const c = net.connection(from, nextId);
      if (!c) break;
      chain.push(c);
      sources.push(net.links[from]);
      from = nextId;
      reach += net.links[nextId].len;
    }
    let lo = 0;
    let hi = link.lanes - 1;
    if (chain.length) {
      // Backwards from the furthest junction: a lane is good if it lands in a good lane.
      let goodLo = 0;
      let goodHi = Infinity;
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
      const first = this.lanes[c.link][lane][0];
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
  private mergePartner(vehicle: Vehicle, link: Link): { gap: number; v: number } | null {
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
        const ahead = otherToEnd < toEnd - 0.5 || (Math.abs(otherToEnd - toEnd) <= 0.5 && (otherLink.speed > link.speed || (otherLink.speed === link.speed && other.id < vehicle.id)));
        if (!ahead) continue;
        const gap = toEnd - otherToEnd - other.length;
        if (!best || gap < best.gap) best = { gap, v: other.v };
      }
    }
    return best;
  }

  step(dt: number, now: number): void {
    const net = this.net;
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
            const partner = this.mergePartner(vehicle, link);
            if (partner) accel = Math.min(accel, this.follow(vehicle.v, desired, partner.gap, partner.v));
          }
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
      const waitingForLight = link.signal && link.len - vehicle.s < 80;
      vehicle.stuck = vehicle.v < 0.3 && !waitingForLight ? vehicle.stuck + dt : 0;
      if (vehicle.stuck > this.stats.longestStuck) this.stats.longestStuck = vehicle.stuck;
      // Close enough to the junctions ahead now to choose a lane for them.
      if (!vehicle.sorted && link.len - vehicle.s <= lookDistance(link)) this.setLaneRange(vehicle);

      // Arrived at a planned stop?
      if (vehicle.stopLink === vehicle.link && vehicle.v < 0.4 && Math.abs(vehicle.stopS - vehicle.s) < 22 && vehicle.lane === link.lanes - 1) {
        vehicle.v = 0;
        vehicle.stuck = 0;
        vehicle.stoppedUntil = now + vehicle.stopFor;
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
      // The end of the road: off the map, or into a car park the map does not show.
      this.removeFromLane(vehicle);
      vehicle.gone = true;
      this.stats.finished += 1;
      this.onLeave?.(vehicle);
      return;
    }
    const landed = this.net.landingLane(c, vehicle.lane);
    const target = this.lanes[c.link][landed];
    const s = vehicle.s - link.len;
    // No room at the start of the next link: wait at the end of this one.
    const first = target[0];
    if (first && first.s - first.length < s + 0.5) {
      vehicle.s = link.len - 0.01;
      vehicle.v = Math.min(vehicle.v, first.v);
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
    if (c.link === wanted) vehicle.routeAt += 1;
    else {
      // Missed the turn: find another way from where the lane has led.
      this.stats.missedTurns += 1;
      const goal = vehicle.goal;
      const route = goal >= 0 ? this.net.route(c.link, (l) => l.id === goal) : this.net.route(c.link, (l) => l.exits);
      vehicle.route = route ?? [];
      vehicle.routeAt = 0;
      if (!route) vehicle.goal = -1;
    }
    this.setLaneRange(vehicle);
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
  }

  private considerLaneChange(vehicle: Vehicle, link: Link, now: number): void {
    vehicle.nextChange = now + 0.5;
    // Not at the very end of the link: a move there would be a dive past whoever is waiting.
    if (link.lanes < 2 || vehicle.s > link.len - 3) return;
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
