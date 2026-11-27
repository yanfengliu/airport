#!/usr/bin/env node
// Run the airport with people in the terminals, headless, and report how they fare.
//
//   node tools/sim/people.ts [--hours 4] [--start 06:00] [--seed 7] [--every 1800]
//
// Every `every` simulated seconds: parties and staff inside, people created, boarded, missed and
// gone, security and check-in waits, bags, and the time a step takes. At the end, the books are
// balanced: everyone created must have boarded, missed, left, or still be inside.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import { Sim } from '../../src/sim/sim.ts';
import { percentile } from '../../src/sim/terminal/terminals.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const hours = Number(option('hours', '4'));
const seed = Number(option('seed', '7'));
const every = Number(option('every', '1800'));
const [hh, mm] = option('start', '06:00').split(':').map(Number);

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
let started = performance.now();
const sim = new Sim(layout, { seed, startTime: hh * 3600 + mm * 60, people: true });
const t = sim.terminals!;
console.log(`built in ${(performance.now() - started).toFixed(0)} ms; ${t.plan.places.length} places; floors ${t.plan.grids.map((g) => g.count).join(' / ')} cells`);

const end = sim.time + hours * 3600;
let nextReport = sim.time;
started = performance.now();
let lastWall = started;
let lastSteps = 0;
while (sim.time < end) {
  sim.step();
  if (sim.time >= nextReport) {
    nextReport += every;
    const s = t.stats;
    const a = t.audit();
    const wall = performance.now();
    const perStep = sim.steps > lastSteps ? (wall - lastWall) / (sim.steps - lastSteps) : 0;
    lastWall = wall;
    lastSteps = sim.steps;
    // Aircraft at their stands past their time, and why: the terminals decide when doors close.
    const overdue = { notDeplaned: 0, boarding: 0, closed: 0, waitingToBoard: 0 };
    for (const a of sim.airside.aircraft) {
      const v = a.visit;
      if (a.phase !== 'parked' || v.etd > sim.time - 900) continue;
      if (v.deplaned < v.rotation.paxIn) overdue.notDeplaned += 1;
      else if (v.doorsClosed) overdue.closed += 1;
      else if (v.boardingOpen) overdue.boarding += 1;
      else overdue.waitingToBoard += 1;
    }
    const tower = sim.airside.tower.stats;
    console.log(`         airside: ldg ${tower.landings} dep ${tower.takeoffs} aircraft ${sim.airside.aircraft.length} longest taxi wait ${Math.round(sim.airside.totals.longestWait)} s; parked past their time: ${JSON.stringify(overdue)}`);
    console.log(
      `${formatClock(sim.secondsOfDay)}  walkers ${t.count} (dep ${a.departingHere} arr ${a.arrivingHere} staff ${a.staffHere})  ` +
        `dep ${s.departing.created} boarded ${s.departing.boarded} missed ${s.departing.missed}  arr ${s.arriving.created} left ${s.arriving.left}  ` +
        `security p95 ${Math.round(percentile(s.security, 0.95) / 60)} min (longest ${Math.round(s.security.longest / 60)})  check-in p95 ${Math.round(percentile(s.checkin, 0.95) / 60)} min  ` +
        `customs p95 ${Math.round(percentile(s.customs, 0.95) / 60)} min  ${perStep.toFixed(2)} ms a step`,
    );
  }
}
const s = t.stats;
const a = t.audit();
console.log(`bags: ${JSON.stringify(s.bags)}`);
console.log(`takings: ${Object.entries(s.takings).map(([k, v]) => `${k} $${Math.round(v)}`).join(', ')}`);
const departingBalance = s.departing.created - s.departing.boarded - s.departing.missed - s.departing.cancelled - a.departingHere - a.departingRiding;
console.log(`departing: ${JSON.stringify(s.departing)}; arriving: ${JSON.stringify(s.arriving)}; connecting, among the departing: ${JSON.stringify(s.connecting)}`);
const lines = [...t.queues.entries()].map(([id, q]) => ({ name: t.plan.places[id].name, line: q.line.length, open: q.openServers, of: q.servers.length, longest: Math.round(q.longestWait / 60) })).filter((q) => q.longest > 0).sort((p, q) => q.longest - p.longest).slice(0, 8);
console.log(`longest waits by queue (min): ${lines.map((q) => `${q.name} ${q.longest} (${q.open}/${q.of} open, ${q.line} in line)`).join('; ')}`);
const arrivingBalance = s.arriving.created - s.arriving.left - a.arrivingHere;
console.log(`balance: departing ${departingBalance} unaccounted, arriving ${arrivingBalance} unaccounted; missed ${((100 * s.departing.missed) / Math.max(1, s.departing.boarded + s.departing.missed)).toFixed(2)}% of those whose flight left`);
console.log(`ran ${hours} h in ${((performance.now() - started) / 1000).toFixed(1)} s; checksum ${sim.checksum()}`);

// The acceptance criteria for people and bags, judged on this run; exit code 1 if any fails.
const b = s.bags;
const failures: string[] = [];
const share = (part: number, whole: number): number => part / Math.max(1, whole);
if (departingBalance !== 0) failures.push(`${departingBalance} departing unaccounted`);
if (t.lingering() > 0) failures.push(`${t.lingering()} departing people still inside an hour after their flight left`);
if (arrivingBalance !== 0) failures.push(`${arrivingBalance} arriving unaccounted`);
if (b.loaded + b.leftBehind + b.misrouted + b.returned !== b.checked) failures.push('checked bags without an outcome');
if (b.collected + b.lost + t.arrivingBagsInside() !== b.arrived) failures.push('arriving bags without an outcome');
if (share(s.departing.missed, s.departing.boarded + s.departing.missed) >= 0.02) failures.push('2% or more missed their flight');
if (share(s.connecting.missed, s.connecting.boarded + s.connecting.missed) >= 0.02) failures.push('2% or more missed their connection');
if (share(b.leftBehind + b.misrouted + b.lost, b.checked + b.arrived) >= 0.01) failures.push('1% or more of bags mishandled');
if (percentile(t.waitsWithLines('checkpoint'), 0.95) >= 30 * 60) failures.push('the 95th-percentile security wait, those still in line counted, is 30 minutes or more');
console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'pass: everyone and every bag accounted for, misses, mishandling and security waits within their limits');
process.exit(failures.length ? 1 : 0);
