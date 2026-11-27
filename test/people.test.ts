// People in the terminals over a morning: nobody goes missing from the books, security keeps up,
// bags get where they are going, and staff are at work. Bound: the full day is
// `node tools/sim/people.ts --start 04:00 --hours 24`, which takes about a minute; this runs the
// first morning wave, three hours, and checks the same things on it.

import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim.ts';
import { ROLE } from '../src/sim/terminal/people.ts';
import { percentile } from '../src/sim/terminal/terminals.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();

describe('people in the terminals, over a morning', () => {
  const sim = new Sim(layout, { seed: 3, startTime: 5 * 3600, people: true });
  sim.run(3 * 3600);
  const t = sim.terminals!;
  const s = t.stats;
  const here = t.audit();

  it('accounts for everyone it creates', () => {
    expect(s.departing.created).toBeGreaterThan(5000);
    expect(s.arriving.created).toBeGreaterThan(1000);
    expect(s.departing.created - s.departing.boarded - s.departing.missed - s.departing.cancelled - here.departingHere - here.departingRiding).toBe(0);
    expect(s.arriving.created - s.arriving.left - here.arrivingHere).toBe(0);
  });

  it('boards almost everyone whose flight leaves', () => {
    expect(s.departing.boarded).toBeGreaterThan(3000);
    expect(s.departing.missed).toBeLessThan(0.02 * (s.departing.boarded + s.departing.missed));
  });

  it('has passengers change planes airside, and almost all of them make their connection', () => {
    expect(s.connecting.created).toBeGreaterThan(50);
    expect(s.connecting.boarded).toBeGreaterThan(0);
    expect(s.connecting.boarded + s.connecting.missed).toBeLessThanOrEqual(s.connecting.created);
    expect(s.connecting.missed).toBeLessThan(0.02 * Math.max(50, s.connecting.boarded + s.connecting.missed));
  });

  it('keeps the wait at security under half an hour for 95 in 100', () => {
    expect(s.security.served).toBeGreaterThan(3000);
    // Those still in line when the morning ends count too, as if served now.
    expect(percentile(t.waitsWithLines('checkpoint'), 0.95)).toBeLessThan(30 * 60);
  });

  it('accounts for every bag, and mishandles fewer than one in a hundred', () => {
    const bags = s.bags;
    expect(bags.checked).toBeGreaterThan(2000);
    expect(bags.arrived).toBeGreaterThan(500);
    // Every checked bag has exactly one outcome, and every arriving one is collected, lost or still inside.
    expect(bags.loaded + bags.leftBehind + bags.misrouted + bags.returned).toBe(bags.checked);
    expect(bags.collected + bags.lost + t.arrivingBagsInside()).toBe(bags.arrived);
    expect(bags.leftBehind + bags.misrouted + bags.lost).toBeLessThan(0.01 * (bags.checked + bags.arrived));
  });

  it('has staff of each kind at work, and shops taking money', () => {
    const roles = new Map<number, number>();
    for (let id = 0; id < t.people.high; id += 1) if (t.people.alive[id]) roles.set(t.people.role[id], (roles.get(t.people.role[id]) ?? 0) + 1);
    for (const role of [ROLE.security, ROLE.agent, ROLE.gate, ROLE.shop, ROLE.cleaner, ROLE.officer]) expect(roles.get(role) ?? 0).toBeGreaterThan(0);
    expect(Object.values(s.takings).reduce((a, b) => a + b, 0)).toBeGreaterThan(1000);
  });
});

describe('a start after boarding has begun', () => {
  it('has the travellers of flights already boarding on board, not left to miss them', () => {
    // At 06:00 a first wave of flights leaves within minutes, their boarding begun before the start.
    const sim = new Sim(layout, { seed: 3, startTime: 6 * 3600, people: true });
    sim.run(1800);
    const s = sim.terminals!.stats.departing;
    expect(s.boarded).toBeGreaterThan(1000);
    expect(s.missed).toBeLessThan(0.02 * (s.boarded + s.missed));
  });
});

describe('a closed checkpoint', () => {
  // The same morning twice, with Checkpoint C open and with it closed from the start.
  const run = (close: boolean): Sim => {
    const sim = new Sim(layout, { seed: 4, startTime: 7 * 3600, people: true });
    const t = sim.terminals!;
    const c = t.plan.checkpoint.get('C')!;
    if (close) expect(t.setCheckpointClosed(c.id, true)).toBeNull();
    sim.run(5400);
    return sim;
  };
  const open = run(false);
  const closed = run(true);
  const queue = (sim: Sim, area: string) => sim.terminals!.queues.get(sim.terminals!.plan.checkpoint.get(area)!.id)!;

  it('empties its line and shuts its lanes', () => {
    expect(queue(closed, 'C').line.length).toBe(0);
    expect(queue(closed, 'C').openServers).toBe(0);
    expect(queue(closed, 'C').totalServed).toBeLessThan(queue(open, 'C').totalServed / 2);
  });

  it('sends its travellers through the next checkpoint, and loses nobody', () => {
    expect(queue(closed, 'D').totalServed).toBeGreaterThan(queue(open, 'D').totalServed);
    const s = closed.terminals!.stats.departing;
    const here = closed.terminals!.audit();
    expect(s.created - s.boarded - s.missed - s.cancelled - here.departingHere - here.departingRiding).toBe(0);
  });

  it('is refused when it would leave a concourse with no way through security', () => {
    const t = closed.terminals!;
    // E, F and G are joined to each other after security and to nothing else: two of them can close, not all three.
    expect(t.setCheckpointClosed(t.plan.checkpoint.get('E')!.id, true)).toBeNull();
    expect(t.setCheckpointClosed(t.plan.checkpoint.get('F')!.id, true)).toBeNull();
    expect(t.setCheckpointClosed(t.plan.checkpoint.get('G')!.id, true)).toMatch(/No other way/);
  });
});

describe('departing passengers once the day is running', () => {
  // At the start some are placed where they would be by now; after that, everyone comes in by a
  // door and goes through check-in and security, however close to departure they come.
  const sim = new Sim(layout, { seed: 6, startTime: 9 * 3600, people: true });
  sim.run(10 * 60);
  const placedAtStart = sim.terminals!.stats.departing.placed;
  const createdAtStart = sim.terminals!.stats.departing.created;
  sim.run(80 * 60);
  const s = sim.terminals!.stats.departing;

  it('places nobody part-way along after the start', () => {
    expect(placedAtStart).toBeGreaterThan(0);
    expect(s.created - createdAtStart).toBeGreaterThan(1000);
    expect(s.placed).toBe(placedAtStart);
  });
});

describe('people and the trains', () => {
  // With the roads on, AirTrain and BART run, and those who come and go by them ride them.
  const sim = new Sim(layout, { seed: 5, startTime: 7 * 3600, roads: true, people: true });
  const loads = { airtrain: 0, bart: 0 };
  let riding = 0;
  for (let k = 0; k < 40; k += 1) {
    sim.run(60);
    for (const train of sim.transit!.trains) {
      const kind = sim.transit!.routes[train.route].kind;
      if (kind === 'airtrain' || kind === 'bart') loads[kind] = Math.max(loads[kind], train.load);
    }
    riding = Math.max(riding, sim.terminals!.audit().departingRiding);
  }
  const t = sim.terminals!;

  it('brings travellers in off the trains and takes others away on them', () => {
    expect(t.stats.byTrain.off).toBeGreaterThan(100);
    expect(t.stats.byTrain.on).toBeGreaterThan(50);
    expect(loads.airtrain).toBeGreaterThan(0);
    expect(loads.bart).toBeGreaterThan(0);
    // Between trains, some are still on their way.
    expect(riding).toBeGreaterThan(0);
  });

  it('still accounts for everyone, those on the trains included', () => {
    const s = t.stats;
    const here = t.audit();
    expect(s.departing.created - s.departing.boarded - s.departing.missed - s.departing.cancelled - here.departingHere - here.departingRiding).toBe(0);
    expect(s.arriving.created - s.arriving.left - here.arrivingHere).toBe(0);
  });
});

describe('determinism with people', () => {
  it('gives the same terminals after an hour for the same seed', () => {
    const run = (): number => {
      const sim = new Sim(layout, { seed: 8, startTime: 7 * 3600, people: true });
      sim.run(3600);
      return sim.checksum();
    };
    expect(run()).toBe(run());
  });
});
