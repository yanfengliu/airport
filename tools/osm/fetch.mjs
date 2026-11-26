#!/usr/bin/env node
// Fetch the raw OpenStreetMap extract the SFO layout is built from.
//
//   node tools/osm/fetch.mjs [--only <theme>[,<theme>]] [--force]
//
// Raw responses land in artifacts/osm-raw/ (ignored, never committed), one file per theme, plus a
// manifest holding each query, the endpoint that answered, the OSM base timestamp and a sha256.
// tools/osm/build-layout.mjs turns them into the committed public/data/ files and copies the
// provenance across. The public Overpass instances are slow and often full, so every query retries
// with backoff across endpoints; a theme already on disk is kept unless --force is given.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'artifacts', 'osm-raw');

// South, west, north, east. Covers the airfield out to the approach-light piers, the terminal
// core, US-101 from Millbrae Ave to past the I-380 interchange, and the rail corridor west of it.
export const BBOX = [37.597, -122.414, 37.648, -122.348];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const recurse = 'out body;\n>>;\nout skel qt;';

export const THEMES = {
  aero: `(nwr["aeroway"];);\n${recurse}`,
  roads: `(way["highway"];);\n${recurse}`,
  // The recursion above returns road nodes without their tags; signals and stops need them.
  roadnodes: '(node["highway"];);\nout body;',
  rail: `(way["railway"];node["railway"~"station|stop|halt|tram_stop"];nwr["public_transport"];);\n${recurse}`,
  buildings: `(nwr["building"];nwr["building:part"];);\n${recurse}`,
  land: `(way["natural"];relation["natural"];way["waterway"];nwr["landuse"];nwr["amenity"="parking"];way["man_made"];nwr["leisure"];);\n${recurse}`,
  poi: `(node["shop"];node["amenity"];node["tourism"];node["entrance"];node["man_made"];nwr["indoor"];);\n${recurse}`,
};

const queryFor = (theme) => `[out:json][timeout:170][bbox:${BBOX.join(',')}];\n${THEMES[theme]}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(endpoint, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'sfo-sim-build/0.1 (one-off layout preparation)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    const json = JSON.parse(text);
    if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
    if (json.remark) throw new Error(`Overpass remark: ${json.remark}`);
    return { text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTheme(theme) {
  const query = queryFor(theme);
  let wait = 20_000;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    const started = Date.now();
    try {
      const { text, json } = await ask(endpoint, query);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${theme}: ${json.elements.length} elements, ${text.length} bytes from ${endpoint} in ${seconds}s (attempt ${attempt})`);
      return {
        text,
        entry: {
          theme,
          query,
          endpoint,
          fetchedAt: new Date().toISOString(),
          osmBase: json.osm3s?.timestamp_osm_base ?? null,
          elements: json.elements.length,
          bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      };
    } catch (err) {
      console.log(`${theme}: attempt ${attempt} at ${endpoint} failed (${err.message}); waiting ${wait / 1000}s`);
      await sleep(wait);
      wait = Math.min(wait * 1.6, 180_000);
    }
  }
  throw new Error(`${theme}: no endpoint answered after 12 attempts`);
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : Object.keys(THEMES);
for (const theme of only) if (!THEMES[theme]) throw new Error(`unknown theme ${theme}`);

mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { bbox: BBOX, themes: {} };
manifest.bbox = BBOX;

for (const theme of only) {
  const file = join(outDir, `${theme}.json`);
  if (existsSync(file) && manifest.themes[theme] && !force) {
    console.log(`${theme}: already on disk, kept (use --force to refetch)`);
    continue;
  }
  const { text, entry } = await fetchTheme(theme);
  writeFileSync(file, text);
  manifest.themes[theme] = entry;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await sleep(5_000);
}
console.log('done');
