#!/usr/bin/env node
// The airside benchmark: a full day of flights for each of several seeds, judged against fixed
// limits. This is the instrument for the ground-traffic work; change what it measures only with
// evidence that it misstates the requirement, and keep the old numbers when you do.
//
//   node tools/sim/soak.ts [--seeds 7,11,3,21,42] [--hours 26] [--start 04:00] [--json]
//
// A seed passes when, over the run:
//   - at least 99% of the day's flights land and at least 99% take off;
//   - at least 95% of the visits due in after the start and out two hours before the end have
//     landed and taken off: whole cycles, counted visit by visit, as the acceptance criterion
//     asks. Added 2026-11-26 after independent review: the totals above can pass on overnight
//     and next-day movements while visits of the day are still incomplete.
//   - no aircraft waits more than 20 minutes on the ground for the way ahead;
//   - no departure is held at its stand more than 20 minutes once it is ready to go (doors closed,
//     departure time reached): waiting to be let push back is waiting for a taxi clearance too.
//     Added 2026-11-26, after runs that passed every other limit held departures at their stands
//     for up to 6,890 s; the measures above are unchanged.
//   - no runway conflicts: an aircraft rolling fast on a runway (landing or taking off, over
//     30 m/s, under 30 m up) never has another on the same runway's strip ahead of it within
//     1,500 m, unless that one is already airborne or taking off the same way at over 50 m/s.
//     Measured from positions alone, not from the tower's books. Added 2026-11-26: the acceptance
//     criterion asks for zero runway-separation violations, and nothing here measured them.
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
  /** Share of the cohort that must complete a whole cycle: the acceptance criterion's 95%. */
  cycles: 0.95,
  longestWait: 20 * 60,
  longestGateHold: 20 * 60,
  goAroundShare: 0.03,
  usableGates: 85,
  wallSeconds: 60,
  /** Outlines closer than this, metres, are touching. */
  touching: 1,
  /** Fuselage centrelines closer than this, metres, are one aircraft inside another. */
  bodies: 4,
  runwayConflicts: 0,
} as const;

/** Seconds before the end of the run by which a visit must be due to leave to count in the cycle cohort. */
const CYCLE_SLACK = 2 * 3600;

/** Half the width of a runway's strip, metres, and the conflict rule's numbers (see the header). */
const STRIP = 45;
const FAST = 30;
const AHEAD = 1500;
const AWAY = 50;

interface Strip {
  id: string;
  x: number;
  y: number;
  ux: number;
  uy: number;
  length: number;
}
const strips: Strip[] = [];

/**
 * Pairs of aircraft in conflict on a runway now: `a` rolling fast with `b` on the strip ahead of
 * it within reach, neither airborne, `b` not taking off away from it fast. Keys `a:b`.
 */
function runwayConflicts(list: readonly Aircraft[], found: Set<string>, describe: (a: Aircraft, b: Aircraft) => string, first: string[]): void {
  for (const s of strips) {
    const on: { a: Aircraft; along: number; v: number }[] = [];
    for (const a of list) {
      if (a.alt > 30 || a.phase === 'gone') continue;
      const dx = a.x - s.x;
      const dy = a.y - s.y;
      const along = dx * s.ux + dy * s.uy;
      const lateral = Math.abs(-dx * s.uy + dy * s.ux);
      if (lateral > STRIP || along < -60 || along > s.length + 60) continue;
      on.push({ a, along, v: a.speed * (Math.cos(a.heading) * s.ux + Math.sin(a.heading) * s.uy) });
    }
    for (const p of on) {
      // Landing in the flare or just off the ground counts: the runway ahead must be clear.
      if (Math.abs(p.v) < FAST) continue;
      const sign = Math.sign(p.v);
      for (const q of on) {
        if (q === p || q.a.alt > 3) continue;
        const gap = (q.along - p.along) * sign;
        if (gap <= 0 || gap > AHEAD) continue;
        // A departure taking off the same way and faster than this one can close: no conflict.
        // Only a departure: a landing ahead is in the way whatever its speed.
        if ((q.a.phase === 'takeoff' || q.a.phase === 'climb') && q.v * sign > AWAY) continue;
        const key = `${p.a.id}:${q.a.id}`;
        if (!found.has(key) && !first.length) first.push(`runway ${s.id}: ${describe(p.a, q.a)}`);
        found.add(key);
      }
    }
  }
}

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
for (const r of layout.airfield.runways) {
  const [a, b] = r.ends;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  strips.push({ id: r.id, x: a.x, y: a.y, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length, length });
}

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
  /** Visits due in after the start and out two hours before the end, and how many did both. */
  cohort: number;
  cycles: number;
  goArounds: number;
  longestWait: number;
  longestGateHold: number;
  standOverlaps: number;
  bodyHits: number;
  wingBrushes: number;
  runwayConflicts: number;
  firstConflict: string;
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
  const pairs = { stand: new Set<string>(), body: new Set<string>(), wing: new Set<string>(), runway: new Set<string>() };
  let firstHit = '';
  const firstConflict: string[] = [];
  const name = (a: Aircraft): string => `${a.visit.rotation.arrFlight} ${a.type.id} (${a.phase})`;
  /** Fuselage meetings by what the two aircraft were doing. */
  const kinds: Record<string, number> = {};
  /** When each departure still at its stand was ready to go, by visit. */
  const readyAt = new Map<number, number>();
  let longestGateHold = 0;
  // Every visit's times and progress, noted as the run goes: the flight book forgets a visit two
  // hours after it leaves.
  const runStart = sim.time;
  const visits = new Map<number, { sta: number; std: number; landed: boolean; airborne: boolean }>();
  const noteVisits = (): void => {
    for (const v of sim.airside.book.visits.values()) visits.set(v.id, { sta: v.sta, std: v.std, landed: v.landedAt >= 0, airborne: v.airborneAt >= 0 });
  };
  while (sim.time < end) {
    sim.step();
    if (sim.steps % 600 === 0) noteVisits();
    if (sim.steps % 4) continue;
    const list = sim.airside.aircraft;
    runwayConflicts(list, pairs.runway, (a, b) => `${name(a)} at ${Math.round(a.speed)} m/s towards ${name(b)}, ${Math.round(sim.time)} s`, firstConflict);
    for (const a of list) {
      const v = a.visit;
      if (a.phase === 'parked' && v.doorsClosed && sim.time >= v.etd) {
        if (!readyAt.has(v.id)) readyAt.set(v.id, sim.time);
      } else if (readyAt.has(v.id)) {
        longestGateHold = Math.max(longestGateHold, sim.time - readyAt.get(v.id)!);
        readyAt.delete(v.id);
      }
    }
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
  for (const at of readyAt.values()) longestGateHold = Math.max(longestGateHold, sim.time - at);
  const stats = sim.airside.tower.stats;
  const flights = sim.rotations.length;
  // Whole cycles: of the visits due to arrive after the start and leave two hours before the end,
  // how many have landed, turned round and taken off. Overnight stays leaving after the end are
  // not counted, and an arrival not yet in by then is not complete.
  noteVisits();
  const cohort = [...visits.values()].filter((v) => v.sta >= runStart && v.std <= sim.time - CYCLE_SLACK);
  const cycles = cohort.filter((v) => v.landed && v.airborne).length;
  const stuckAtEnd = sim.airside.aircraft.filter((a) => a.waitingSince >= 0 && sim.time - a.waitingSince > LIMITS.longestWait).length;
  const usableGates = layout.airfield.stands.filter((s) => s.contact && sim.usableStands.has(s.id)).length;
  const result: Result = {
    seed,
    flights,
    landings: stats.landings,
    cycles,
    cohort: cohort.length,
    takeoffs: stats.takeoffs,
    goArounds: stats.goArounds,
    longestWait: Math.round(sim.airside.totals.longestWait),
    longestGateHold: Math.round(longestGateHold),
    standOverlaps: pairs.stand.size,
    bodyHits: pairs.body.size,
    wingBrushes: pairs.wing.size,
    runwayConflicts: pairs.runway.size,
    firstConflict: firstConflict[0] ?? '',
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
  if (result.cycles < LIMITS.cycles * result.cohort) result.failures.push(`only ${result.cycles} of ${result.cohort} visits completed their cycle`);
  if (result.longestWait > LIMITS.longestWait) result.failures.push(`an aircraft waited ${result.longestWait} s`);
  if (result.longestGateHold > LIMITS.longestGateHold) result.failures.push(`a departure was held at its stand ${result.longestGateHold} s`);
  if (result.goArounds > LIMITS.goAroundShare * Math.max(1, result.landings)) result.failures.push(`${result.goArounds} go-arounds`);
  if (result.standOverlaps > 0) result.failures.push(`${result.standOverlaps} pairs of parked aircraft overlapped`);
  if (result.bodyHits > 0) result.failures.push(`${result.bodyHits} pairs of fuselages met ${JSON.stringify(kinds)}`);
  if (result.runwayConflicts > LIMITS.runwayConflicts) result.failures.push(`${result.runwayConflicts} runway conflicts, first ${result.firstConflict}`);
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
      `seed ${String(r.seed).padEnd(4)} ${r.failures.length ? 'FAIL' : 'pass'}  landed ${r.landings}/${r.flights}  took off ${r.takeoffs}/${r.flights}  cycles ${r.cycles}/${r.cohort}  go-arounds ${r.goArounds}  longest wait ${r.longestWait} s  gate hold ${r.longestGateHold} s  ` +
        `stands ${r.standOverlaps} bodies ${r.bodyHits} (wings ${r.wingBrushes})  runway conflicts ${r.runwayConflicts}  gates ${r.usableGates}  ${r.wallSeconds} s  checksum ${r.checksum}` +
        (r.failures.length ? `\n          ${r.failures.join('; ')}` : ''),
    );
  }
  const passed = results.filter((r) => !r.failures.length).length;
  console.log(`${passed} of ${results.length} seeds pass`);
}
process.exit(results.every((r) => !r.failures.length) ? 0 : 1);
