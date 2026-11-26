#!/usr/bin/env node
// A flat SVG of the built layout, for checking the data by eye.
//
//   node tools/osm/debug-map.ts <out.svg> [--focus cx,cy,halfWidth] [--labels] [--size 2400]
//
// Draws whichever sections exist under public/data/. Rasterize with tools/visual/rasterize.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Airfield, Buildings, Flat, Land, PolygonData, Rail, Roads, Terminals } from '../../src/shared/layout.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const out = argv[0];
if (!out) throw new Error('usage: debug-map.ts <out.svg> [--focus cx,cy,halfWidth] [--labels] [--size px]');
const option = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const focus = option('focus')?.split(',').map(Number) ?? [0, 0, 3400];
const labels = argv.includes('--labels');
const size = Number(option('size') ?? 2400);

const read = <T,>(section: string): T | null => {
  const path = join(root, 'public', 'data', `${section}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
};
const airfield = read<Airfield>('airfield');
const terminals = read<Terminals>('terminals');
const roads = read<Roads>('roads');
const rail = read<Rail>('rail');
const buildings = read<Buildings>('buildings');
const land = read<Land>('land');

const [cx, cy, half] = focus;
const scale = size / (2 * half);
const X = (x: number): string => ((x - (cx - half)) * scale).toFixed(1);
const Y = (y: number): string => ((cy + half - y) * scale).toFixed(1);
const px = (metres: number): string => Math.max(0.6, metres * scale).toFixed(2);

const path2 = (pts: Flat, close = false): string => {
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${X(pts[i])} ${Y(pts[i + 1])}`;
  return close ? `${d}Z` : d;
};
const path3 = (pts: number[]): string => {
  let d = '';
  for (let i = 0; i < pts.length; i += 3) d += `${i ? 'L' : 'M'}${X(pts[i])} ${Y(pts[i + 1])}`;
  return d;
};
const poly = (p: PolygonData): string => path2(p.outer, true) + (p.holes ?? []).map((h) => path2(h, true)).join('');

const parts: string[] = [];
const add = (s: string): void => {
  parts.push(s);
};
add(`<rect width="${size}" height="${size}" fill="${land ? '#27506b' : '#20242b'}"/>`);

if (land) {
  for (const p of land.land) add(`<path d="${poly(p)}" fill="#3b4a3a" fill-rule="evenodd"/>`);
  const fills: Record<string, string> = { grass: '#4c6b45', wetland: '#3f6660', water: '#27506b', parking: '#4a4d52', pavement: '#55585e', sand: '#8a8062', scrub: '#55694a', industrial: '#454a4f', residential: '#474a44', park: '#4f7748' };
  for (const s of land.surfaces) add(`<path d="${poly(s.poly)}" fill="${fills[s.kind] ?? '#555'}" fill-rule="evenodd"/>`);
  for (const p of land.airport) add(`<path d="${poly(p)}" fill="none" stroke="#c9a23f" stroke-width="1" stroke-dasharray="6 5"/>`);
}
if (airfield) {
  for (const a of airfield.aprons) add(`<path d="${poly(a.poly)}" fill="#5d6168" fill-rule="evenodd"/>`);
  for (const s of airfield.stopways) add(`<path d="${path2(s, true)}" fill="#6a6257"/>`);
}
if (buildings) {
  const fills: Record<string, string> = { hangar: '#7c8794', garage: '#7a6f66', cargo: '#80786a', hotel: '#8a7f95', house: '#6b6258', industrial: '#6f6f72', office: '#77808c', tower: '#b0b6bf', generic: '#75777c' };
  for (const b of buildings.buildings) add(`<path d="${poly(b.poly)}" fill="${fills[b.kind] ?? '#777'}" fill-rule="evenodd"/>`);
}
if (roads) {
  const style: Record<string, [string, number]> = {
    motorway: ['#e39a4b', 5], motorway_link: ['#d9a86a', 3.5], trunk: ['#dcb061', 4], primary: ['#e4d08a', 3.6], secondary: ['#e8e2b8', 3.2],
    tertiary: ['#d8d8d8', 3], local: ['#aeb2b8', 2.6], service: ['#8d9299', 2], airside: ['#6f89a3', 2],
  };
  for (const e of roads.edges) {
    const [colour, lane] = style[e.cls] ?? ['#999', 2];
    const width = lane * Math.max(1, e.lanes + e.back) * 0.9;
    add(`<path d="${path3(e.pts)}" fill="none" stroke="${colour}" stroke-width="${px(width)}" stroke-linejoin="round" opacity="${e.tunnel ? 0.35 : 1}"/>`);
  }
}
if (rail) {
  const colour: Record<string, string> = { airtrain: '#ff5d73', bart: '#5aa9ff', caltrain: '#c084fc' };
  for (const l of rail.lines) add(`<path d="${path3(l.pts)}" fill="none" stroke="${colour[l.kind]}" stroke-width="${px(4)}"/>`);
  for (const s of rail.stations) {
    add(`<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="${px(14)}" fill="${colour[s.kind]}" stroke="#111" stroke-width="1"/>`);
    if (labels) add(`<text x="${X(s.x)}" y="${Y(s.y + 22)}" font-size="${px(16)}" fill="#fff" text-anchor="middle">${s.name}</text>`);
  }
}
if (terminals) {
  for (const b of terminals.buildings) add(`<path d="${poly(b.poly)}" fill="#3f6fb0" fill-opacity="0.85" stroke="#9cc2f5" stroke-width="1" fill-rule="evenodd"/>`);
  for (const a of terminals.checkin) add(`<path d="${poly(a.poly)}" fill="#f5c542" fill-opacity="0.6"/>`);
  for (const a of terminals.claims) add(`<path d="${poly(a.poly)}" fill="#59d38c" fill-opacity="0.6"/>`);
  for (const p of terminals.pois) add(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${px(2.5)}" fill="#ff9de2"/>`);
}
if (airfield) {
  for (const r of airfield.runways) {
    const [a, b] = r.ends;
    add(`<path d="M${X(a.x)} ${Y(a.y)}L${X(b.x)} ${Y(b.y)}" stroke="#15171a" stroke-width="${px(r.width)}"/>`);
  }
  for (const e of airfield.edges) {
    const colour = e.kind === 'rwy' ? '#f4f4f4' : e.kind === 'twy' ? '#f2c230' : '#57d19a';
    add(`<path d="${path2(e.pts)}" fill="none" stroke="${colour}" stroke-width="${px(e.kind === 'rwy' ? 2.5 : 2)}"/>`);
  }
  for (const n of airfield.nodes) {
    if (n.hold) add(`<circle cx="${X(n.x)}" cy="${Y(n.y)}" r="${px(5)}" fill="#ff4d4d"/>`);
    else if (labels) add(`<circle cx="${X(n.x)}" cy="${Y(n.y)}" r="${px(1.6)}" fill="#fff" fill-opacity="0.7"/>`);
  }
  for (const s of airfield.stands) {
    const half = s.span / 2;
    const ux = Math.cos(s.heading);
    const uy = Math.sin(s.heading);
    // A T-shape the size of the aircraft that fits: wingspan across, as long again behind the nose.
    const tail = [s.x - ux * s.span, s.y - uy * s.span];
    const wing = [s.x - ux * s.span * 0.45, s.y - uy * s.span * 0.45];
    const colour = s.contact ? '#8fe3ff' : '#c9a0ff';
    add(`<path d="M${X(s.x)} ${Y(s.y)}L${X(tail[0])} ${Y(tail[1])}M${X(wing[0] - uy * half)} ${Y(wing[1] + ux * half)}L${X(wing[0] + uy * half)} ${Y(wing[1] - ux * half)}" stroke="${colour}" stroke-width="${px(1.6)}" fill="none" opacity="0.9"/>`);
    if (s.bridge) add(`<path d="${path2(s.bridge)}" fill="none" stroke="#ffffff" stroke-width="${px(3)}"/>`);
    if (labels) add(`<text x="${X(s.x + ux * 9)}" y="${Y(s.y + uy * 9)}" font-size="${px(11)}" fill="#fff" text-anchor="middle" dominant-baseline="middle">${s.id}</text>`);
  }
  if (labels) {
    const seen = new Set<string>();
    for (const e of airfield.edges) {
      if (!e.ref || e.len < 60) continue;
      const key = `${e.ref}:${Math.round(e.pts[0] / 300)}:${Math.round(e.pts[1] / 300)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = Math.floor(e.pts.length / 4) * 2;
      add(`<text x="${X(e.pts[m])}" y="${Y(e.pts[m + 1])}" font-size="${px(15)}" font-weight="700" fill="#111" stroke="#f2c230" stroke-width="${px(5)}" paint-order="stroke" text-anchor="middle" dominant-baseline="middle">${e.ref}</text>`);
    }
    for (const r of airfield.runways) {
      for (const end of r.ends) add(`<text x="${X(end.x)}" y="${Y(end.y)}" font-size="${px(34)}" font-weight="700" fill="#fff" stroke="#000" stroke-width="${px(6)}" paint-order="stroke" text-anchor="middle" dominant-baseline="middle">${end.name}</text>`);
    }
  }
  add(`<circle cx="${X(airfield.tower[0])}" cy="${Y(airfield.tower[1])}" r="${px(9)}" fill="#ffd166" stroke="#000"/>`);
}
if (terminals && labels) {
  for (const b of terminals.buildings) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < b.poly.outer.length; i += 2) {
      sx += b.poly.outer[i];
      sy += b.poly.outer[i + 1];
    }
    const n = b.poly.outer.length / 2;
    add(`<text x="${X(sx / n)}" y="${Y(sy / n)}" font-size="${px(20)}" font-weight="700" fill="#fff" stroke="#17335c" stroke-width="${px(5)}" paint-order="stroke" text-anchor="middle">${b.name}</text>`);
  }
}
// Scale bar and north arrow.
const bar = half > 1500 ? 1000 : half > 400 ? 200 : 50;
add(`<path d="M40 ${size - 40}h${(bar * scale).toFixed(1)}" stroke="#fff" stroke-width="4"/><text x="40" y="${size - 52}" font-size="22" fill="#fff">${bar} m</text>`);
add(`<path d="M${size - 60} 90l-14 40h28z" fill="#fff"/><text x="${size - 60}" y="76" font-size="24" fill="#fff" text-anchor="middle">N</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" font-family="-apple-system, Helvetica, Arial, sans-serif">\n${parts.join('\n')}\n</svg>\n`;
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), svg);
console.log(resolve(out), `${(svg.length / 1024).toFixed(0)} KiB`);
