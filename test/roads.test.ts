// Road traffic moves: freeways near their limits at the morning peak, nobody stuck, nobody inside
// anybody else, cars at the curbs, and the same seed giving the same day.
// Bound: forty simulated minutes of one morning, not a whole day; the soak test covers a day.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config.ts';
import { PURPOSE } from '../src/sim/roads/airport.ts';
import { RoadSim } from '../src/sim/roads/roads.ts';
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
  const roads = run(7, 40, (r, time) => {
    if (Math.round(time / CONFIG.dt) % 20) return;
    overlaps += r.traffic.overlaps();
    curbStops = Math.max(curbStops, r.traffic.vehicles.filter((v) => v.stoppedUntil >= 0 && (v.purpose === PURPOSE.dropOff || v.purpose === PURPOSE.pickUp)).length);
  });

  it('keeps the freeways moving', () => {
    // Free flow is 65 mph; at the peak traffic is heavy but not stopped.
    expect(speedOn(roads, 'US 101')).toBeGreaterThan(18);
    expect(roads.traffic.stats.finished).toBeGreaterThan(5000);
  });

  it('leaves nobody standing for long away from a curb or a red light', () => {
    expect(roads.traffic.stats.longestStuck).toBeLessThan(300);
  });

  it('never has one vehicle inside another', () => {
    expect(overlaps).toBe(0);
  });

  it('brings cars to the curbs and the garages', () => {
    const s = roads.airport.stats;
    expect(s.dropOffs).toBeGreaterThan(100);
    expect(s.pickUps).toBeGreaterThan(100);
    expect(s.intoGarages + s.outOfGarages).toBeGreaterThan(50);
    expect(curbStops).toBeGreaterThan(5);
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
