// The whole simulation: flights move in a short run, and the same seed gives the same airport.
// Bound: the day-long airside benchmark is `tools/sim/soak.ts`, which takes minutes; these take
// seconds and check far less.

import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();

describe('airside, briefly', () => {
  const sim = new Sim(layout, { seed: 3, startTime: 6 * 3600 });
  sim.run(2 * 3600);

  it('lands and launches aircraft', () => {
    expect(sim.airside.tower.stats.landings).toBeGreaterThanOrEqual(10);
    expect(sim.airside.tower.stats.takeoffs).toBeGreaterThanOrEqual(10);
  });

  it('uses most of the numbered gates', () => {
    const gates = layout.airfield.stands.filter((s) => s.contact);
    expect(gates.filter((s) => sim.usableStands.has(s.id)).length).toBeGreaterThanOrEqual(85);
  });

  it('never hands a piece of taxiway back out of turn', () => {
    expect(sim.airside.traffic.outOfOrder).toBe(0);
  });
});

describe('determinism', () => {
  it('gives the same airside after six hours for the same seed', () => {
    const run = (): number => {
      const sim = new Sim(layout, { seed: 21, startTime: 5 * 3600 });
      sim.run(6 * 3600);
      return sim.checksum();
    };
    expect(run()).toBe(run());
  });

  it('gives the same airport, roads and trains included, after an hour', () => {
    const run = (): number => {
      const sim = new Sim(layout, { seed: 5, startTime: 7 * 3600, roads: true });
      sim.run(3600);
      return sim.checksum();
    };
    expect(run()).toBe(run());
  });
});
