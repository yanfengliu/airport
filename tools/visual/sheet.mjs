#!/usr/bin/env node
// Lay a folder of captures out as one contact sheet, for a first look across many views at once.
// A sheet shows gross faults only; a capture that matters is still opened at full size.
//
//   node tools/visual/sheet.mjs <folder> [--match night-random] [--columns 4] [--cell 640]
//        [--out <folder>/sheet-<match>.png]

import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const folder = resolve(argv[0] ?? '.');
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const match = option('match', '');
const columns = Number(option('columns', '4'));
const cell = Number(option('cell', '640'));
const out = resolve(option('out', join(folder, `sheet-${match || 'all'}.png`)));

const files = readdirSync(folder)
  .filter((f) => f.endsWith('.png') && !f.startsWith('sheet-') && f.includes(match))
  .sort();
if (files.length === 0) {
  console.error(`no captures in ${folder} matching "${match}"`);
  process.exit(1);
}

const sheet = join(folder, '.sheet.html');
const cells = files
  .map((f) => `<figure><img src="${encodeURIComponent(f)}"><figcaption>${f.replace('.png', '')}</figcaption></figure>`)
  .join('');
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #0d1117; display: grid; grid-template-columns: repeat(${columns}, ${cell}px); gap: 4px; padding: 4px; width: max-content; }
  figure { margin: 0; position: relative; }
  img { display: block; width: ${cell}px; }
  figcaption { position: absolute; left: 4px; bottom: 4px; font: 12px/1.2 ui-monospace, monospace; color: #fff; background: rgba(0,0,0,.6); padding: 2px 6px; border-radius: 3px; }
</style>${cells}`;

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // A page with no address may not load local files, so the sheet is a file beside its images.
  writeFileSync(sheet, html);
  await page.goto(pathToFileURL(sheet).href, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.locator('body').screenshot({ path: out });
  console.log(`${files.length} captures -> ${out}`);
} finally {
  await browser.close();
  rmSync(sheet, { force: true });
}
