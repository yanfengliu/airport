#!/usr/bin/env node
// Build the committed layout under public/data/ from the raw OSM extract in artifacts/osm-raw/.
//
//   node tools/osm/build-layout.ts [--only airfield,roads,...]
//
// Run `node tools/osm/fetch.mjs` first. Each section is one JSON file; provenance.json records
// the queries, the OSM base timestamp and the digests of the raw files they were built from.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN_LAT, ORIGIN_LON } from '../../src/shared/geo.ts';
import { LAYOUT_FILES, type LayoutSection, type Provenance } from '../../src/shared/layout.ts';
import { buildAirfield } from './airfield.ts';
import { buildBuildings } from './buildings.ts';
import { buildLand } from './land.ts';
import { OsmData } from './lib/osm.ts';
import { buildRail } from './rail.ts';
import { buildRoads } from './roads.ts';
import { buildTerminals } from './terminals.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawDir = join(root, 'artifacts', 'osm-raw');
const outDir = join(root, 'public', 'data');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1].split(',') as LayoutSection[]) : [...LAYOUT_FILES];

const manifestPath = join(rawDir, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('artifacts/osm-raw/manifest.json is missing: run `node tools/osm/fetch.mjs` first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bbox: [number, number, number, number]; themes: Provenance['themes'] & Record<string, { osmBase?: string }> };

// One provenance covers every file. Rebuilding only some of them is right only when the raw extract
// is the one the others were built from; otherwise the provenance would claim the new sources for
// files built from the old.
const provenancePath = join(outDir, 'provenance.json');
if (only.length < LAYOUT_FILES.length && existsSync(provenancePath)) {
  const before = JSON.parse(readFileSync(provenancePath, 'utf8')) as Provenance;
  const changed = Object.entries(manifest.themes).filter(([name, t]) => before.themes[name]?.sha256 !== t.sha256).map(([name]) => name);
  if (changed.length) throw new Error(`the raw extract has changed since public/data was built (${changed.join(', ')}): build every section, not only ${only.join(', ')}`);
}

const osm = new OsmData();
for (const theme of Object.keys(manifest.themes)) osm.load(join(rawDir, `${theme}.json`));

const log = (section: string) => (line: string) => console.log(`[${section}] ${line}`);
mkdirSync(outDir, { recursive: true });

const write = (section: string, data: unknown): void => {
  const text = `${JSON.stringify(data)}\n`;
  writeFileSync(join(outDir, `${section}.json`), text);
  const kib = Buffer.byteLength(text) / 1024;
  console.log(`[${section}] wrote public/data/${section}.json, ${kib.toFixed(0)} KiB`);
  if (kib > 1000) throw new Error(`${section}.json is ${kib.toFixed(0)} KiB: over the 1 MiB limit for a committed file`);
};

const builders: Partial<Record<LayoutSection, () => unknown>> = {
  airfield: () => buildAirfield(osm, log('airfield')),
  terminals: () => buildTerminals(osm, log('terminals')),
  roads: () => buildRoads(osm, log('roads')),
  rail: () => buildRail(osm, log('rail')),
  buildings: () => buildBuildings(osm, log('buildings')),
  land: () => buildLand(osm, manifest.bbox, log('land')),
};

for (const section of only) {
  const build = builders[section];
  if (!build) {
    console.log(`[${section}] no builder yet, skipped`);
    continue;
  }
  write(section, build());
}

const provenance: Provenance = {
  source: 'OpenStreetMap, via the Overpass API',
  license: 'Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/',
  attribution: '© OpenStreetMap contributors, https://www.openstreetmap.org/copyright',
  osmBase: osm.osmBase,
  bbox: manifest.bbox,
  origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
  themes: Object.fromEntries(
    Object.entries(manifest.themes).map(([name, t]) => [name, { query: t.query, elements: t.elements, bytes: t.bytes, sha256: t.sha256, fetchedAt: t.fetchedAt, endpoint: t.endpoint }]),
  ),
  generatedBy: 'tools/osm/fetch.mjs then tools/osm/build-layout.ts',
};
writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log('[provenance] wrote public/data/provenance.json');
