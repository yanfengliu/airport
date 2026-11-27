// Everything on the public roads, stepped together: the network, the vehicles on it, and the
// traffic that enters at the edges of the map.

import type { Roads } from '../../shared/layout.ts';
import type { Rng } from '../rng.ts';
import { AirportTraffic } from './airport.ts';
import { ThroughTraffic } from './demand.ts';
import { RoadNet } from './net.ts';
import { RoadTraffic } from './traffic.ts';

/** A road that ends within this distance of the edge of the mapped area leaves the map there. */
const EDGE_MARGIN = 150;

export class RoadSim {
  readonly net: RoadNet;
  readonly traffic: RoadTraffic;
  readonly through: ThroughTraffic;
  readonly airport: AirportTraffic;

  /** `bounds` is the mapped area: west, south, east, north, in metres; `centre` the middle of the terminals. */
  constructor(roads: Roads, bounds: readonly [number, number, number, number], centre: readonly [number, number], rng: Rng) {
    this.net = new RoadNet(roads);
    this.traffic = new RoadTraffic(this.net);
    const [west, south, east, north] = bounds;
    const atEdge = (x: number, y: number): boolean => x < west + EDGE_MARGIN || x > east - EDGE_MARGIN || y < south + EDGE_MARGIN || y > north - EDGE_MARGIN;
    this.through = new ThroughTraffic(this.net, rng.fork('through'), atEdge);
    this.airport = new AirportTraffic(this.net, rng.fork('airport'), atEdge, centre);
    this.traffic.onArrive = (vehicle) => this.airport.arrived(vehicle);
    this.traffic.onLeave = (vehicle) => this.airport.left(vehicle);
  }

  step(dt: number, now: number, secondsOfDay: number): void {
    this.through.step(this.traffic, dt, secondsOfDay);
    this.airport.step(this.traffic, dt, now, secondsOfDay);
    this.traffic.step(dt, now);
  }

  /** A number that changes if anything about the traffic does; for the determinism test. */
  checksum(): number {
    let h = 2166136261;
    for (const v of this.traffic.vehicles) {
      h ^= (v.id * 31 + v.link * 7 + Math.round(v.s * 4)) | 0;
      h = Math.imul(h, 16777619);
    }
    return (h ^ this.traffic.stats.finished) >>> 0;
  }
}
