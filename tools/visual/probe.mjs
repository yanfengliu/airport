#!/usr/bin/env node
// Load the built app headless, optionally act on it, and print or capture what is asked.
//
//   node tools/visual/probe.mjs [--query "t=12:30&view=terminals"] [--size 1920x1080]
//        [--eval "<expression using window.__sfo>"] [--shot out.png] [--wait 1500]
//        [--click "<selector>"]... [--key "<Key>"]...
//
// Clicks and keys are real input events, applied in the order given before the evaluation and
// the capture. For quick checks while working; the sweep is the tool for a full pass.

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const [width, height] = option('size', '1920x1080').split('x').map(Number);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let file = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/?capture=1&${option('query', '')}`);
  await page.waitForFunction(() => window.__sfo?.ready === true, null, { timeout: 120_000 });
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--click') await page.click(argv[i + 1]);
    if (argv[i] === '--key') await page.keyboard.press(argv[i + 1]);
    i += 1;
  }
  void all;
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  await page.waitForTimeout(Number(option('wait', '1200')));
  const expression = option('eval', '');
  if (expression) {
    console.log(JSON.stringify(await page.evaluate(expression), null, 1));
    // Let the page draw a few frames with whatever the expression changed.
    await page.waitForTimeout(400);
  }
  const shot = option('shot', '');
  if (shot) {
    mkdirSync(dirname(resolve(shot)), { recursive: true });
    await page.screenshot({ path: resolve(shot) });
    console.log(resolve(shot));
  }
} catch (error) {
  console.error(error.message);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
