#!/usr/bin/env node
// Run the road traffic headless and report how it flows.
//
//   node tools/sim/roads.ts [--hours 3] [--start 07:00] [--seed 7] [--every 900]
//
// Prints, every `every` simulated seconds: vehicles on the map, how many have come and gone, the
// mean speed on each freeway, the longest any vehicle has stood still, and what could not get in.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import { CONFIG } from '../../src/sim/config.ts';
import { Rng } from '../../src/sim/rng.ts';
import { RoadSim } from '../../src/sim/roads/roads.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const hours = Number(option('hours', '3'));
const seed = Number(option('seed', '7'));
const every = Number(option('every', '900'));
const [hh, mm] = option('start', '07:00').split(':').map(Number);

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
const started = performance.now();
const roads = new RoadSim(layout.roads, layout.land.bounds, new Rng(seed).fork('roads'));
roads.through.scale = Number(option('scale', '1'));
console.log(`network: ${roads.net.links.length} links; ${roads.through.entryCount} ways in; built in ${(performance.now() - started).toFixed(0)} ms`);
for (const name of ['US 101', 'I 380']) console.log(`  ${name}: ${Math.round(roads.through.peakOn(name))} vehicles an hour entering at the peak`);

const speedOn = (name: string): string => {
  let n = 0;
  let sum = 0;
  for (const v of roads.traffic.vehicles) {
    if (roads.net.links[v.link].name !== name) continue;
    n += 1;
    sum += v.v;
  }
  return n ? `${((sum / n) * 2.237).toFixed(0)} mph (${n})` : '-';
};

let time = hh * 3600 + mm * 60;
const end = time + hours * 3600;
let nextReport = time;
const wall = performance.now();
let steps = 0;
while (time < end) {
  time += CONFIG.dt;
  steps += 1;
  roads.step(CONFIG.dt, time, time % 86400);
  if (time >= nextReport) {
    nextReport += every;
    const s = roads.traffic.stats;
    console.log(`${formatClock(time % 86400)}  on the map ${roads.traffic.vehicles.length}  in ${s.spawned} out ${s.finished}  US 101 ${speedOn('US 101')}  I 380 ${speedOn('I 380')}  longest stand ${Math.round(s.longestStuck)} s  missed turns ${s.missedTurns}  turned away ${Math.round(roads.through.backlog)}`);
  }
}
const elapsed = (performance.now() - wall) / 1000;
console.log(`ran ${hours} h in ${elapsed.toFixed(1)} s (${Math.round((hours * 3600) / elapsed)}x real time, ${((elapsed * 1000) / steps).toFixed(2)} ms a step); checksum ${roads.checksum()}`);
