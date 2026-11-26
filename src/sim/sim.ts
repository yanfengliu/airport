// The simulation: one clock and every system that runs on it. No drawing, no browser: the same
// object runs under the page and under the tests.

import type { Layout } from '../shared/layout.ts';
import { TaxiNet } from './airfield/net.ts';
import { Airside } from './airside/airside.ts';
import { usableStands } from './airside/stands.ts';
import { SOUTHEAST_PLAN, WEST_PLAN } from './airside/tower.ts';
import { CONFIG } from './config.ts';
import { Rng } from './rng.ts';
import { DAY, buildSchedule, type Rotation } from './schedule.ts';

export interface SimOptions {
  seed: number;
  /** Clock time at which the simulation starts, seconds after midnight. */
  startTime: number;
  /** Aircraft visits per day; defaults to the configured number. */
  visitsPerDay?: number;
}

export class Sim {
  readonly layout: Layout;
  readonly seed: number;
  readonly rotations: Rotation[];
  /** Stands that can be reached from the runways and left for them, with the widest wingspan each takes. */
  readonly usableStands: ReadonlyMap<string, number>;
  readonly airside: Airside;
  /** Seconds since midnight of the first day. */
  time: number;
  steps = 0;

  constructor(layout: Layout, options: SimOptions) {
    this.layout = layout;
    this.seed = options.seed;
    this.time = options.startTime;
    const rng = new Rng(options.seed);
    const net = new TaxiNet(layout.airfield);
    const arrivalEnds = [...WEST_PLAN.arrivals, ...SOUTHEAST_PLAN.arrivals];
    const departureEnds = [...WEST_PLAN.departures, ...WEST_PLAN.longDepartures, ...SOUTHEAST_PLAN.departures];
    const usable = usableStands(net, arrivalEnds, departureEnds);
    this.usableStands = usable.span;
    const stands = layout.airfield.stands.filter((s) => usable.span.has(s.id)).map((s) => ({ ...s, span: usable.span.get(s.id)! }));
    this.rotations = buildSchedule(rng.fork('schedule'), stands, { visits: options.visitsPerDay ?? CONFIG.visitsPerDay, conflicts: usable.conflicts });
    this.airside = new Airside(net, usable, this.rotations, rng.fork('airside'), options.startTime);
  }

  get secondsOfDay(): number {
    return ((this.time % DAY) + DAY) % DAY;
  }

  /** Advance by one fixed step. */
  step(): void {
    const dt = CONFIG.dt;
    this.time += dt;
    this.steps += 1;
    this.airside.step(dt);
  }

  /** Advance by a span of simulated time. */
  run(seconds: number): void {
    const steps = Math.round(seconds / CONFIG.dt);
    for (let i = 0; i < steps; i += 1) this.step();
  }

  checksum(): number {
    return (this.airside.checksum() ^ Math.imul(this.steps, 2654435761)) >>> 0;
  }
}
