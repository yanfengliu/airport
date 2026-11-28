// The terminals' floor plan: every gate can be walked to from its concourse's checkpoint, and the
// concourses are joined after security as SFO's are, so a closed checkpoint can be gone round.
// Bound: the plan is built from the map; whether people actually take these ways is checked by
// the people tests and `node tools/sim/people.ts`.

import { describe, expect, it } from 'vitest';
import { courtyard3 } from '../src/shared/courtyard3.ts';
import { insidePolygon, withinAny } from '../src/sim/terminal/fittings.ts';
import { AIRLINES } from '../src/sim/fleet.ts';
import { UNREACHABLE } from '../src/sim/terminal/grid.ts';
import { buildTerminalPlan, FLOOR } from '../src/sim/terminal/plan.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const plan = buildTerminalPlan(layout, AIRLINES);

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
    const stations = plan.ways.filter((w) => w.kind === 'airtrain').map((w) => w.name);
    expect(stations).toContain('Terminals 2 and 3');
    expect(stations).not.toContain('Terminal 3');
    expect(plan.ways.filter((w) => w.kind === 'garage').length).toBeGreaterThanOrEqual(3);
  });

  it('walks between D1 and E4 in both directions through the mapped upper gallery only', () => {
    const gallery = courtyard3(layout.terminals)!;
    const inBuilding = withinAny(layout.terminals.buildings.map((b) => b.poly));
    const grid = plan.grids[FLOOR.airside];
    let galleryCells = 0;
    const invalid = [];
    for (let i = 0; i < grid.count; i++) {
      const x = grid.cx[i], y = grid.cy[i];
      if (inBuilding(x, y)) continue;
      if (!insidePolygon(gallery, x, y) || plan.grids[FLOOR.landside].cellAt(x, y) >= 0 || plan.grids[FLOOR.arrivals].cellAt(x, y) >= 0) invalid.push([x, y]);
      galleryCells++;
    }
    expect(invalid).toEqual([]);
    expect(galleryCells).toBeGreaterThan(50);
    for (const [from, to] of [['D1', 'E4'], ['E4', 'D1']]) {
      const end = plan.holdroom.get(to)!;
      const costs = plan.field(end);
      let at = plan.holdroom.get(from)!.cell;
      let throughGallery = false;
      for (let steps = 0; at !== end.cell && steps < 500; steps++) {
        const next = grid.neighbours.subarray(at * 8, at * 8 + 8).reduce((best, n) => n >= 0 && costs[n] < costs[best] ? n : best, at);
        expect(next).not.toBe(at);
        at = next;
        if (!inBuilding(grid.cx[at], grid.cy[at]) && insidePolygon(gallery, grid.cx[at], grid.cy[at])) throughGallery = true;
      }
      expect(at).toBe(end.cell);
      expect(throughGallery).toBe(true);
    }
  });

  it('joins every adjacent pair of concourses on foot after security', () => {
    const joined = (a: string, b: string): boolean => plan.field(plan.exit.get(a)!)[plan.exit.get(b)!.cell] !== UNREACHABLE;
    for (const [a, b] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'G']]) expect(joined(a, b), `${a} to ${b}`).toBe(true);
  });
});
