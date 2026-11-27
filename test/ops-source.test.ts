// The operations panel's numbers are the simulation's: movements that happened, in the hour they
// happened, whatever time of day the run starts. The app starts half an hour early, so a day opened
// at midnight runs through negative times, where "not happened yet" must not read as a time.

import { describe, expect, it } from 'vitest';
import { opsSnapshot } from '../src/app/ops-source.ts';
import { NOT_YET } from '../src/sim/airside/flights.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();

describe('operations panel numbers', () => {
  for (const [label, start] of [['midnight', 0], ['the morning peak', 8 * 3600]] as const) {
    it(`counts only movements that happened, in a day opened at ${label}`, () => {
      const sim = new Sim(layout, { seed: 7, startTime: start - 1800 });
      sim.run(1800 + 15 * 60);
      const ops = opsSnapshot(sim);
      const span = Math.max(600, Math.min(3600, sim.time - sim.startTime));
      let landed = 0;
      let airborne = 0;
      for (const v of sim.airside.book.visits.values()) {
        if (v.landedAt !== NOT_YET && v.landedAt > sim.time - span) landed += 1;
        if (v.airborneAt !== NOT_YET && v.airborneAt > sim.time - span) airborne += 1;
      }
      // No more in the window than the tower has cleared since the start.
      expect(landed).toBeLessThanOrEqual(sim.airside.tower.stats.landings);
      expect(airborne).toBeLessThanOrEqual(sim.airside.tower.stats.takeoffs);
      expect(ops.movements.arrivals).toBeCloseTo((landed * 3600) / span, 6);
      expect(ops.movements.departures).toBeCloseTo((airborne * 3600) / span, 6);
      // SFO lands at most about sixty an hour; a counter fooled by an unset time reads thousands.
      expect(ops.movements.arrivals).toBeLessThan(80);
      expect(ops.movements.departures).toBeLessThan(80);
      if (start === 0) expect(ops.movements.arrivalDelay).toBeLessThan(3600);
    });
  }
});
