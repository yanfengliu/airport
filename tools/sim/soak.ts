#!/usr/bin/env node
// The airside benchmark: a full day of flights for each of several seeds, judged against fixed
// limits. This is the instrument for the ground-traffic work; change what it measures only with
// evidence that it misstates the requirement, and keep the old numbers when you do.
//
//   node tools/sim/soak.ts [--seeds 7,11,3,21,42] [--hours 26] [--start 04:00] [--json]
//
// A seed passes when, over the run:
//   - at least 99% of the day's flights land and at least 99% take off;
//   - no aircraft waits more than 20 minutes on the ground for the way ahead;
//   - go-arounds are at most 3% of landings;
//   - no two parked aircraft overlap, wings included;
//   - no two aircraft on the ground ever have their fuselages within four metres of each other;
//   - ground control never hands a claim back out of order;
//   - nothing is still stuck when the run ends;
//   - at least 85 numbered gates are in use;
//   - the run takes under 60 seconds of real time.
// Wings brushing while one of the two is moving is counted and reported but not judged: the
// taxiways are not yet matched to wingspans.
// Exit code 0 when every seed passes, 1 otherwise.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyClearance, parkedClearance, type Parked } from '../../src/shared/footprint.ts';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import type { Aircraft } from '../../src/sim/airside/aircraft.ts';
import { Sim } from '../../src/sim/sim.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const seeds = option('seeds', '7,11,3,21,42').split(',').map(Number);
const hours = Number(option('hours', '26'));
const [hh, mm] = option('start', '04:00').split(':').map(Number);
const asJson = argv.includes('--json');

const LIMITS = {
  completed: 0.99,
  longestWait: 20 * 60,
  goAroundShare: 0.03,
  usableGates: 85,
  wallSeconds: 60,
  /** Outlines closer than this, metres, are touching. */
  touching: 1,
  /** Fuselage centrelines closer than this, metres, are one aircraft inside another. */
  bodies: 4,
} as const;

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;

/** An aircraft where it is, as the outline the stands are sized with. */
function outline(a: Aircraft): Parked {
  // The simulation places an aircraft by a point half its length behind the nose; the outline is
  // placed by the nose wheel, four metres behind the nose.
  const ahead = a.type.length / 2 - 4;
  return { x: a.x + Math.cos(a.heading) * ahead, y: a.y + Math.sin(a.heading) * ahead, heading: a.heading, span: a.type.span, length: a.type.length };
}

interface Result {
  seed: number;
  flights: number;
  landings: number;
  takeoffs: number;
  goArounds: number;
  longestWait: number;
  standOverlaps: number;
  bodyHits: number;
  wingBrushes: number;
  firstHit: string;
  outOfOrder: number;
  stuckAtEnd: number;
  usableGates: number;
  wallSeconds: number;
  checksum: number;
  failures: string[];
}

function run(seed: number): Result {
  const started = performance.now();
  const sim = new Sim(layout, { seed, startTime: hh * 3600 + mm * 60 });
  const end = sim.time + hours * 3600;
  const pairs = { stand: new Set<string>(), body: new Set<string>(), wing: new Set<string>() };
  let firstHit = '';
  /** Fuselage meetings by what the two aircraft were doing. */
  const kinds: Record<string, number> = {};
  while (sim.time < end) {
    sim.step();
    if (sim.steps % 4) continue;
    const list = sim.airside.aircraft;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (a.alt > 3 || a.phase === 'gone') continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (b.alt > 3 || b.phase === 'gone') continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const reach = (a.type.length + b.type.length + a.type.span + b.type.span) / 2;
        if (dx * dx + dy * dy >= reach * reach) continue;
        const pa = outline(a);
        const pb = outline(b);
        const key = `${a.id}:${b.id}`;
        const describe = (): string => `${a.visit.rotation.arrFlight} ${a.type.id} (${a.phase} ${a.visit.stand}) and ${b.visit.rotation.arrFlight} ${b.type.id} (${b.phase} ${b.visit.stand}) at ${Math.round(a.x)},${Math.round(a.y)}, ${Math.round(sim.time)} s`;
        if (bodyClearance(pa, pb) < LIMITS.bodies) {
          if (!pairs.body.has(key) && !firstHit) firstHit = `fuselages: ${describe()}`;
          if (!pairs.body.has(key)) kinds[[a.phase, b.phase].sort().join('+')] = (kinds[[a.phase, b.phase].sort().join('+')] ?? 0) + 1;
          pairs.body.add(key);
        } else if (parkedClearance(pa, pb) < LIMITS.touching) {
          if (a.phase === 'parked' && b.phase === 'parked') {
            if (!pairs.stand.has(key) && !firstHit) firstHit = `at stands: ${describe()}`;
            pairs.stand.add(key);
          } else {
            pairs.wing.add(key);
          }
        }
      }
    }
  }
  const stats = sim.airside.tower.stats;
  const flights = sim.rotations.length;
  const stuckAtEnd = sim.airside.aircraft.filter((a) => a.waitingSince >= 0 && sim.time - a.waitingSince > LIMITS.longestWait).length;
  const usableGates = layout.airfield.stands.filter((s) => s.contact && sim.usableStands.has(s.id)).length;
  const result: Result = {
    seed,
    flights,
    landings: stats.landings,
    takeoffs: stats.takeoffs,
    goArounds: stats.goArounds,
    longestWait: Math.round(sim.airside.totals.longestWait),
    standOverlaps: pairs.stand.size,
    bodyHits: pairs.body.size,
    wingBrushes: pairs.wing.size,
    firstHit,
    outOfOrder: sim.airside.traffic.outOfOrder,
    stuckAtEnd,
    usableGates,
    wallSeconds: Math.round((performance.now() - started) / 100) / 10,
    checksum: sim.checksum(),
    failures: [],
  };
  if (result.landings < LIMITS.completed * flights) result.failures.push(`only ${result.landings} of ${flights} landed`);
  if (result.takeoffs < LIMITS.completed * flights) result.failures.push(`only ${result.takeoffs} of ${flights} took off`);
  if (result.longestWait > LIMITS.longestWait) result.failures.push(`an aircraft waited ${result.longestWait} s`);
  if (result.goArounds > LIMITS.goAroundShare * Math.max(1, result.landings)) result.failures.push(`${result.goArounds} go-arounds`);
  if (result.standOverlaps > 0) result.failures.push(`${result.standOverlaps} pairs of parked aircraft overlapped`);
  if (result.bodyHits > 0) result.failures.push(`${result.bodyHits} pairs of fuselages met ${JSON.stringify(kinds)}`);
  if (result.firstHit) result.failures.push(`first ${result.firstHit}`);
  if (result.outOfOrder > 0) result.failures.push(`${result.outOfOrder} claims released out of order`);
  if (result.stuckAtEnd > 0) result.failures.push(`${result.stuckAtEnd} aircraft stuck at the end`);
  if (result.usableGates < LIMITS.usableGates) result.failures.push(`only ${result.usableGates} gates in use`);
  if (result.wallSeconds > LIMITS.wallSeconds) result.failures.push(`took ${result.wallSeconds} s`);
  return result;
}

const results = seeds.map(run);
if (asJson) {
  console.log(JSON.stringify(results, null, 1));
} else {
  for (const r of results) {
    console.log(
      `seed ${String(r.seed).padEnd(4)} ${r.failures.length ? 'FAIL' : 'pass'}  landed ${r.landings}/${r.flights}  took off ${r.takeoffs}/${r.flights}  go-arounds ${r.goArounds}  longest wait ${r.longestWait} s  ` +
        `stands ${r.standOverlaps} bodies ${r.bodyHits} (wings ${r.wingBrushes})  gates ${r.usableGates}  ${r.wallSeconds} s  checksum ${r.checksum}` +
        (r.failures.length ? `\n          ${r.failures.join('; ')}` : ''),
    );
  }
  const passed = results.filter((r) => !r.failures.length).length;
  console.log(`${passed} of ${results.length} seeds pass`);
}
process.exit(results.every((r) => !r.failures.length) ? 0 : 1);
