// The airside benchmark's runway-conflict judge (tools/sim/conflicts.ts), given cases it must call
// conflicts and cases it must not. A clean day of flights passes an incomplete judge as readily
// as a complete one, so each blind spot it has had is put to it here: an arrival in the flare,
// which keeps its approach phase until its wheels touch (review 1, R3); a landing behind a slower
// landing, once excused as if it were a departure (review 0, F6); a slow roll-out and a departure
// not yet far enough down the runway (review 0, F56). Bound: one straight runway strip.

import { describe, expect, it } from 'vitest';
import { THRESHOLD_HEIGHT, runwayConflicts, type Placed, type Strip } from '../tools/sim/conflicts.ts';

/** A runway 3,000 m long running east from the origin. */
const strip: Strip = { id: 'test', x: 0, y: 0, ux: 1, uy: 0, length: 3000 };
const EAST = 0;
const NORTH = Math.PI / 2;

let nextId = 1;
/** An aircraft `along` metres down the runway and `across` metres north of its centreline. */
const at = (along: number, across: number, phase: string, speed: number, heading: number, alt = 0): Placed => ({ id: nextId++, x: along, y: across, alt, speed, heading, phase });

const conflicts = (list: Placed[]): string[] => {
  const found = new Set<string>();
  runwayConflicts([strip], list, found, (a, b) => `#${a.id} towards #${b.id}`, []);
  return [...found];
};

describe('the runway-conflict judge', () => {
  it('calls an arrival in the flare towards traffic crossing ahead a conflict', () => {
    // Over the runway at 2 m and 70 m/s, its wheels not yet down; a taxiing aircraft crosses 80 m ahead.
    const flaring = at(400, 0, 'approach', 70, EAST, 2);
    const crossing = at(480, 0, 'taxiOut', 8, NORTH);
    expect(conflicts([flaring, crossing])).toEqual([`${flaring.id}:${crossing.id}`]);
    // Just below the height it crosses the threshold at, it is over the runway and judged the same.
    const lower = at(300, 0, 'approach', 72, EAST, THRESHOLD_HEIGHT - 0.5);
    const across = at(700, 5, 'taxiIn', 6, NORTH);
    expect(conflicts([lower, across])).toEqual([`${lower.id}:${across.id}`]);
  });

  it('calls a landing behind a slower landing a conflict, however far down the runway and fast the one ahead', () => {
    // Review 0's case: two landings 100 m apart at 75 and 55 m/s.
    const behind = at(500, 0, 'landing', 75, EAST);
    const ahead = at(600, 0, 'landing', 55, EAST);
    expect(conflicts([behind, ahead])).toEqual([`${behind.id}:${ahead.id}`]);
    // Only a departure ahead is let go once it is far down and fast: a landing there is still in the way.
    const following = at(1500, 0, 'landing', 75, EAST);
    const long = at(1600, 0, 'landing', 62, EAST);
    expect(conflicts([following, long])).toEqual([`${following.id}:${long.id}`]);
  });

  it('calls a slow roll-out and a departure not far enough ahead conflicts', () => {
    const slow = at(2000, 0, 'landing', 15, EAST);
    const standing = at(2250, 10, 'taxiIn', 3, NORTH);
    expect(conflicts([slow, standing])).toEqual([`${slow.id}:${standing.id}`]);
    // A departure ahead the same way is out of the way only once it is far down the runway and fast.
    const landing = at(300, 0, 'landing', 70, EAST);
    const departing = at(1100, 0, 'takeoff', 65, EAST);
    expect(conflicts([landing, departing])).toEqual([`${landing.id}:${departing.id}`]);
  });

  it('finds nothing where the runway ahead is clear', () => {
    const landing = at(800, 0, 'landing', 68, EAST);
    // Holding short, outside the strip; crossing behind it; and a departure ahead the same way,
    // within reach but far down the runway and fast, as the tower releases a landing behind one.
    const holding = at(900, -80, 'taxiOut', 0, NORTH);
    const behind = at(200, 0, 'taxiIn', 6, NORTH);
    const away = at(1700, 0, 'takeoff', 70, EAST);
    expect(conflicts([landing, holding, behind, away])).toEqual([]);
    // An arrival in the flare with the runway clear ahead, traffic holding short beside it.
    const flaring = at(150, 0, 'approach', 70, EAST, 4);
    const short = at(400, 75, 'taxiOut', 0, -NORTH);
    expect(conflicts([flaring, short])).toEqual([]);
  });
});
