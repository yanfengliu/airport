#!/usr/bin/env node
// A plan of the terminals as the people simulation sees them: building footprints, the mapped
// rooms by kind, the curbs, the gate doors, the stations, and whatever the terminal plan has
// placed (checkpoints, holdrooms, claim halls, exits), with the landside part of each floor shaded.
//
//   node tools/sim/terminal-map.ts <out.svg> [--focus cx,cy,halfWidth] [--size 2400]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_FILES, type Layout, type PolygonData } from '../../src/shared/layout.ts';
import { AIRLINES } from '../../src/sim/fleet.ts';
import { FLOOR, buildTerminalPlan } from '../../src/sim/terminal/plan.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const out = argv[0];
if (!out) throw new Error('usage: terminal-map.ts <out.svg> [--focus cx,cy,halfWidth] [--size px]');
const option = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const [cx, cy, half] = (option('focus') ?? '-1050,-330,900').split(',').map(Number);
const size = Number(option('size') ?? 2400);
const layout = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(root, 'public', 'data', `${name}.json`), 'utf8'))])) as unknown as Layout;
const plan = buildTerminalPlan(layout, AIRLINES);

const scale = size / (2 * half);
const X = (x: number): string => ((x - (cx - half)) * scale).toFixed(1);
const Y = (y: number): string => ((cy + half - y) * scale).toFixed(1);
const ring = (flat: readonly number[]): string => {
  let d = '';
  for (let i = 0; i < flat.length; i += 2) d += `${i ? 'L' : 'M'}${X(flat[i])} ${Y(flat[i + 1])}`;
  return `${d}Z`;
};
const poly = (p: PolygonData): string => [p.outer, ...(p.holes ?? [])].map(ring).join('');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const parts: string[] = [`<rect width="${size}" height="${size}" fill="#15181d"/>`];

// The departures level: landside halls in blue, airside concourses in green.
for (const [floor, fill] of [[FLOOR.landside, '#26384a'], [FLOOR.airside, '#263a2c']] as const) {
  const grid = plan.grids[floor];
  const s = (grid.cell * scale).toFixed(1);
  for (let id = 0; id < grid.count; id += 1) parts.push(`<rect x="${X(grid.cx[id] - grid.cell / 2)}" y="${Y(grid.cy[id] + grid.cell / 2)}" width="${s}" height="${s}" fill="${fill}"/>`);
}
for (const b of layout.terminals.buildings) parts.push(`<path d="${poly(b.poly)}" fill="none" stroke="#8aa" stroke-width="1.5"/>`);
const AREA: Record<string, string> = { checkin: '#d9a441', security: '#e05d5d', claim: '#6fc0e0', customs: '#b27ae0', gate: '#7ad08f', food: '#c98a5b', shop: '#c95bb0', corridor: '#556', lounge: '#88a', toilets: '#334', hall: '#456' };
for (const a of layout.terminals.areas) parts.push(`<path d="${poly(a.poly)}" fill="${AREA[a.kind] ?? '#444'}" fill-opacity="0.55" stroke="none"><title>${esc(`${a.kind} L${a.level} ${a.name ?? ''}`)}</title></path>`);
for (const e of layout.roads.edges) {
  if (e.name !== 'Departures' && e.name !== 'Arrivals') continue;
  let d = '';
  for (let i = 0; i < e.pts.length; i += 3) d += `${i ? 'L' : 'M'}${X(e.pts[i])} ${Y(e.pts[i + 1])}`;
  parts.push(`<path d="${d}" fill="none" stroke="${e.name === 'Departures' ? '#ffb347' : '#ffe08a'}" stroke-width="${e.name === 'Departures' ? 3 : 1.5}"/>`);
}
for (const s of layout.airfield.stands) if (s.door) parts.push(`<circle cx="${X(s.door[0])}" cy="${Y(s.door[1])}" r="3" fill="#7ad08f"/>`);
for (const place of plan.places) {
  const colour = place.kind === 'checkpoint' ? '#ff4040' : place.kind === 'holdroom' ? '#40ff80' : place.kind === 'claim' ? '#40c0ff' : place.kind === 'customs' ? '#c080ff' : place.kind === 'checkin' ? '#ffc040' : place.kind === 'exit' ? '#ffffff' : '#999';
  parts.push(`<circle cx="${X(place.x)}" cy="${Y(place.y)}" r="${place.kind === 'holdroom' ? 4 : 7}" fill="none" stroke="${colour}" stroke-width="2.5"/>`);
  if (place.kind !== 'holdroom') parts.push(`<text x="${Number(X(place.x)) + 9}" y="${Number(Y(place.y)) - 6}" font-size="13" fill="${colour}">${esc(place.name)}</text>`);
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="Helvetica, Arial, sans-serif">${parts.join('')}</svg>`);
console.log(resolve(out));
