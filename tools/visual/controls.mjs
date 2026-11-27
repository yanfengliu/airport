#!/usr/bin/env node
// Drive the built app's controls through real mouse and keyboard input and check that each does
// what it says: speed and pause, the panels, picking an aircraft on the map and following it,
// picking one from the flight board, the weather, closing a runway and a checkpoint, the
// cut-away view. Saves a capture after each step for looking at.
//
//   npm run build && node tools/visual/controls.mjs [--size 1920x1080] [--out <dir>] [--query "t=14:00"]
//
// Exit code 1 if any check fails, the page logs an error, or it draws on a software renderer.

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('controls: dist/index.html is missing. Run `npm run build` first.');
  process.exit(2);
}
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const [width, height] = option('size', '1920x1080').split('x').map(Number);
const out = resolve(option('out', join(root, 'artifacts', 'visual', `controls-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
mkdirSync(out, { recursive: true });

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

const results = [];
const errors = [];
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
const sfo = (expression) => page.evaluate(expression);
let step = 0;
const check = async (name, ok, detail = '') => {
  step += 1;
  const file = join(out, `${String(step).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: file });
  results.push({ name, ok: Boolean(ok), detail, file });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
/** Advance the simulation by real seconds of frames at the current speed. */
const run = (ms) => page.waitForTimeout(ms);

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?${option('query', 't=14:00&view=terminals')}`);
  await page.waitForFunction(() => window.__sfo?.ready === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  const gpu = await sfo('window.__sfo.gpu');
  await check('opens on the GPU with the operations panel', /apple|metal|angle/i.test(gpu) && !/swiftshader|llvmpipe|software/i.test(gpu) && (await page.isVisible('.ops')), gpu);

  // Speed: buttons and the keyboard.
  await page.click('[data-speed="60"]');
  const t0 = await sfo('window.__sfo.time()');
  await run(1500);
  const t1 = await sfo('window.__sfo.time()');
  await check('60x runs the clock about sixty times real time', t1 - t0 > 40 && t1 - t0 < 200, `${Math.round(t1 - t0)} s in 1.5 s`);
  await page.keyboard.press('Space');
  const p0 = await sfo('window.__sfo.time()');
  await run(800);
  const p1 = await sfo('window.__sfo.time()');
  await check('Space pauses', p1 === p0, `${p1 - p0} s while paused`);
  await page.keyboard.press('Space');
  await page.click('[data-speed="1"]');

  // Panels.
  await page.keyboard.press('KeyO');
  await check('O hides the operations panel', !(await page.isVisible('.ops')));
  await page.click('[data-panel="ops"]');
  await check('the Operations button shows it again', await page.isVisible('.ops'));
  await page.keyboard.press('KeyB');
  await check('B opens the flight board', await page.isVisible('.board') && (await page.locator('.board-row:not(.board-head)').count()) > 4);
  await page.click('[data-tab="arrivals"]');
  await check('the Arrivals tab shows arrivals', (await page.textContent('.city-head')) === 'From');

  // Picking an aircraft on the map: the nearest one on screen that is on the ground.
  const target = await sfo(`(() => {
    const sim = window.__sfo.sim();
    for (const a of sim.airside.aircraft) {
      if (a.alt > 1 || a.phase === 'gone') continue;
      const s = window.__sfo.screenOf(a.id);
      if (s && s.onScreen && s.x > 650 && s.x < ${width} - 420 && s.y > 120 && s.y < ${height} - 120) return { id: a.id, x: s.x, y: s.y };
    }
    return null;
  })()`);
  if (target) {
    await page.keyboard.press('Space');
    await page.mouse.click(target.x, target.y);
    const selected = await sfo('window.__sfo.selected()');
    await check('clicking an aircraft opens its card', selected !== null && (await page.isVisible('.inspector')), `picked #${selected}, aimed at #${target.id}`);
    await page.keyboard.press('KeyF');
    await page.keyboard.press('Space');
    await run(1500);
    await check('F follows it', (await sfo('window.__sfo.following()')) === selected);
    await page.keyboard.press('Escape');
    await check('Escape closes the card', !(await page.isVisible('.inspector')));
  } else {
    await check('clicking an aircraft opens its card', false, 'no aircraft on the ground in view');
  }

  // Picking from the board: a departure that is taxiing or at its gate.
  await page.click('[data-tab="departures"]');
  const row = page.locator('.board-row:not(.board-head)').filter({ hasText: /Taxiing|Boarding|Gate closed|On time|Final call/ }).first();
  await row.click();
  await run(800);
  const picked = await sfo('window.__sfo.selected()');
  await check('a board row picks and follows its aircraft', picked !== null && (await sfo('window.__sfo.following()')) === picked);
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyB');

  // Weather: a southeast storm turns the runways round, through the changeover.
  await page.click('[data-weather="storm"]');
  await run(300);
  const changing = await sfo('window.__sfo.ops()');
  await check('a southeast storm starts the change to the Southeast Plan', changing.plan === 'Southeast' && changing.changeover > 0, `${changing.plan}, ${Math.round(changing.changeover)} s of changeover`);
  await page.click('[data-weather="fog"]');
  await run(300);
  const fog = await sfo('window.__sfo.ops()');
  await check('fog leaves one arrival stream', fog.paired === false && fog.landing.length === 1, fog.landing.join(' '));
  await page.click('[data-weather="clear"]');

  // Runways and checkpoints.
  await page.click('[data-runway="01R/19L"]');
  await run(300);
  const closedRunway = await sfo('window.__sfo.ops()');
  await check('closing 01R stops departures from it', closedRunway.runways.find((r) => r.id === '01R/19L').closed && !closedRunway.departing.includes('01R'), closedRunway.departing.join(' '));
  await page.click('[data-runway="01R/19L"]');
  const c = await sfo(`window.__sfo.ops().checkpoints.find((cp) => cp.name === 'C').id`);
  await page.click(`[data-checkpoint="${c}"]`);
  await run(300);
  await check('closing Checkpoint C is taken up', (await sfo('window.__sfo.operator().checkpoints')).includes(c) && (await page.textContent('.ops-log')).includes('Checkpoint C closed'));
  for (const name of ['E', 'F', 'G']) {
    const id = await sfo(`window.__sfo.ops().checkpoints.find((cp) => cp.name === '${name}').id`);
    await page.click(`[data-checkpoint="${id}"]`);
    await run(200);
  }
  await check('closing the last way through security to E, F and G is refused, and says why', /No other way/.test(await page.textContent('.ops-notice')), await page.textContent('.ops-notice'));

  // The cut-away view.
  await page.keyboard.press('KeyI');
  await run(600);
  await check('I lifts the roofs onto the departures level', await page.isVisible('[data-inside="departures"].on'));
  await page.keyboard.press('KeyI');
  await page.keyboard.press('KeyI');

  // The day jump keeps what the viewer set up.
  await page.click('[data-jump="dusk"]');
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 60_000 });
  const after = await sfo('window.__sfo.ops()');
  await check('a jump in time keeps the closed checkpoints', after.checkpoints.filter((cp) => cp.closed).length === 3, after.checkpoints.filter((cp) => cp.closed).map((cp) => cp.name).join(' '));
} catch (error) {
  results.push({ name: 'run', ok: false, detail: error.message });
  console.log(`FAIL  ${error.message}`);
} finally {
  await browser.close();
  server.close();
}
for (const e of errors) console.log(`[console] ${e}`);
writeFileSync(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} checks pass; captures in ${out}`);
process.exit(failed || errors.length ? 1 : 0);
