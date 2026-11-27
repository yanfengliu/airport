// Everyone walking in the terminals follows a distance field downhill to where they are going
// (src/sim/terminal/grid.ts, src/sim/terminal/people.ts). Bound: on the floors as furnished, from
// all round every gate, where people wait for boarding, to its door, and from all over each floor to
// its checkpoints and check-in halls, at the paces people walk, hurry and run and with the offsets
// they keep in a cell, every walker gets there, in no more than three times the time its field's
// distance takes at its pace and five minutes more for the crowds the test makes at the door; and
// where two neighbouring cells each have two ways on as good as each other, nobody started on the
// line between them turns back and forth between the two for ever, as a traveller in the day of
// people once did until long after their flight had gone.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config.ts';
import { Sim } from '../src/sim/sim.ts';
import { UNREACHABLE } from '../src/sim/terminal/grid.ts';
import { ACT, People, ROLE, STEP } from '../src/sim/terminal/people.ts';
import { FLOOR_HEIGHT } from '../src/sim/terminal/plan.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';
import { once } from './helpers/once.ts';

const layout = loadLayoutFromDisk();

/** Paces, metres a second: walking, a hurrying family's, and running for a flight. */
const PACES = [1.1, 1.25, 1.45, CONFIG.turnaround.brisk[0], CONFIG.turnaround.brisk[1], CONFIG.turnaround.run[0], 3.6, CONFIG.turnaround.run[1]];
/** Offsets in a cell, as People.add makes them from the low bits of its jitter: each way, the most either side and none. */
const JITTERS = [0, 100, 199].flatMap((a) => [0, 100, 199].map((b) => a | (b << 8)));
/** The offset People.add makes from a jitter. */
const offsetOf = (j: number): [number, number] => [((j % 200) / 100 - 1) * 0.9, (((j >>> 8) % 200) / 100 - 1) * 0.9];
/** Where in its cell a walker starts, metres off its middle: anywhere, as from a seat or the end of a line. */
const STARTS = [-1.1, -0.4, 0.3, 1.0].flatMap((u) => [-1.0, -0.3, 0.4, 1.1].map((v) => [u, v] as const));
/** Offsets of a cell's neighbours beside it, as NavGrid keeps them. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** How a walker of each id breaks ties between ways on that are nearly as good (see People.walk, NavGrid.downhill). */
const tieBreak = (id: number): number => ((id * 2654435761) >>> 0) / 4294967296;

/** Walk them all, a step at a time as the simulation does; each is gone once there. Returns who never got nearer for five minutes. */
function walkAll(people: People, fieldOf: (id: number) => Uint16Array, ids: number[], until: number): number[] {
  const cell = (id: number): number => people.cell[id];
  const best = new Map(ids.map((id) => [id, Infinity]));
  const since = new Map(ids.map((id) => [id, 0]));
  const stuck: number[] = [];
  let left = ids;
  for (let now = 0; left.length && now < until; now += CONFIG.dt) {
    people.step(now, CONFIG.dt, 0, 1);
    left = left.filter((id) => {
      if (people.act[id] === ACT.idle) {
        people.remove(id);
        return false;
      }
      const d = fieldOf(id)[cell(id)];
      if (d < best.get(id)!) {
        best.set(id, d);
        since.set(id, now);
      } else if (now - since.get(id)! > 300) {
        stuck.push(id);
        return false;
      }
      return true;
    });
  }
  return [...stuck, ...left];
}

describe('walking in the terminals', () => {
  const terminals = once(() => new Sim(layout, { seed: 7, startTime: 6.5 * 3600, people: true }).terminals!);

  it('brings every walker to where they are going, from anywhere round it, at any pace and with any offset', () => {
    const t = terminals();
    const grids = t.plan.grids;
    const people = new People(120_000, grids, (floor) => FLOOR_HEIGHT[floor] ?? 0);
    const walkers: { id: number; field: Uint16Array; cap: number; what: string }[] = [];
    let n = 0;
    const gates = t.plan.places.filter((p) => p.kind === 'holdroom');
    // A gate in every eight, and the checkpoints and check-in halls, from all over the floor.
    const far = new Set([...gates.filter((_, i) => i % 8 === 0), ...t.plan.places.filter((p) => p.kind === 'checkpoint' || p.kind === 'checkin')]);
    for (const goal of t.plan.places) {
      const gate = goal.kind === 'holdroom';
      if (!gate && !far.has(goal)) continue;
      const grid = grids[goal.floor];
      const field = t.plan.field(goal);
      const f = people.addField(goal.floor, field, goal.x, goal.y);
      // From every cell within 40 m of each gate, where people wait for boarding; from all over
      // the floor, to the others.
      const every = far.has(goal) ? (gate ? 11 : 97) : 1;
      for (let c = n % every; c < grid.count; c += every) {
        if (field[c] === UNREACHABLE || (!far.has(goal) && Math.hypot(grid.cx[c] - goal.x, grid.cy[c] - goal.y) > 40)) continue;
        n += 1;
        const pace = PACES[n % PACES.length];
        const [u, v] = STARTS[(n * 7) % STARTS.length];
        const [x, y] = [grid.cx[c] + u, grid.cy[c] + v];
        const id = people.add(ROLE.passenger, goal.floor, x, y, pace, 0, JITTERS[(n * 5) % JITTERS.length]);
        people.setScript(id, [STEP.walk, f]);
        // The field counts a tenth of a 2.5 m cell a unit, and more for furniture; the test's own
        // crowds at the door slow the last of them.
        walkers.push({ id, field, cap: ((field[c] / 10) * grid.cell / pace) * 3 + 300, what: `${goal.kind} ${goal.name ?? goal.id} from ${x.toFixed(1)},${y.toFixed(1)} at ${pace} m/s` });
      }
    }
    expect(walkers.length).toBeGreaterThan(10_000);
    let left = walkers;
    for (let now = 0; left.length && now < 4000; now += CONFIG.dt) {
      people.step(now, CONFIG.dt, 0, 1);
      const late = left.filter((w) => now > w.cap);
      expect(late.map((w) => `${w.what}: not there after ${w.cap.toFixed(0)} s`).slice(0, 5)).toEqual([]);
      left = left.filter((w) => {
        if (people.act[w.id] !== ACT.idle) return true;
        people.remove(w.id);
        return false;
      });
    }
    expect(left.length).toBe(0);
  });

  it('turns nobody back and forth between two cells where each has two ways on as good as each other', () => {
    const t = terminals();
    const grids = t.plan.grids;
    const people = new People(60_000, grids, (floor) => FLOOR_HEIGHT[floor] ?? 0);
    const fieldOf = new Map<number, Uint16Array>();
    const traps: number[] = [];
    // To every gate: for each cell and each neighbour beside it, the cells each of them steps on
    // to, as a walker breaking ties either way would; where the line between those two aim points
    // (a cell's middle and the walker's offset) crosses from the one cell straight into the other,
    // a walker starts on it just short of the edge, as one coming that way would cross it.
    for (const goal of t.plan.places) {
      if (goal.kind !== 'holdroom') continue;
      const grid = grids[goal.floor];
      const half = grid.cell / 2;
      const field = t.plan.field(goal);
      const f = people.addField(goal.floor, field, goal.x, goal.y);
      const down = [0.1, 0.9].map((choice) => Int32Array.from({ length: grid.count }, (_, c) => (field[c] === UNREACHABLE || field[c] <= 12 ? -1 : grid.downhill(field, c, choice))));
      for (let a = 0; a < grid.count; a += 1) {
        for (let k = 0; k < 4; k += 1) {
          const b = grid.neighbours[a * 8 + k];
          if (b < 0) continue;
          const [nx, ny] = [DX[k], DY[k]];
          for (const [w, low] of [[0, true], [1, false]] as const) {
            const [ta, tb] = [down[w][a], down[w][b]];
            if (ta < 0 || tb < 0 || ta === a || tb === b || ta === b || tb === a) continue;
            for (const j of JITTERS) {
              const [ox, oy] = offsetOf(j);
              const [px, py, qx, qy] = [grid.cx[ta] + ox, grid.cy[ta] + oy, grid.cx[tb] + ox, grid.cy[tb] + oy];
              // Where the line from b's aim to a's crosses the edge from a into b.
              const edge = grid.cx[a] * nx + grid.cy[a] * ny + half;
              const [p, q] = [px * nx + py * ny, qx * nx + qy * ny];
              if (!(q < edge && edge < p)) continue;
              const s = (edge - q) / (p - q);
              const [x, y] = [qx + (px - qx) * s, qy + (py - qy) * s];
              if (Math.abs((x - grid.cx[a]) * -ny + (y - grid.cy[a]) * nx) > half - 0.05) continue;
              const length = Math.hypot(px - qx, py - qy);
              const start: [number, number] = [x - ((px - qx) / length) * 0.02, y - ((py - qy) / length) * 0.02];
              if (grid.cellAt(...start) !== a) continue;
              // An id that breaks ties this way; those skipped over stand idle and are gone at once.
              while (tieBreak(people.high) < 0.4 !== low) people.add(ROLE.passenger, goal.floor, ...start, 1, 0, 0);
              const id = people.add(ROLE.passenger, goal.floor, ...start, PACES[traps.length % PACES.length], 0, j);
              people.setScript(id, [STEP.walk, f]);
              fieldOf.set(id, field);
              traps.push(id);
            }
          }
        }
      }
    }
    expect(traps.length).toBeGreaterThan(300);
    const walking = new Set(traps);
    for (let id = 0; id < people.high; id += 1) if (!walking.has(id)) people.remove(id);
    const stuck = walkAll(people, (id) => fieldOf.get(id)!, traps, 3000);
    expect(stuck.slice(0, 5).map((id) => `${people.x[id].toFixed(1)},${people.y[id].toFixed(1)} at ${people.speed[id]} m/s`)).toEqual([]);
  });
});
