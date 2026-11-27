#!/usr/bin/env node
// Run the airside through a change of weather or a runway closure and say what the airport did:
// landings and take-offs by runway end, hour by hour, the longest wait on the ground and at the
// gates, go-arounds, how late the arrivals were, and whether any two aircraft met. Aircraft are
// judged as tools/sim/soak.ts judges them: at their true size as the model draws them (fuselages
// touching on the ground, parked aircraft overlapping), by the runway-conflict rule of
// tools/sim/conflicts.ts, and flying at each other in the air. Until review 1's recheck (R5) this
// counted only fuselage centrelines within 4 m, which passed two wide bodies side by side
// overlapping.
//
//   node tools/sim/scenario.ts [--seed 7] [--start 10:00] [--hours 6]
//                              [--weather storm@11:00] [--close 28L@12:00] [--open 28L@13:00]
//
// Weather is one of the operations panel's presets: clear, low-cloud, fog, storm. Several
// --weather, --close and --open may be given. Exit code 1 if any two aircraft meet, on the ground,
// on a runway or in the air, or a wait passes 20 minutes.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuselageClearance, shapeClearance, shapeOf, type Shape } from '../../src/shared/footprint.ts';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import type { Aircraft } from '../../src/sim/airside/aircraft.ts';
import { TAXI_IN_NOMINAL } from '../../src/sim/airside/flights.ts';
import { DAY } from '../../src/sim/schedule.ts';
import { Sim } from '../../src/sim/sim.ts';
import { WEATHER_PRESETS } from '../../src/sim/weather.ts';
import { headOnInAir, runwayConflicts, stripsOf } from './conflicts.ts';

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
/** Metres apart at which two fuselages, or two parked aircraft, touch: as tools/sim/soak.ts has them. */
const FUSELAGE_GAP = 0.3;
const TOUCHING = 0.5;
const strips = stripsOf(layout);
const name = (a: Aircraft): string => `${a.visit.rotation.arrFlight} (${a.phase} ${a.runwayEnd || a.visit.stand})`;
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
const atStands = new Set<string>();
const headOn = new Set<string>();
const conflicts = new Set<string>();
const firstConflict: string[] = [];
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
  const known = conflicts.size;
  runwayConflicts(strips, sim.airside.aircraft, conflicts, (a, b) => `${name(a)} at ${Math.round(a.speed)} m/s towards ${name(b)}`, firstConflict);
  if (conflicts.size > known) console.log(`${formatClock(sim.time)}  runway conflict: ${firstConflict[firstConflict.length - 1] ?? [...conflicts].pop()}`);
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
  const before = new Set(headOn);
  headOnInAir(list, headOn);
  for (const key of headOn) {
    if (before.has(key)) continue;
    const [a, b] = key.split(':').map((id) => list.find((x) => x.id === Number(id))!);
    console.log(`${formatClock(sim.time)}  head-on in the air: ${name(a)} at ${Math.round(a.alt)} m and ${name(b)} at ${Math.round(b.alt)} m, ${Math.round(Math.hypot(a.x - b.x, a.y - b.y))} m apart`);
  }
  // On the ground, at their true size: fuselages touching, and parked aircraft overlapping.
  const shapes = new Map<number, Shape>();
  const shape = (x: Aircraft): Shape => shapes.get(x.id) ?? (shapes.set(x.id, shapeOf(x.type, x.x, x.y, x.heading)), shapes.get(x.id)!);
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.alt > 3 || a.phase === 'gone') continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.alt > 3 || b.phase === 'gone') continue;
      const reach = (a.type.length + b.type.length + a.type.span + b.type.span) / 2;
      if (Math.hypot(a.x - b.x, a.y - b.y) >= reach) continue;
      const key = `${a.id}:${b.id}`;
      if (fuselageClearance(shape(a), shape(b), FUSELAGE_GAP) < FUSELAGE_GAP) {
        if (!meetings.has(key)) console.log(`${formatClock(sim.time)}  fuselages meet: ${name(a)} and ${name(b)} at ${Math.round(a.x)},${Math.round(a.y)}`);
        meetings.add(key);
      } else if (a.phase === 'parked' && b.phase === 'parked' && shapeClearance(shape(a), shape(b), TOUCHING) < TOUCHING) {
        if (!atStands.has(key)) console.log(`${formatClock(sim.time)}  parked aircraft overlap: ${name(a)} and ${name(b)}`);
        atStands.add(key);
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
console.log(`longest wait ${longest} s, longest gate hold ${Math.round(gateHold)} s, landings ${Math.round(late / Math.max(1, lateCount) / 60)} min late on average and ${Math.round(latest / 60)} at most, fuselages met ${meetings.size}, parked aircraft overlapping ${atStands.size}, runway conflicts ${conflicts.size}, head-on in the air ${headOn.size}, claims out of order ${sim.airside.traffic.outOfOrder}`);
process.exit(meetings.size || atStands.size || conflicts.size || headOn.size || longest > 1200 || gateHold > 1200 ? 1 : 0);
