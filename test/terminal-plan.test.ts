// The terminals' floor plan: every gate can be walked to from its concourse's checkpoint, and the
// concourses are joined after security as SFO's are, so a closed checkpoint can be gone round.
// Bound: the plan is built from the map; whether people actually take these ways is checked by
// the people tests and `node tools/sim/people.ts`.

import { describe, expect, it } from 'vitest';
import { AIRLINES } from '../src/sim/fleet.ts';
import { UNREACHABLE } from '../src/sim/terminal/grid.ts';
import { buildTerminalPlan } from '../src/sim/terminal/plan.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const plan = buildTerminalPlan(loadLayoutFromDisk(), AIRLINES);

describe('the floor plan of the terminals', () => {
  it('lets every gate be walked to from its own concourse after security', () => {
    const unreached: string[] = [];
    for (const holdroom of plan.holdroom.values()) {
      const exit = plan.exit.get(holdroom.area);
      if (!exit) continue;
      if (plan.field(exit)[holdroom.cell] === UNREACHABLE) unreached.push(holdroom.name);
    }
    expect(unreached).toEqual([]);
  });

  it('has every way in and out: curbs on both levels, AirTrain, BART and the garages', () => {
    // A way the plan cannot place is dropped without a word, and its travellers quietly take the curb.
    const kinds = new Set(plan.ways.map((w) => w.kind));
    for (const kind of ['curb', 'pickup', 'airtrain', 'bart', 'garage'] as const) expect(kinds.has(kind), kind).toBe(true);
    expect(plan.ways.filter((w) => w.kind === 'garage').length).toBeGreaterThanOrEqual(3);
  });

  it('joins the concourses after security, A to D and E to G, as far as the map has buildings between them', () => {
    const joined = (a: string, b: string): boolean => plan.field(plan.exit.get(a)!)[plan.exit.get(b)!.cell] !== UNREACHABLE;
    for (const [a, b] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['E', 'F'], ['F', 'G']]) expect(joined(a, b), `${a} to ${b}`).toBe(true);
  });
});
