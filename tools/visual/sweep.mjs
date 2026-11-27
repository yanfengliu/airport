#!/usr/bin/env node
// Visual sweep: drive the built app in headless Chromium through its real controls and save
// full-resolution captures for inspection.
//
//   npm run build && node tools/visual/sweep.mjs [options]
//
//   --size 2560x1440        viewport
//   --times day,dusk,night  which of the HUD's day jumps to visit (dawn, day, dusk, night)
//   --views a,b             fixed views to take (preset ids); default all
//   --random 12             how many seeded-random views per time of day
//   --seed 7                seed for the random views
//   --settle 1200           extra milliseconds to wait before each capture
//   --out <dir>             output folder; default artifacts/visual/<stamp>
//   --query "k=v&k2=v2"     extra query string for the page
//   --no-perf               skip the frame-rate measurement
//
// Fixed views are reached by clicking the preset buttons; random views by wheel, drag and
// right-drag from a preset, so the input path is exercised and not only the camera state.
// Writes manifest.json beside the captures: the view each one ended at, frames per second, the
// GPU that drew it, and any console errors. Then measures the frame rate at the morning peak at
// 1920×1080 with the clock running at 1× and 60× in the busiest views. Exits 1 if the page logged
// an error, drew on a software renderer, or ran slower than 45 frames a second at 1× or 20 at 60×.

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('sweep: dist/index.html is missing. Run `npm run build` first.');
  process.exit(2);
}

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const [width, height] = option('size', '2560x1440').split('x').map(Number);
const times = option('times', 'day,dusk,night').split(',').filter(Boolean);
const randomCount = Number(option('random', '12'));
const seed = Number(option('seed', '7'));
const settle = Number(option('settle', '1200'));
const extraQuery = option('query', '');
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const outDir = resolve(option('out', join(root, 'artifacts', 'visual', stamp)));
mkdirSync(outDir, { recursive: true });

// ---- a static server for dist/ --------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// ---- seeded random --------------------------------------------------------------------------
let state = seed >>> 0;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const between = (a, b) => a + (b - a) * random();

const errors = [];
let browser;
let exitCode = 0;
try {
  // The full Chromium build in new headless mode draws on the GPU; the headless shell does not.
  browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  const started = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?capture=1${extraQuery ? `&${extraQuery}` : ''}`);
  await page.waitForFunction(() => window.__sfo?.ready === true, null, { timeout: 120_000 });
  const loadMs = Date.now() - started;
  const gpu = await page.evaluate(() => window.__sfo.gpu);
  console.log(`loaded in ${loadMs} ms on ${gpu}`);
  if (/swiftshader|llvmpipe|software/i.test(gpu)) {
    errors.push(`software renderer: ${gpu}`);
  }

  const waitSettled = async () => {
    await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
    await page.waitForTimeout(settle);
  };
  const captures = [];
  const capture = async (name, extra = {}) => {
    const file = `${name}.png`;
    await page.screenshot({ path: join(outDir, file) });
    const info = await page.evaluate(() => ({ view: window.__sfo.view(), fps: window.__sfo.fps(), render: window.__sfo.renderInfo(), text: window.render_game_to_text() }));
    captures.push({ file, ...extra, view: info.view, fps: Math.round(info.fps * 10) / 10, render: info.render, state: JSON.parse(info.text) });
    console.log(`  ${file}  ${Math.round(info.fps)} fps, ${info.render.calls} calls, ${info.render.triangles} triangles`);
  };

  const presetIds = await page.$$eval('[data-preset]', (nodes) => nodes.map((n) => n.dataset.preset));
  const views = option('views', presetIds.join(',')).split(',').filter(Boolean);

  for (const time of times) {
    console.log(`time of day: ${time}`);
    await page.click(`[data-jump="${time}"]`);
    await page.click('[data-speed="0"]');

    for (const id of views) {
      await page.click(`[data-preset="${id}"]`);
      await waitSettled();
      await capture(`${time}-fixed-${id}`, { kind: 'fixed', time, preset: id });
    }

    for (let i = 0; i < randomCount; i += 1) {
      // Start from a random preset and wander from it by real wheel and drag input.
      const from = presetIds[Math.floor(random() * presetIds.length)];
      await page.click(`[data-preset="${from}"]`);
      await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
      const steps = 2 + Math.floor(random() * 4);
      const moves = [];
      for (let s = 0; s < steps; s += 1) {
        const x = between(width * 0.2, width * 0.8);
        const y = between(height * 0.25, height * 0.75);
        const roll = random();
        await page.mouse.move(x, y);
        if (roll < 0.4) {
          const delta = between(-900, 700);
          await page.mouse.wheel(0, delta);
          moves.push(`wheel ${Math.round(delta)} at ${Math.round(x)},${Math.round(y)}`);
        } else {
          const button = roll < 0.7 ? 'left' : 'right';
          const dx = between(-width * 0.25, width * 0.25);
          const dy = between(-height * 0.2, height * 0.2);
          await page.mouse.down({ button });
          await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
          await page.mouse.move(x + dx, y + dy, { steps: 6 });
          await page.mouse.up({ button });
          moves.push(`${button}-drag ${Math.round(dx)},${Math.round(dy)} from ${Math.round(x)},${Math.round(y)}`);
        }
        await page.waitForTimeout(120);
      }
      await waitSettled();
      await capture(`${time}-random-${String(i + 1).padStart(2, '0')}`, { kind: 'random', time, from, moves });
    }
  }

  const slowest = captures.reduce((min, c) => Math.min(min, c.fps), Infinity);

  // ---- the 'Fast enough' criterion: the morning peak at 1920×1080, the clock running ----------
  // Frames counted in the page while the simulation runs at 1× and at 60×, in the views that draw
  // the most; the captures above are taken paused and say nothing about this.
  const perf = [];
  if (!argv.includes('--no-perf')) {
    const perfPage = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    perfPage.on('pageerror', (error) => errors.push(`pageerror (perf): ${error.message}`));
    await perfPage.goto(`http://127.0.0.1:${port}/?t=08:00`);
    await perfPage.waitForFunction(() => window.__sfo?.ready === true, null, { timeout: 120_000 });
    const LIMITS = { 1: 45, 60: 20 };
    for (const id of ['overview', 'terminals', 'highway', 'gates']) {
      for (const inside of id === 'terminals' ? ['off', 'departures'] : ['off']) {
        await perfPage.click(`[data-preset="${id}"]`);
        await perfPage.click(`[data-inside="${inside}"]`);
        await perfPage.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
        for (const speed of [1, 60]) {
          await perfPage.click(`[data-speed="${speed}"]`);
          await perfPage.waitForTimeout(800);
          const measured = await perfPage.evaluate(
            (ms) =>
              new Promise((done) => {
                let frames = 0;
                let longest = 0;
                const start = window.performance.now();
                let last = start;
                const tick = (now) => {
                  frames += 1;
                  longest = Math.max(longest, now - last);
                  last = now;
                  if (now - start < ms) requestAnimationFrame(tick);
                  else done({ fps: ((frames - 1) * 1000) / (now - start), longestFrame: longest, clock: window.__sfo.time() });
                };
                requestAnimationFrame(tick);
              }),
            4000,
          );
          const fps = Math.round(measured.fps * 10) / 10;
          const pass = fps >= LIMITS[speed];
          perf.push({ view: id, inside, speed, fps, longestFrameMs: Math.round(measured.longestFrame), clock: measured.clock, pass });
          console.log(`  perf ${id}${inside === 'off' ? '' : ` (${inside})`} at ${speed}×: ${fps} fps, longest frame ${Math.round(measured.longestFrame)} ms${pass ? '' : `  BELOW ${LIMITS[speed]}`}`);
          if (!pass) errors.push(`too slow: ${id} ${inside} at ${speed}× drew ${fps} fps, under ${LIMITS[speed]}`);
        }
        await perfPage.click('[data-speed="0"]');
      }
    }
    await perfPage.close();
  }

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ stamp, size: [width, height], gpu, loadMs, seed, slowestFps: slowest, performance: perf, errors, captures }, null, 2)}\n`);
  console.log(`${captures.length} captures in ${outDir}; slowest paused ${slowest} fps; running at the morning peak, slowest ${perf.length ? Math.min(...perf.map((p) => p.fps)) : "-"} fps`);
} catch (error) {
  errors.push(`sweep: ${error.message}`);
  exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
if (errors.length) {
  console.error(`errors (${errors.length}):\n  ${errors.join('\n  ')}`);
  exitCode = 1;
}
process.exit(exitCode);
