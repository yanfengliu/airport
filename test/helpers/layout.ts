// Read the committed layout from disk, for tests and headless runs.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_FILES, type Layout, type Provenance } from '../../src/shared/layout.ts';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = join(repoRoot, 'public', 'data');

let cached: Layout | null = null;

export function loadLayoutFromDisk(): Layout {
  if (!cached) {
    cached = Object.fromEntries(LAYOUT_FILES.map((name) => [name, JSON.parse(readFileSync(join(dataDir, `${name}.json`), 'utf8'))])) as unknown as Layout;
  }
  return cached;
}

export function loadProvenanceFromDisk(): Provenance {
  return JSON.parse(readFileSync(join(dataDir, 'provenance.json'), 'utf8')) as Provenance;
}
