#!/usr/bin/env node
// Run the simulation headless and report how the airport is doing.
//
//   node tools/sim/run.ts [--hours 3] [--start 06:00] [--seed 7] [--every 600] [--svg out.svg]
//
// Prints a line every `every` simulated seconds: aircraft by phase, runway movements so far,
// the longest anyone has been waiting. With --svg it also writes a plan view of the airfield at
// the end of the run, each aircraft drawn where it is and coloured by what it is doing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import { Sim } from '../../src/sim/sim.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const hours = Number(option('hours', '3'));
const seed = Number(option('seed', '7'));
const every = Number(option('every', '600'));
const [hh, mm] = option('start', '06:00').split(':').map(Number);
const svgPath = argv.includes('--svg') ? option('svg', '') : '';

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
const started = performance.now();
const sim = new Sim(layout, { seed, startTime: hh * 3600 + mm * 60 });
console.log(`schedule: ${sim.rotations.length} visits; parked at start: ${sim.airside.aircraft.length}; built in ${(performance.now() - started).toFixed(0)} ms`);

const end = sim.time + hours * 3600;
let nextReport = sim.time;
const wall = performance.now();
while (sim.time < end) {
  sim.step();
  if (sim.time >= nextReport) {
    nextReport += every;
    const phases: Record<string, number> = {};
    for (const a of sim.airside.aircraft) phases[a.phase] = (phases[a.phase] ?? 0) + 1;
    const t = sim.airside.tower.stats;
    const waiting = sim.airside.aircraft.filter((a) => a.waitingSince >= 0 && sim.time - a.waitingSince > 300);
    console.log(
      `${formatClock(sim.secondsOfDay)}  ldg ${t.landings} dep ${t.takeoffs} ga ${t.goArounds} x ${t.crossings}  ` +
        `${Object.entries(phases).map(([k, v]) => `${k}:${v}`).join(' ')}  longest wait ${Math.round(sim.airside.totals.longestWait)}s` +
        (waiting.length ? `  STUCK ${waiting.map((a) => `${a.visit.rotation.arrFlight}/${a.phase}@${a.visit.stand}`).join(',')}` : ''),
    );
  }
}
const elapsed = (performance.now() - wall) / 1000;
console.log(`ran ${hours} h in ${elapsed.toFixed(1)} s (${Math.round((hours * 3600) / elapsed)}x real time); out-of-order releases ${sim.airside.traffic.outOfOrder}; checksum ${sim.checksum()}`);

if (svgPath) {
  const size = 2400;
  const half = 2300;
  const cx = -100;
  const cy = 350;
  const scale = size / (2 * half);
  const X = (x: number): string => ((x - (cx - half)) * scale).toFixed(1);
  const Y = (y: number): string => ((cy + half - y) * scale).toFixed(1);
  const parts: string[] = [`<rect width="${size}" height="${size}" fill="#1b1f25"/>`];
  for (const e of layout.airfield.edges) {
    let d = '';
    for (let i = 0; i < e.pts.length; i += 2) d += `${i ? 'L' : 'M'}${X(e.pts[i])} ${Y(e.pts[i + 1])}`;
    parts.push(`<path d="${d}" fill="none" stroke="${e.kind === 'rwy' ? '#777' : e.kind === 'twy' ? '#5a4d1c' : '#234a3a'}" stroke-width="${e.kind === 'rwy' ? 6 : 1.2}"/>`);
  }
  const colour: Record<string, string> = { approach: '#7fd3ff', landing: '#7fd3ff', taxiIn: '#5bd08a', parked: '#888', pushback: '#ffb347', starting: '#ffb347', taxiOut: '#ff7b7b', lineUp: '#ff3b3b', takeoff: '#ff3b3b', climb: '#ff9de2', goAround: '#fff' };
  for (const a of sim.airside.aircraft) {
    const len = a.type.length * scale;
    const ux = Math.cos(a.heading);
    const uy = -Math.sin(a.heading);
    const px = Number(X(a.x));
    const py = Number(Y(a.y));
    parts.push(`<path d="M${(px + (ux * len) / 2).toFixed(1)} ${(py + (uy * len) / 2).toFixed(1)}L${(px - (ux * len) / 2).toFixed(1)} ${(py - (uy * len) / 2).toFixed(1)}" stroke="${colour[a.phase] ?? '#fff'}" stroke-width="${Math.max(2, a.type.fuselage * scale)}" stroke-linecap="round"/>`);
    if (a.phase !== 'parked') parts.push(`<text x="${px + 6}" y="${py - 6}" font-size="11" fill="#fff">${a.visit.rotation.depFlight}/${a.visit.stand}</text>`);
  }
  mkdirSync(dirname(resolve(svgPath)), { recursive: true });
  writeFileSync(resolve(svgPath), `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="Helvetica, Arial, sans-serif">${parts.join('')}</svg>`);
  console.log(resolve(svgPath));
}
