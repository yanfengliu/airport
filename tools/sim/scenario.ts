#!/usr/bin/env node
// Run the airside through a change of weather or a runway closure and say what the airport did:
// landings and take-offs by runway end, hour by hour, the longest wait on the ground and at the
// gates, go-arounds, how late the arrivals were, and whether any two fuselages met.
//
//   node tools/sim/scenario.ts [--seed 7] [--start 10:00] [--hours 6]
//                              [--weather storm@11:00] [--close 28L@12:00] [--open 28L@13:00]
//
// Weather is one of the operations panel's presets: clear, low-cloud, fog, storm. Several
// --weather, --close and --open may be given. Exit code 1 if fuselages meet, two aircraft fly at
// each other in the air, or a wait passes 20 minutes.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyClearance, type Parked } from '../../src/shared/footprint.ts';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import type { Aircraft } from '../../src/sim/airside/aircraft.ts';
import { TAXI_IN_NOMINAL } from '../../src/sim/airside/flights.ts';
import { DAY } from '../../src/sim/schedule.ts';
import { Sim } from '../../src/sim/sim.ts';
import { WEATHER_PRESETS } from '../../src/sim/weather.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const all = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const clock = (text: string): number => {
  const [h, m] = text.split(':').map(Number);
  return h * 3600 + m * 60;
};
const seed = Number(option('seed', '7'));
const start = clock(option('start', '10:00'));
const hours = Number(option('hours', '6'));

interface Change {
  at: number;
  text: string;
  apply: (sim: Sim) => void;
}
const changes: Change[] = [];
for (const spec of all('weather')) {
  const [id, at] = spec.split('@');
  const preset = WEATHER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no weather called ${id}: ${WEATHER_PRESETS.map((p) => p.id).join(', ')}`);
  changes.push({ at: clock(at), text: `weather ${preset.label}`, apply: (sim) => sim.airside.setWeather(preset.weather) });
}
for (const [flag, closed] of [['close', true], ['open', false]] as const) {
  for (const spec of all(flag)) {
    const [end, at] = spec.split('@');
    changes.push({ at: clock(at), text: `${flag} ${end}`, apply: (sim) => sim.airside.setRunwayClosed(sim.airside.net.runwayEnds.get(end)!.runway.id, closed) });
  }
}
changes.sort((a, b) => a.at - b.at);

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
const sim = new Sim(layout, { seed, startTime: start });
const outline = (a: Aircraft): Parked => {
  const ahead = a.type.length / 2 - 4;
  return { x: a.x + Math.cos(a.heading) * ahead, y: a.y + Math.sin(a.heading) * ahead, heading: a.heading, span: a.type.span, length: a.type.length };
};
const hourly = new Map<number, Map<string, number>>();
const count = (hour: number, key: string): void => {
  const row = hourly.get(hour) ?? new Map<string, number>();
  row.set(key, (row.get(key) ?? 0) + 1);
  hourly.set(hour, row);
};
const phases = new Map<number, string>();
const readyAt = new Map<number, number>();
let gateHold = 0;
const meetings = new Set<string>();
const headOn = new Set<string>();
let late = 0;
let latest = 0;
let lateCount = 0;
let next = 0;
const end = start + hours * 3600;
while (sim.time < end) {
  while (next < changes.length && sim.time >= changes[next].at) {
    changes[next].apply(sim);
    console.log(`${formatClock(sim.time)}  ${changes[next].text}: plan ${sim.airside.tower.plan.name}, landing on ${sim.airside.tower.arrivalEnds.join(' ') || 'nothing'}`);
    next += 1;
  }
  sim.step();
  if (sim.steps % 4) continue;
  const hour = Math.floor((sim.time % DAY) / 3600);
  const list = sim.airside.aircraft;
  for (const a of list) {
    const before = phases.get(a.id);
    if (before !== a.phase) {
      if (a.phase === 'landing') {
        count(hour, `land ${a.runwayEnd}`);
        // Late against the landing the timetable implies: the gate time less the usual taxi in.
        const by = Math.max(0, sim.time - (a.visit.sta - TAXI_IN_NOMINAL));
        late += by;
        latest = Math.max(latest, by);
        lateCount += 1;
      }
      if (a.phase === 'takeoff') count(hour, `off ${a.runwayEnd}`);
      phases.set(a.id, a.phase);
    }
    const v = a.visit;
    if (a.phase === 'parked' && v.doorsClosed && sim.time >= v.etd) {
      if (!readyAt.has(v.id)) readyAt.set(v.id, sim.time);
    } else if (readyAt.has(v.id)) {
      gateHold = Math.max(gateHold, sim.time - readyAt.get(v.id)!);
      readyAt.delete(v.id);
    }
  }
  // In the air near the field, two aircraft flying at each other: a departure climbing out towards
  // an arrival coming the other way, or a go-around into one.
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.alt <= 3 || a.phase === 'gone') continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.alt <= 3 || b.phase === 'gone') continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 6000 || Math.abs(a.alt - b.alt) > 450) continue;
      const turn = Math.abs(Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading)));
      // Closing on each other along one line, not passing on parallel tracks.
      const ux = Math.cos(a.heading);
      const uy = Math.sin(a.heading);
      const across = Math.abs(-(b.x - a.x) * uy + (b.y - a.y) * ux);
      const ahead = (b.x - a.x) * ux + (b.y - a.y) * uy;
      if (turn > 2.6 && across < 400 && ahead > 0 && !headOn.has(`${a.id}:${b.id}`)) {
        headOn.add(`${a.id}:${b.id}`);
        console.log(`${formatClock(sim.time)}  head-on in the air: ${a.visit.rotation.arrFlight} (${a.phase} ${a.runwayEnd}, ${Math.round(a.alt)} m) and ${b.visit.rotation.arrFlight} (${b.phase} ${b.runwayEnd}, ${Math.round(b.alt)} m), ${Math.round(Math.hypot(a.x - b.x, a.y - b.y))} m apart`);
      }
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
      if (dx * dx + dy * dy > 120 * 120) continue;
      if (bodyClearance(outline(a), outline(b)) < 4 && !meetings.has(`${a.id}:${b.id}`)) {
        meetings.add(`${a.id}:${b.id}`);
        console.log(`${formatClock(sim.time)}  fuselages meet: ${a.visit.rotation.arrFlight} (${a.phase}) and ${b.visit.rotation.arrFlight} (${b.phase}) at ${Math.round(a.x)},${Math.round(a.y)}`);
      }
    }
  }
}
for (const at of readyAt.values()) gateHold = Math.max(gateHold, sim.time - at);
const keys = [...new Set([...hourly.values()].flatMap((row) => [...row.keys()]))].sort();
console.log(`hour  ${keys.map((k) => k.padStart(8)).join(' ')}`);
for (const [hour, row] of [...hourly].sort((p, q) => ((p[0] - start / 3600 + 24) % 24) - ((q[0] - start / 3600 + 24) % 24))) {
  console.log(`${String(hour).padStart(4)}  ${keys.map((k) => String(row.get(k) ?? 0).padStart(8)).join(' ')}`);
}
const longest = Math.round(sim.airside.totals.longestWait);
console.log(`landings ${sim.airside.tower.stats.landings}, take-offs ${sim.airside.tower.stats.takeoffs}, go-arounds ${sim.airside.tower.stats.goArounds} ${JSON.stringify(sim.airside.tower.goAroundReasons)}`);
console.log(`longest wait ${longest} s, longest gate hold ${Math.round(gateHold)} s, landings ${Math.round(late / Math.max(1, lateCount) / 60)} min late on average and ${Math.round(latest / 60)} at most, fuselages met ${meetings.size}, head-on in the air ${headOn.size}, claims out of order ${sim.airside.traffic.outOfOrder}`);
process.exit(meetings.size || headOn.size || longest > 1200 || gateHold > 1200 ? 1 : 0);
