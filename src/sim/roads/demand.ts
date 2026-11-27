// Who drives where: through traffic on the freeways and streets, entering at the edges of the
// map and leaving at another edge, at volumes that follow the hours of the day.

import type { Rng } from '../rng.ts';
import type { Link, RoadNet } from './net.ts';
import type { RoadTraffic, Vehicle, VehicleKind } from './traffic.ts';

/** Share of the daily peak flowing in each hour of the day. */
const HOURLY = [0.12, 0.08, 0.07, 0.08, 0.15, 0.36, 0.7, 0.95, 1, 0.86, 0.76, 0.75, 0.78, 0.8, 0.86, 0.95, 1, 1, 0.9, 0.7, 0.55, 0.45, 0.32, 0.2];

/** Vehicles an hour that one lane brings in at the peak, by the kind of road. */
const LANE_FLOW: Record<string, number> = { motorway: 1150, trunk: 700, primary: 380, secondary: 240, tertiary: 150 };

const KINDS: [VehicleKind, number][] = [['car', 52], ['suv', 30], ['van', 7], ['truck', 7], ['taxi', 3], ['bus', 1]];

const PAINT = [0xf1f2f3, 0xe3e5e8, 0x1e2126, 0x2b2e33, 0x8a9099, 0xb7bcc3, 0x5f6670, 0x7d1f24, 0xa32a2f, 0x1f3a66, 0x2f5d94, 0x36506b, 0x4a5a44, 0x6d5a45, 0xc9b8a0, 0x3c3f45];

export function paintFor(rng: Rng, kind: VehicleKind): number {
  if (kind === 'taxi') return 0xf2c21b;
  if (kind === 'bus') return rng.pick([0xe8eaec, 0x2f6f9f, 0xc7372f]);
  if (kind === 'truck') return rng.pick([0xe8eaec, 0xdadde0, 0x2c4a7a, 0x8a2b2b, 0x3f4349]);
  // White, grey, silver and black are most of what is on the road.
  return rng.chance(0.62) ? rng.pick(PAINT.slice(0, 7)) : rng.pick(PAINT);
}

export function hourlyShare(secondsOfDay: number): number {
  const h = (secondsOfDay / 3600) % 24;
  const a = HOURLY[Math.floor(h) % 24];
  const b = HOURLY[(Math.floor(h) + 1) % 24];
  return a + (b - a) * (h - Math.floor(h));
}

interface Entry {
  link: Link;
  /** Vehicles an hour at the peak. */
  peak: number;
  /** Exits it sends traffic to, with cumulative shares, and the route to each. */
  exits: { link: number; share: number; route: number[] }[];
  owed: number;
}

export class ThroughTraffic {
  private readonly entries: Entry[] = [];
  private readonly rng: Rng;
  /** Multiplies every volume; 1 is a normal weekday. */
  scale = 1;
  backlog = 0;
  /**
   * Per road entering the map, by name: vehicles that wanted to come in, that did, and that got
   * through, driving off the map at its edge.
   */
  readonly roads = new Map<string, RoadCount>();
  /** Vehicles that came in here and have not left yet, by id, with the count of the road they came in on. */
  private readonly onMap = new Map<number, RoadCount>();
  /** Links that end where the map does. */
  private readonly offMap: Set<number>;

  private byRoad(name: string): RoadCount {
    let road = this.roads.get(name);
    if (!road) {
      road = { requested: 0, admitted: 0, completed: 0 };
      this.roads.set(name, road);
    }
    return road;
  }

  /** `atEdge` says whether a point is where the mapped area ends; a dead end elsewhere is just a dead end. */
  constructor(net: RoadNet, rng: Rng, atEdge: (x: number, y: number) => boolean) {
    this.rng = rng;
    const entering = net.links.filter((l) => l.enters && LANE_FLOW[l.cls] !== undefined && atEdge(l.pts[0], l.pts[1]));
    const leaving = net.links.filter((l) => l.exits && LANE_FLOW[l.cls] !== undefined && atEdge(l.pts[l.pts.length - 3], l.pts[l.pts.length - 2]));
    this.offMap = new Set(net.links.filter((l) => l.exits && atEdge(l.pts[l.pts.length - 3], l.pts[l.pts.length - 2])).map((l) => l.id));
    for (const link of entering) {
      const options: { link: number; weight: number; route: number[] }[] = [];
      for (const exit of leaving) {
        // Not straight back out where it came in.
        if (exit.edge === link.edge) continue;
        const ex = exit.pts[exit.pts.length - 3];
        const ey = exit.pts[exit.pts.length - 2];
        if (Math.hypot(ex - link.pts[0], ey - link.pts[1]) < 600) continue;
        const route = net.route(link.id, (l) => l.id === exit.id);
        if (!route) continue;
        let weight = exit.lanes * LANE_FLOW[exit.cls];
        // Most traffic stays on the road it is on.
        if (exit.name && exit.name === link.name) weight *= 9;
        else weight *= 0.35;
        options.push({ link: exit.id, weight, route });
      }
      const total = options.reduce((s, o) => s + o.weight, 0);
      if (!total) continue;
      let run = 0;
      // A road that ends inside the map, so that all its traffic has to turn off, brings less.
      const through = options.some((o) => net.links[o.link].name !== '' && net.links[o.link].name === link.name);
      this.entries.push({
        link,
        peak: link.lanes * LANE_FLOW[link.cls] * (through ? 1 : 0.55),
        exits: options.map((o) => {
          run += o.weight / total;
          return { link: o.link, share: run, route: o.route };
        }),
        owed: 0,
      });
    }
  }

  get entryCount(): number {
    return this.entries.length;
  }

  /** Peak vehicles an hour entering on links whose name matches, for checking volumes. */
  peakOn(name: string): number {
    return this.entries.filter((e) => e.link.name === name).reduce((s, e) => s + e.peak, 0) * this.scale;
  }

  step(traffic: RoadTraffic, dt: number, secondsOfDay: number): void {
    const share = hourlyShare(secondsOfDay) * this.scale;
    for (const entry of this.entries) {
      const wanted = (entry.peak * share * dt) / 3600;
      entry.owed += wanted;
      const road = this.byRoad(entry.link.name);
      road.requested += wanted;
      // A little randomness in the gaps, without losing the count.
      let tries = 0;
      while (entry.owed >= 1 && tries < 3) {
        tries += 1;
        if (entry.owed < 2 && !this.rng.chance(0.55)) break;
        const roll = this.rng.next();
        const exit = entry.exits.find((e) => roll <= e.share) ?? entry.exits[entry.exits.length - 1];
        const kind = this.rng.weighted(KINDS, (k) => k[1])[0];
        const vehicle = traffic.spawn(this.rng, kind, paintFor(this.rng, kind), entry.link.id, exit.route, entry.link.speed * 0.9);
        if (!vehicle) break;
        entry.owed -= 1;
        road.admitted += 1;
        this.onMap.set(vehicle.id, road);
      }
      // What cannot get in is the tail of a queue beyond the map; do not let it grow without end.
      if (entry.owed > 40) {
        this.backlog += entry.owed - 40;
        entry.owed = 40;
      }
    }
  }

  /** A vehicle has driven off the end of a road: one that came in here got through if that is the edge of the map. */
  left(vehicle: Vehicle): void {
    const road = this.onMap.get(vehicle.id);
    if (!road) return;
    this.onMap.delete(vehicle.id);
    if (this.offMap.has(vehicle.link)) road.completed += 1;
  }
}

/** For one road entering the map: vehicles that wanted to come in (fractions build up), that did, and that got through. */
interface RoadCount {
  requested: number;
  admitted: number;
  completed: number;
}
