// The simulation: one clock and every system that runs on it. No drawing, no browser: the same
// object runs under the page and under the tests.

import type { Layout } from '../shared/layout.ts';
import { TaxiNet } from './airfield/net.ts';
import { Airside } from './airside/airside.ts';
import { usableStands } from './airside/stands.ts';
import { SOUTHEAST_PLAN, WEST_PLAN } from './airside/tower.ts';
import { CONFIG } from './config.ts';
import { Rng } from './rng.ts';
import { RoadSim } from './roads/roads.ts';
import { DAY, buildSchedule, type Rotation } from './schedule.ts';
import { Terminals } from './terminal/terminals.ts';
import { buildTransit } from './transit/routes.ts';
import type { Transit } from './transit/trains.ts';
import type { Weather } from './weather.ts';

export interface SimOptions {
  seed: number;
  /** Clock time at which the simulation starts, seconds after midnight. */
  startTime: number;
  /** Aircraft visits per day; defaults to the configured number. */
  visitsPerDay?: number;
  /** Run the public roads too. Off unless asked for, so the airside can be studied alone. */
  roads?: boolean;
  /** Run the people in the terminals: passengers, queues, bags, shops and staff. */
  people?: boolean;
  /** The weather at the start, which sets the runways; clear with a west wind unless given. */
  weather?: Weather;
}

export class Sim {
  readonly layout: Layout;
  readonly seed: number;
  readonly rotations: Rotation[];
  /** Stands that can be reached from the runways and left for them, with the widest wingspan each takes. */
  readonly usableStands: ReadonlyMap<string, number>;
  readonly airside: Airside;
  /** Traffic on the public roads, when the simulation was started with it. */
  readonly roads: RoadSim | null;
  /** AirTrain, BART and Caltrain, when the simulation was started with the roads. */
  readonly transit: Transit | null;
  /** Passengers, staff and bags in the terminals, when the simulation was started with people. */
  readonly terminals: Terminals | null;
  /** False while the roads stand still and the rest runs, as when warming up. */
  private roadsRunning = true;
  /** Seconds since midnight of the first day. */
  time: number;
  /** When the run began, seconds since midnight of the first day. */
  readonly startTime: number;
  steps = 0;

  constructor(layout: Layout, options: SimOptions) {
    this.layout = layout;
    this.seed = options.seed;
    this.time = options.startTime;
    this.startTime = options.startTime;
    const rng = new Rng(options.seed);
    const net = new TaxiNet(layout.airfield);
    const arrivalEnds = [...WEST_PLAN.arrivals, ...SOUTHEAST_PLAN.arrivals];
    const departureEnds = [...WEST_PLAN.departures, ...WEST_PLAN.longDepartures, ...SOUTHEAST_PLAN.departures];
    const usable = usableStands(net, arrivalEnds, departureEnds);
    this.usableStands = usable.span;
    const stands = layout.airfield.stands.filter((s) => usable.span.has(s.id)).map((s) => ({ ...s, span: usable.span.get(s.id)! }));
    this.rotations = buildSchedule(rng.fork('schedule'), stands, { visits: options.visitsPerDay ?? CONFIG.visitsPerDay, conflicts: usable.conflicts });
    this.airside = new Airside(net, usable, this.rotations, rng.fork('airside'), options.startTime);
    if (options.weather) this.airside.setWeather(options.weather, true);
    // The middle of the terminals: the gates stand all round it.
    const gates = layout.airfield.stands.filter((s) => s.contact);
    const centre: [number, number] = [gates.reduce((sum, s) => sum + s.x, 0) / gates.length, gates.reduce((sum, s) => sum + s.y, 0) / gates.length];
    this.roads = options.roads ? new RoadSim(layout.roads, layout.land.bounds, centre, rng.fork('roads')) : null;
    this.transit = options.roads ? buildTransit(layout.rail) : null;
    this.terminals = options.people ? new Terminals(layout, this.airside.book, rng.fork('terminals'), options.startTime) : null;
    // With people simulated, they are counted off and on the aircraft one party at a time.
    if (this.terminals) this.airside.passengersElsewhere = true;
    // With trains as well, those who come and go by AirTrain and BART ride them.
    if (this.terminals && this.transit) this.terminals.connectTrains(this.transit);
  }

  get secondsOfDay(): number {
    return ((this.time % DAY) + DAY) % DAY;
  }

  // ---- commands: what the operations panel may change ----------------------------------------

  /** New weather; the runways follow it, with a changeover if the plan changes. */
  setWeather(weather: Weather): void {
    this.airside.setWeather(weather);
  }

  /** Close a runway (by its id, such as "10L/28R") to new movements, or open it again. */
  setRunwayClosed(runway: string, closed: boolean): void {
    this.airside.setRunwayClosed(runway, closed);
  }

  /** Close a security checkpoint (by its place id) or open it again; the reason when it cannot be closed. */
  setCheckpointClosed(place: number, closed: boolean): string | null {
    return this.terminals ? this.terminals.setCheckpointClosed(place, closed) : 'No people in this run';
  }

  /** Advance by one fixed step. */
  step(): void {
    const dt = CONFIG.dt;
    this.time += dt;
    this.steps += 1;
    this.airside.step(dt);
    if (this.roads && this.roadsRunning) this.roads.step(dt, this.time, this.secondsOfDay);
    if (this.transit) this.transit.step(dt, this.time);
    if (this.terminals) this.terminals.step(this.time, dt);
  }

  /** Advance by a span of simulated time. */
  run(seconds: number): void {
    const steps = Math.round(seconds / CONFIG.dt);
    for (let i = 0; i < steps; i += 1) this.step();
  }

  /**
   * Run up to the time a viewer first sees: `seconds` in all, the roads only for the last
   * `roadsFor` of them, since they fill in a few minutes while the airfield takes longer to get
   * its aircraft into place, and they are the costliest to run.
   */
  warmUp(seconds: number, roadsFor: number): void {
    this.roadsRunning = false;
    this.run(Math.max(0, seconds - roadsFor));
    this.roadsRunning = true;
    this.run(Math.min(seconds, roadsFor));
  }

  checksum(): number {
    return (this.airside.checksum() ^ (this.roads ? this.roads.checksum() : 0) ^ (this.terminals ? this.terminals.checksum() : 0) ^ Math.imul(this.steps, 2654435761)) >>> 0;
  }
}
