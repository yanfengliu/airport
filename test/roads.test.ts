// Road traffic moves: freeways near their limits at the morning peak, nobody stuck, nobody inside
// anybody else, cars at the curbs and every curb stop accounted for, three streams merging in
// turn, and the same seed giving the same day.
// Bound: forty simulated minutes of one morning, not a whole day; the soak test covers a day.

import { describe, expect, it } from 'vitest';
import type { Roads } from '../src/shared/layout.ts';
import { CONFIG } from '../src/sim/config.ts';
import { PURPOSE } from '../src/sim/roads/airport.ts';
import { RoadNet } from '../src/sim/roads/net.ts';
import { RoadSim } from '../src/sim/roads/roads.ts';
import { RoadTraffic } from '../src/sim/roads/traffic.ts';
import { Rng } from '../src/sim/rng.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const gates = layout.airfield.stands.filter((s) => s.contact);
const centre: [number, number] = [gates.reduce((sum, s) => sum + s.x, 0) / gates.length, gates.reduce((sum, s) => sum + s.y, 0) / gates.length];

function run(seed: number, minutes: number, each?: (roads: RoadSim, time: number) => void): RoadSim {
  const roads = new RoadSim(layout.roads, layout.land.bounds, centre, new Rng(seed).fork('roads'));
  let time = 7.5 * 3600;
  const end = time + minutes * 60;
  while (time < end) {
    time += CONFIG.dt;
    roads.step(CONFIG.dt, time, time);
    each?.(roads, time);
  }
  return roads;
}

const speedOn = (roads: RoadSim, name: string): number => {
  let n = 0;
  let sum = 0;
  for (const v of roads.traffic.vehicles) {
    if (roads.net.links[v.link].name !== name) continue;
    n += 1;
    sum += v.v;
  }
  return n ? sum / n : 0;
};

describe('road network', () => {
  const roads = new RoadSim(layout.roads, layout.land.bounds, centre, new Rng(1).fork('roads'));

  it('lets traffic in and out along both freeways', () => {
    const net = roads.net;
    for (const name of ['US 101', 'I 380']) {
      expect(net.links.some((l) => l.name === name && l.enters), `${name} has a way in`).toBe(true);
      expect(net.links.some((l) => l.name === name && l.exits), `${name} has a way out`).toBe(true);
    }
    // Both carriageways of US 101 carry traffic in at their own end of the map.
    expect(roads.through.peakOn('US 101')).toBeGreaterThan(5000);
  });

  it('has curbs on both levels of the terminal roads', () => {
    expect(roads.airport.departuresCurbs.length).toBeGreaterThanOrEqual(4);
    expect(roads.airport.arrivalsCurbs.length).toBeGreaterThanOrEqual(4);
  });
});

describe('road traffic at the morning peak', () => {
  let overlaps = 0;
  let curbStops = 0;
  /** Every vehicle out to set down or pick up, each with a stop planned; and those that were going a way that missed it. */
  const errands = new Set<number>();
  const astray = new Set<number>();
  const roads = run(7, 40, (r, time) => {
    for (const v of r.traffic.vehicles) {
      if (v.purpose !== PURPOSE.dropOff && v.purpose !== PURPOSE.pickUp) continue;
      errands.add(v.id);
      if (v.stopLink >= 0 && v.stoppedUntil < 0 && v.link !== v.stopLink && v.route.indexOf(v.stopLink, v.routeAt) < 0) astray.add(v.id);
    }
    if (Math.round(time / CONFIG.dt) % 20) return;
    overlaps += r.traffic.overlaps();
    curbStops = Math.max(curbStops, r.traffic.vehicles.filter((v) => v.stoppedUntil >= 0 && (v.purpose === PURPOSE.dropOff || v.purpose === PURPOSE.pickUp)).length);
  });

  it('keeps the freeways moving', () => {
    // Free flow is 65 mph; at the peak traffic is heavy but not stopped.
    expect(speedOn(roads, 'US 101')).toBeGreaterThan(18);
    expect(roads.traffic.stats.finished).toBeGreaterThan(5000);
  });

  it('leaves nobody standing still for long, at a red light or anywhere but a curb', () => {
    expect(roads.traffic.stats.longestStuck).toBeLessThan(300);
  });

  it('never has one vehicle inside another, in a lane or changing lanes', () => {
    expect(overlaps).toBe(0);
  });

  it('brings cars to the curbs and the garages', () => {
    const s = roads.airport.stats;
    // Counted when they pull up or drive in, not when they set out.
    expect(s.dropOffs).toBeGreaterThan(100);
    expect(s.pickUps).toBeGreaterThan(100);
    expect(s.intoGarages + s.outOfGarages).toBeGreaterThan(50);
    expect(curbStops).toBeGreaterThan(5);
    const t = roads.traffic.stats;
    expect(t.stopsMade).toBe(s.dropOffs + s.pickUps);
    expect(t.stopsMissed).toBeLessThan(0.05 * (t.stopsMade + t.stopsMissed));
  });

  it('accounts for every curb stop: made, given up, or still to come, and none lost with a vehicle that leaves', () => {
    const t = roads.traffic.stats;
    const toCome = roads.traffic.vehicles.filter((v) => v.stopLink >= 0 && v.stoppedUntil < 0).length;
    expect(t.stopsMade + t.stopsMissed + toCome).toBe(errands.size);
    // A driver who misses a turn on the way to the curb finds another way to it, not straight off the map.
    expect([...astray], 'vehicles going a way that does not pass their stop').toEqual([]);
  });
});

describe('a curb stop that cannot be made', () => {
  // Nothing leads onto a road where it comes onto the map: a stop there is on nobody's way.
  const roads = new RoadSim(layout.roads, layout.land.bounds, centre, new Rng(3).fork('roads'));
  roads.airport.scale = 0;
  const nowhere = roads.net.links.find((l) => l.enters)!;
  let time = 7.5 * 3600;
  const step = (): void => {
    time += CONFIG.dt;
    roads.step(CONFIG.dt, time, time);
  };
  for (let i = 0; i < 120; i += 1) step();
  const vehicle = roads.traffic.vehicles.find((v) => v.link !== nowhere.id)!;
  roads.traffic.planStop(vehicle, nowhere.id, 10, 30);
  while (!vehicle.gone && time < 9 * 3600) step();

  it('is counted as given up once the vehicle leaves the map with it still to make', () => {
    expect(vehicle.gone).toBe(true);
    const t = roads.traffic.stats;
    expect({ made: t.stopsMade, missed: t.stopsMissed }).toEqual({ made: 0, missed: 1 });
  });
});

describe('three streams merging into one lane at once', () => {
  // Three one-lane roads, alike but for their direction, run into one. A car waits at the end of
  // each, 10.0, 10.4 and 10.8 metres short of the join, and the further car has the lower number:
  // close enough that a merge judged with a margin, not to the metre, has each wait for another.
  const ends: [number, number][] = [
    [-100, 0],
    [-70.7, -70.7],
    [-70.7, 70.7],
  ];
  const roads: Roads = {
    nodes: [{ x: 0, y: 0, z: 0 }, ...ends.map(([x, y]) => ({ x, y, z: 0 })), { x: 100, y: 0, z: 0 }],
    edges: [
      ...ends.map(([x, y], k) => ({ a: k + 1, b: 0, pts: [x, y, 0, 0, 0, 0], len: 100, cls: 'primary' as const, lanes: 1, back: 0, speed: 15 })),
      { a: 0, b: 4, pts: [0, 0, 0, 100, 0, 0], len: 100, cls: 'primary', lanes: 1, back: 0, speed: 15 },
    ],
  };
  const net = new RoadNet(roads);
  const traffic = new RoadTraffic(net);
  const out = net.links.find((l) => l.from === 0)!.id;
  const rng = new Rng(1);
  // Spawned furthest first, so that the further a car stands, the lower its number.
  const cars = [10.8, 10.4, 10.0].map((short, k) => {
    const approach = net.links.find((l) => l.from === 3 - k)!;
    const car = traffic.spawn(rng, 'car', 0xffffff, approach.id, [out], 0)!;
    car.s = approach.len - short;
    return car;
  });
  const order: number[] = [];
  let now = 0;
  for (let i = 0; i < 60 / CONFIG.dt; i += 1) {
    now += CONFIG.dt;
    traffic.step(CONFIG.dt, now);
    for (const car of cars) if ((car.link === out || car.gone) && !order.includes(car.id)) order.push(car.id);
  }

  it('lets them through one at a time, in a strict order, rather than have each wait for another', () => {
    const [further, middle, nearest] = cars.map((c) => c.id);
    // To the metre the two nearest are level, and the lower number goes first; the furthest goes last.
    expect(order).toEqual([middle, nearest, further]);
  });
});

describe('road determinism', () => {
  it('gives the same traffic for the same seed, and different traffic for another', () => {
    const a = run(11, 10).checksum();
    const b = run(11, 10).checksum();
    const c = run(12, 10).checksum();
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
