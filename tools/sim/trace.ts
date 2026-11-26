#!/usr/bin/env node
// The instruments for ground traffic: run one day and say exactly which aircraft met, and which
// waited for which and why. Where the benchmark (soak.ts) counts failures, this names their causes.
//
//   node tools/sim/trace.ts [--seed 7] [--hours 26] [--start 04:00] [--show 3] [--wait 300] [--quiet]
//
// Meetings: every pair of fuselages that comes within four metres, sorted into classes by what the
// two were doing and how the ground under them is related (the same piece, pieces that join at a
// node, pieces that only lie close). `--show` prints that many examples of each class.
// Waits: every aircraft that stands longer than `--wait` seconds, followed from the aircraft it
// waits for to the one that one waits for, down to a root cause (the tower, a parked aircraft) or
// round to itself (a ring). Rings and root causes are counted and the first of each is printed.
// The last lines are the benchmark's own numbers for the run and the processor time it took.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyClearance, parkedClearance, type Parked } from '../../src/shared/footprint.ts';
import { LAYOUT_FILES, type Layout } from '../../src/shared/layout.ts';
import { formatClock } from '../../src/shared/sun.ts';
import type { Aircraft } from '../../src/sim/airside/aircraft.ts';
import { Sim } from '../../src/sim/sim.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const seed = Number(option('seed', '7'));
const hours = Number(option('hours', '26'));
const [hh, mm] = option('start', '04:00').split(':').map(Number);
const show = Number(option('show', '3'));
const longWait = Number(option('wait', '300'));
const quiet = argv.includes('--quiet');

const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
const cpuStart = process.cpuUsage();
const sim = new Sim(layout, { seed, startTime: hh * 3600 + mm * 60 });
const net = sim.airside.net;
const traffic = sim.airside.traffic;
const end = sim.time + hours * 3600;
const clock = (): string => formatClock(sim.secondsOfDay);

function outline(a: Aircraft): Parked {
  const ahead = a.type.length / 2 - 4;
  return { x: a.x + Math.cos(a.heading) * ahead, y: a.y + Math.sin(a.heading) * ahead, heading: a.heading, span: a.type.span, length: a.type.length };
}

const name = (a: Aircraft): string => `${a.phase === 'taxiIn' || a.phase === 'landing' || a.phase === 'approach' ? a.visit.rotation.arrFlight : a.visit.rotation.depFlight}#${a.id} ${a.type.id} ${a.phase}@${a.visit.stand}`;

function describeRes(res: number): string {
  if (res < 0) return '-';
  if (res < net.blocks.length) {
    const b = net.blocks[res];
    return `${b.kind}${b.ref ? ` ${b.ref}` : ''} block ${res} (${Math.round((b.pts[0] + b.pts[b.pts.length - 2]) / 2)},${Math.round((b.pts[1] + b.pts[b.pts.length - 1]) / 2)})`;
  }
  const n = net.nodes[res - net.blocks.length];
  return `node ${res - net.blocks.length} (${Math.round(n.x)},${Math.round(n.y)})`;
}

/** The pieces of ground an aircraft's body is on, as the traffic control sees it. */
function ground(a: Aircraft): number[] {
  return traffic.under(a.mover);
}

// ---- meetings ---------------------------------------------------------------------------

interface Meeting {
  cls: string;
  text: string;
}
const meetings: Meeting[] = [];
const met = new Set<string>();
const standPairs = new Set<string>();
const wingPairs = new Set<string>();
const onRunway = new Set(['landing', 'lineUp', 'takeoff', 'climb', 'approach', 'goAround']);

function classify(a: Aircraft, b: Aircraft): Meeting {
  const phases = [a.phase, b.phase].sort().join('+');
  const ga = ground(a);
  const gb = ground(b);
  let relation: string;
  if (onRunway.has(a.phase) || onRunway.has(b.phase)) relation = 'one on a runway';
  else if (!ga.length || !gb.length) relation = 'one holds no ground';
  else if (ga.some((r) => gb.includes(r))) relation = 'both hold the same ground';
  else {
    const nodesOf = (list: number[]): Set<number> => {
      const out = new Set<number>();
      for (const r of list) {
        if (r >= net.blocks.length) out.add(r - net.blocks.length);
        else {
          out.add(net.blocks[r].a);
          out.add(net.blocks[r].b);
        }
      }
      return out;
    };
    const na = nodesOf(ga);
    const joined = [...nodesOf(gb)].filter((n) => na.has(n));
    const kinds = [ga, gb].map((list) => [...new Set(list.filter((r) => r < net.blocks.length).map((r) => net.blocks[r].kind))].sort().join('/') || 'node').sort().join(' and ');
    relation = `${joined.length ? 'ground joined at a node' : 'ground not joined'} (${kinds})`;
  }
  const angle = Math.round((Math.acos(Math.max(-1, Math.min(1, Math.cos(a.heading - b.heading)))) * 180) / Math.PI);
  const text =
    `${clock()} ${name(a)} v=${a.speed.toFixed(1)} at ${Math.round(a.x)},${Math.round(a.y)} | ${name(b)} v=${b.speed.toFixed(1)} at ${Math.round(b.x)},${Math.round(b.y)} | headings ${angle} deg apart\n` +
    `      A on ${ga.map(describeRes).join('; ') || 'nothing'}\n      B on ${gb.map(describeRes).join('; ') || 'nothing'}`;
  return { cls: `${phases}: ${relation}`, text };
}

function checkMeetings(): void {
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
      if (bodyClearance(pa, pb) < 4) {
        if (met.has(key)) continue;
        met.add(key);
        meetings.push(classify(a, b));
      } else if (parkedClearance(pa, pb) < 1) {
        if (a.phase === 'parked' && b.phase === 'parked') {
          if (!standPairs.has(key) && !quiet) console.log(`STANDS OVERLAP ${clock()} ${name(a)} | ${name(b)}`);
          standPairs.add(key);
        } else wingPairs.add(key);
      }
    }
  }
}

// ---- waits ------------------------------------------------------------------------------

const byId = sim.airside.byIdMap;
const reported = new Map<number, number>();
const causes: Record<string, number> = {};
const firstOf: Record<string, string> = {};
const rings = new Map<string, string>();

function chain(start: Aircraft): { cause: string; text: string; ring: number[] | null } {
  const seen: number[] = [];
  const lines: string[] = [];
  let at: Aircraft | undefined = start;
  for (;;) {
    if (!at) return { cause: 'waits for an aircraft that is gone', text: lines.join('\n'), ring: null };
    const again = seen.indexOf(at.id);
    if (again >= 0) return { cause: again === 0 ? 'ring' : 'behind a ring', text: lines.join('\n'), ring: seen.slice(again) };
    seen.push(at.id);
    const waited = at.waitingSince >= 0 ? Math.round(sim.time - at.waitingSince) : 0;
    lines.push(`      ${name(at)} at ${Math.round(at.x)},${Math.round(at.y)} waited ${waited} s: ${at.holdKind || (at.phase === 'parked' ? 'parked' : at.phase === 'starting' ? 'starting engines' : 'moving')}${at.holdRes >= 0 ? ` for ${describeRes(at.holdRes)}` : ''}${at.holdBy >= 0 ? ` behind #${at.holdBy}` : ''}`);
    if (at.waitingSince < 0) {
      const what = at.phase === 'parked' ? 'behind a parked aircraft' : at.phase === 'starting' ? 'behind one starting engines' : `behind one that is ${at.speed > 0.2 ? 'moving' : 'not waiting'} (${at.phase})`;
      return { cause: what, text: lines.join('\n'), ring: null };
    }
    if (at.holdBy < 0) return { cause: at.holdKind, text: lines.join('\n'), ring: null };
    at = byId.get(at.holdBy);
  }
}

function checkWaits(): void {
  for (const a of sim.airside.aircraft) {
    if (a.waitingSince < 0 || sim.time - a.waitingSince < longWait) continue;
    if (reported.get(a.id) === a.waitingSince) continue;
    reported.set(a.id, a.waitingSince);
    const found = chain(a);
    causes[found.cause] = (causes[found.cause] ?? 0) + 1;
    if (!firstOf[found.cause]) firstOf[found.cause] = `${clock()}\n${found.text}`;
    if (found.ring) {
      const key = [...found.ring].sort((p, q) => p - q).join(',');
      if (!rings.has(key)) {
        rings.set(key, `${clock()}\n${found.text}`);
        if (!quiet && rings.size <= show) console.log(`RING ${rings.size} at ${clock()} (${found.ring.length} aircraft)\n${found.text}`);
      }
    }
  }
}

// ---- run --------------------------------------------------------------------------------

let nextWaitCheck = sim.time;
while (sim.time < end) {
  sim.step();
  if (sim.steps % 4 === 0) checkMeetings();
  if (sim.time >= nextWaitCheck) {
    nextWaitCheck += 30;
    checkWaits();
  }
}

const classes = new Map<string, Meeting[]>();
for (const m of meetings) (classes.get(m.cls) ?? classes.set(m.cls, []).get(m.cls)!).push(m);
console.log(`\nMEETINGS: ${meetings.length} pairs of fuselages within 4 m, in ${classes.size} classes`);
for (const [cls, list] of [...classes].sort((p, q) => q[1].length - p[1].length)) {
  console.log(`  ${String(list.length).padStart(4)}  ${cls}`);
  if (!quiet) for (const m of list.slice(0, show)) console.log(`    - ${m.text}`);
}
console.log(`\nWAITS over ${longWait} s by root cause`);
for (const [cause, count] of Object.entries(causes).sort((p, q) => q[1] - p[1])) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
  if (!quiet) console.log(`    first at ${firstOf[cause]}`);
}
console.log(`RINGS: ${rings.size} distinct`);

const stats = sim.airside.tower.stats;
const flights = sim.rotations.length;
const stuck = sim.airside.aircraft.filter((a) => a.waitingSince >= 0 && sim.time - a.waitingSince > 1200);
const gates = layout.airfield.stands.filter((s) => s.contact && sim.usableStands.has(s.id)).length;
const cpu = process.cpuUsage(cpuStart);
console.log(
  `\nseed ${seed}: landed ${stats.landings}/${flights} took off ${stats.takeoffs}/${flights} go-arounds ${stats.goArounds} ${JSON.stringify(sim.airside.tower.goAroundReasons)} longest wait ${Math.round(sim.airside.totals.longestWait)} s ` +
    `stands ${standPairs.size} bodies ${met.size} (wings ${wingPairs.size}) out of order ${traffic.outOfOrder} stuck ${stuck.length} gates ${gates} gate changes ${sim.airside.totals.gateChanges} checksum ${sim.checksum()}`,
);
console.log(`processor time ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s for ${hours} h`);
