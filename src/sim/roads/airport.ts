// Traffic the airport itself makes: cars, taxis and shuttles that come in off the freeways to set
// someone down at Departures or pick someone up at Arrivals and then leave, and cars that go
// into the garages or come out of them.

import type { Stand } from '../../shared/layout.ts';
import type { FlightBook } from '../airside/flights.ts';
import type { PassengerHalls } from '../terminal/passenger-halls.ts';
import { FlightCurbDemand } from './flight-curbs.ts';
import type { Rng } from '../rng.ts';
import { hourlyShare, paintFor } from './demand.ts';
import type { Link, RoadNet } from './net.ts';
import type { RoadTraffic, Vehicle, VehicleKind } from './traffic.ts';

/** What a vehicle on an airport errand is doing; kept in `vehicle.purpose`. */
export const PURPOSE = { through: 0, dropOff: 1, pickUp: 2, toGarage: 3, fromGarage: 4 } as const;

/** Vehicles an hour at the busiest time of day, for each kind of errand. */
const PEAK = { dropOff: 620, pickUp: 560, toGarage: 300, fromGarage: 280 } as const;

const CURB_KINDS: [VehicleKind, number][] = [['car', 44], ['suv', 26], ['taxi', 17], ['shuttle', 8], ['van', 4], ['bus', 1]];
const PARKING_KINDS: [VehicleKind, number][] = [['car', 58], ['suv', 36], ['van', 6]];

/** A stretch of curb must be at least this long to be worth pulling up at. */
const CURB_LENGTH = 45;

export interface AirportTrafficStats {
  /** Vehicles that pulled up at the curb, not just set out to. */
  dropOffs: number;
  pickUps: number;
  /** Vehicles that reached a garage, and that came out of one. */
  intoGarages: number;
  outOfGarages: number;
  /** Errands that could not start because the way in was full. */
  turnedAway: number;
}

export class AirportTraffic {
  readonly stats: AirportTrafficStats = { dropOffs: 0, pickUps: 0, intoGarages: 0, outOfGarages: 0, turnedAway: 0 };
  /** Multiplies every volume; 1 is a normal day. */
  scale = 1;
  readonly departuresCurbs: Link[];
  readonly arrivalsCurbs: Link[];
  private readonly net: RoadNet;
  private readonly rng: Rng;
  private flights: FlightCurbDemand | null = null;
  /** Vehicles per hour requested at the two curbs, including the current traffic scale. */
  readonly curbDemandPerHour = { dropOff: 0, pickUp: 0 };
  private readonly ways: { link: Link; weight: number }[];
  private readonly out: (link: Link) => boolean;
  private readonly garagesIn: Link[];
  private readonly garagesOut: Link[];
  private readonly routes = new Map<string, number[] | null>();
  private readonly owed = { dropOff: 0, pickUp: 0, toGarage: 0, fromGarage: 0 };

  /**
   * `atEdge` says whether a point is where the mapped area ends; `centre` is the middle of the
   * terminal area, which the garages and curbs stand round.
   */
  constructor(net: RoadNet, rng: Rng, atEdge: (x: number, y: number) => boolean, centre: readonly [number, number]) {
    this.net = net;
    this.rng = rng;
    const start = (l: Link): [number, number] => [l.pts[0], l.pts[1]];
    const end = (l: Link): [number, number] => [l.pts[l.pts.length - 3], l.pts[l.pts.length - 2]];
    const near = (p: [number, number], reach: number): boolean => Math.hypot(p[0] - centre[0], p[1] - centre[1]) < reach;
    // People come to the airport mostly by freeway.
    this.ways = net.links
      .filter((l) => l.enters && atEdge(...start(l)) && (l.cls === 'motorway' || l.cls === 'primary'))
      .map((link) => ({ link, weight: link.lanes * (link.cls === 'motorway' ? 6 : 1) }));
    this.out = (l) => l.exits && atEdge(...end(l)) && (l.cls === 'motorway' || l.cls === 'primary' || l.cls === 'motorway_link');
    this.departuresCurbs = net.links.filter((l) => l.name === 'Departures' && l.len >= CURB_LENGTH && l.lanes >= 2);
    this.arrivalsCurbs = net.links.filter((l) => l.name === 'Arrivals' && l.len >= CURB_LENGTH && l.lanes >= 2);
    // A road that stops inside the airport stops at a car park: the map shows the way in, not the bays.
    this.garagesIn = net.links.filter((l) => l.exits && !atEdge(...end(l)) && near(end(l), 1500) && l.cls !== 'motorway');
    this.garagesOut = net.links.filter((l) => l.enters && !atEdge(...start(l)) && near(start(l), 1500) && l.cls !== 'motorway');
  }

  /** Drive the terminal curbs from the flight book when running with the airfield. */
  connectFlights(book: FlightBook, stands: readonly Stand[], plan: PassengerHalls): void {
    this.flights = new FlightCurbDemand(book, stands, this.net, this.departuresCurbs, this.arrivalsCurbs, plan);
  }

  private route(from: number, goal: number | ((l: Link) => boolean)): number[] | null {
    if (typeof goal !== 'number') return this.net.route(from, goal);
    const key = `${from}>${goal}`;
    let found = this.routes.get(key);
    if (found === undefined) {
      found = this.net.route(from, (l) => l.id === goal);
      this.routes.set(key, found);
    }
    return found;
  }

  private pickWay(): Link {
    return this.rng.weighted(this.ways, (w) => w.weight).link;
  }

  /** Start one errand; false if there was no way to do it or no room to start. */
  private start(traffic: RoadTraffic, errand: keyof typeof PEAK): boolean {
    const rng = this.rng;
    if (errand === 'dropOff' || errand === 'pickUp') {
      const curbs = errand === 'dropOff' ? this.departuresCurbs : this.arrivalsCurbs;
      if (!curbs.length || !this.ways.length) return false;
      const way = this.pickWay();
      const curb = this.flights?.pick(errand, rng) ?? rng.pick(curbs);
      const inbound = this.route(way.id, curb.id);
      const outbound = inbound && this.route(curb.id, this.out);
      if (!inbound || !outbound) return false;
      const kind = rng.weighted(CURB_KINDS, (k) => k[1])[0];
      const vehicle = traffic.spawn(rng, kind, paintFor(rng, kind), way.id, [...inbound, ...outbound], way.speed * 0.9);
      if (!vehicle) return false;
      vehicle.purpose = errand === 'dropOff' ? PURPOSE.dropOff : PURPOSE.pickUp;
      // Setting down is quick; someone waiting for a passenger with bags takes longer.
      const dwell = errand === 'dropOff' ? rng.range(25, 75) : rng.range(35, 120);
      traffic.planStop(vehicle, curb.id, rng.range(14, curb.len - 10), kind === 'bus' || kind === 'shuttle' ? dwell + 40 : dwell);
      return true;
    }
    if (errand === 'toGarage') {
      if (!this.garagesIn.length || !this.ways.length) return false;
      const way = this.pickWay();
      const inbound = this.route(way.id, rng.pick(this.garagesIn).id);
      if (!inbound) return false;
      const kind = rng.weighted(PARKING_KINDS, (k) => k[1])[0];
      const vehicle = traffic.spawn(rng, kind, paintFor(rng, kind), way.id, inbound, way.speed * 0.9);
      if (!vehicle) return false;
      vehicle.purpose = PURPOSE.toGarage;
      return true;
    }
    if (!this.garagesOut.length) return false;
    const from = rng.pick(this.garagesOut);
    const outbound = this.route(from.id, this.out);
    if (!outbound) return false;
    const kind = rng.weighted(PARKING_KINDS, (k) => k[1])[0];
    const vehicle = traffic.spawn(rng, kind, paintFor(rng, kind), from.id, outbound, 3);
    if (!vehicle) return false;
    vehicle.purpose = PURPOSE.fromGarage;
    this.stats.outOfGarages += 1;
    return true;
  }

  /** A vehicle has pulled up where it planned to. */
  arrived(vehicle: Vehicle): void {
    if (vehicle.purpose === PURPOSE.dropOff) this.stats.dropOffs += 1;
    else if (vehicle.purpose === PURPOSE.pickUp) this.stats.pickUps += 1;
  }

  /** A vehicle has driven off the end of the road: off the map, or into a car park. */
  left(vehicle: Vehicle): void {
    if (vehicle.purpose === PURPOSE.toGarage && this.garagesIn.some((l) => l.id === vehicle.link)) this.stats.intoGarages += 1;
  }

  step(traffic: RoadTraffic, dt: number, now: number, secondsOfDay: number): void {
    const share = hourlyShare(secondsOfDay) * this.scale;
    this.flights?.update(now);
    for (const errand of Object.keys(PEAK) as (keyof typeof PEAK)[]) {
      let rate = PEAK[errand] * share;
      if (errand === 'dropOff' || errand === 'pickUp') {
        if (this.flights) rate = this.flights.perHour[errand] * this.scale;
        this.curbDemandPerHour[errand] = rate;
      }
      this.owed[errand] += rate * dt / 3600;
      let tries = 0;
      while (this.owed[errand] >= 1 && tries < 2) {
        tries += 1;
        this.owed[errand] -= 1;
        if (!this.start(traffic, errand)) this.stats.turnedAway += 1;
      }
    }
  }
}

/** A vehicle stopped at a curb, for whoever puts people into and out of it. */
export function atCurb(vehicle: Vehicle): boolean {
  return vehicle.stoppedUntil >= 0 && (vehicle.purpose === PURPOSE.dropOff || vehicle.purpose === PURPOSE.pickUp);
}
