#!/usr/bin/env node
// Render a local SVG or HTML file to a PNG with headless Chromium.
//
//   node tools/visual/rasterize.mjs <in.svg|in.html> <out.png> [width] [height]

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [input, output, w = '2400', h = '1800'] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: rasterize.mjs <in.svg|in.html> <out.png> [width] [height]');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(resolve(input)).href);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  await page.screenshot({ path: resolve(output), fullPage: false });
  console.log(resolve(output));
} finally {
  await browser.close();
}
