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
  // The first frame is a running airport: aircraft taxiing and in the air, traffic on the roads,
  // and, with nothing pressed, the clock running and aircraft and vehicles moving from one frame
  // to the next. A count of aircraft in moving phases passes a paused start as well.
  const first = await sfo('JSON.parse(window.render_game_to_text())');
  const moving = ['taxiIn', 'taxiOut', 'approach', 'landing', 'takeoff', 'climb', 'pushback'].reduce((n, phase) => n + (first.aircraft[phase] ?? 0), 0);
  const motion = await page.evaluate(
    () =>
      new Promise((done) => {
        const sim = window.__sfo.sim();
        const where = (list) => new Map(list.map((a) => [a.id, [a.x, a.y]]));
        const moved = (before, list) => list.filter((a) => before.has(a.id) && Math.hypot(a.x - before.get(a.id)[0], a.y - before.get(a.id)[1]) > 0.5).length;
        const clock = window.__sfo.time();
        const steps = sim.steps;
        const aircraft = where(sim.airside.aircraft);
        const vehicles = where(sim.roads.traffic.vehicles);
        let frames = 0;
        const frame = () => {
          frames += 1;
          if (frames < 90) return void requestAnimationFrame(frame);
          done({ frames, clock: window.__sfo.time() - clock, steps: sim.steps - steps, aircraft: moved(aircraft, sim.airside.aircraft), vehicles: moved(vehicles, sim.roads.traffic.vehicles) });
        };
        requestAnimationFrame(frame);
      }),
  );
  await check(
    'opens with the airport already running',
    moving >= 3 && (first.aircraft.parked ?? 0) >= 20 && first.vehicles > 300 && motion.clock > 0.5 && motion.steps > 0 && motion.aircraft + motion.vehicles > 0,
    `${moving} aircraft moving, ${first.aircraft.parked} parked, ${first.vehicles} vehicles; over ${motion.frames} frames the clock ran ${motion.clock.toFixed(2)} s in ${motion.steps} steps and ${motion.aircraft} aircraft and ${motion.vehicles} vehicles moved`,
  );

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

  // The camera, by hand: drag pans, right-drag turns, the wheel zooms, a number key goes to a preset.
  const view = () => sfo('window.__sfo.view()');
  const v0 = await view();
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.down();
  await page.mouse.move(width / 2 - 300, height / 2, { steps: 8 });
  await page.mouse.up();
  await run(400);
  const v1 = await view();
  await check('dragging pans the view', Math.hypot(v1.x - v0.x, v1.y - v0.y) > 50, `moved ${Math.round(Math.hypot(v1.x - v0.x, v1.y - v0.y))} m`);
  await check('moving the camera by hand lets go of the preset', (await page.locator('[data-preset].on').count()) === 0);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(width / 2 + 100, height / 2, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await run(300);
  const v2 = await view();
  await check('right-dragging turns the view', Math.abs(((v2.bearing - v1.bearing + 540) % 360) - 180) > 10, `${Math.round(v1.bearing)}° to ${Math.round(v2.bearing)}°`);
  await page.mouse.wheel(0, -500);
  await run(900);
  const v3 = await view();
  await check('the wheel zooms in', v3.distance < v2.distance * 0.8, `${Math.round(v2.distance)} m to ${Math.round(v3.distance)} m`);
  await page.keyboard.press('Digit2');
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  const v4 = await view();
  await check('a number key goes to its preset', Math.hypot(v4.x + 1130, v4.y + 410) < 5 && Math.abs(v4.distance - 1750) < 20 && (await page.isVisible('[data-preset="terminals"].on')), `${Math.round(v4.x)}, ${Math.round(v4.y)} at ${Math.round(v4.distance)} m`);
  await page.click('[data-speed="1"]');
  await page.keyboard.press('BracketRight');
  const faster = await sfo('JSON.parse(window.render_game_to_text()).speed');
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('BracketLeft');
  const slower = await sfo('JSON.parse(window.render_game_to_text()).speed');
  await check('] goes faster and [ slower, never to a stop', faster === 5 && slower === 1, `1× then ] ${faster}×, then [ [ ${slower}×`);
  await page.keyboard.press('KeyH');
  await check('H hides the bars and panels but not the map credit', !(await page.isVisible('.bar.top')) && !(await page.isVisible('.ops')) && (await page.isVisible('.credit')));
  await page.keyboard.press('KeyH');

  // Panels.
  await page.keyboard.press('KeyO');
  await check('O hides the operations panel', !(await page.isVisible('.ops')));
  await page.click('[data-panel="ops"]');
  await check('the Operations button shows it again', await page.isVisible('.ops'));
  await page.keyboard.press('KeyB');
  const shownRows = await page.locator('.board-row:not(.board-head)').evaluateAll((rows) => rows.filter((r) => getComputedStyle(r).visibility !== 'hidden' && r.dataset.visit).length);
  await check('B opens the flight board, with flights on it', (await page.isVisible('.board')) && shownRows > 4, `${shownRows} rows`);
  await page.click('[data-tab="arrivals"]');
  await check('the Arrivals tab shows arrivals', (await page.textContent('.city-head')) === 'From');

  // Picking an aircraft on the map: one taxiing in view, brought close, and clicked on its wing,
  // well away from its middle.
  const target = await sfo(`(() => {
    const sim = window.__sfo.sim();
    for (const a of sim.airside.aircraft) {
      if (a.alt > 1 || (a.phase !== 'taxiIn' && a.phase !== 'taxiOut') || a.speed < 3) continue;
      const s = window.__sfo.screenOf(a.id);
      if (s && s.onScreen && s.x > 650 && s.x < ${width} - 420 && s.y > 160 && s.y < ${height} - 160) return { id: a.id, x: s.x, y: s.y, span: a.type.span };
    }
    return null;
  })()`);
  if (target) {
    await page.keyboard.press('Space');
    // Close enough that the wing is well clear of the middle on screen, further than the old pick reached.
    let wing = null;
    let middle = null;
    for (let k = 0; k < 10; k += 1) {
      middle = await sfo(`window.__sfo.screenOf(${target.id})`);
      wing = await sfo(`window.__sfo.wingPoint(${target.id}, 0.65)`);
      if (Math.hypot(wing.x - middle.x, wing.y - middle.y) > 60) break;
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.wheel(0, -500);
      await run(300);
      await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
    }
    await page.mouse.click(wing.x, wing.y);
    const selected = await sfo('window.__sfo.selected()');
    const offMiddle = Math.hypot(wing.x - middle.x, wing.y - middle.y);
    await check('clicking an aircraft on its wing opens its own card', selected === target.id && offMiddle > 60 && (await page.isVisible('.inspector')), `aimed at #${target.id} ${Math.round(offMiddle)} px from its middle, picked #${selected}`);
    await page.keyboard.press('KeyF');
    await page.click('[data-speed="5"]');
    const before = await sfo(`(() => { const a = window.__sfo.sim().airside.byIdMap.get(${target.id}); return { x: a.x, y: a.y }; })()`);
    await run(2500);
    const after = await sfo(`(() => { const a = window.__sfo.sim().airside.byIdMap.get(${target.id}); const v = window.__sfo.view(); return { x: a.x, y: a.y, cx: v.x, cy: v.y }; })()`);
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    const off = Math.hypot(after.cx - after.x, after.cy - after.y);
    await check('F follows it: the camera stays on it as it moves', (await sfo('window.__sfo.following()')) === target.id && moved > 10 && off < 25, `it moved ${Math.round(moved)} m; the view is ${Math.round(off)} m from it`);
    await page.click('[data-speed="1"]');
    await page.keyboard.press('Escape');
    await check('Escape closes the card', !(await page.isVisible('.inspector')));
  } else {
    await check('clicking an aircraft on its wing opens its own card', false, 'no aircraft taxiing in view');
  }

  // Picking from the board: a departure that is taxiing or at its gate, and the camera on that one.
  await page.click('[data-preset="terminals"]');
  await page.click('[data-tab="departures"]');
  const row = page.locator('.board-row:not(.board-head)').filter({ hasText: /Taxiing|Boarding|Gate closed|Final call/ }).first();
  const visit = Number(await row.getAttribute('data-visit'));
  await row.click();
  await run(800);
  const picked = await sfo('window.__sfo.selected()');
  const ofVisit = await sfo(`(window.__sfo.sim().airside.aircraft.find((a) => a.visit.id === ${visit} && a.phase !== 'gone') || { id: null }).id`);
  await check('a board row picks and follows the aircraft of that flight', picked !== null && picked === ofVisit && (await sfo('window.__sfo.following()')) === picked, `row for visit ${visit}, picked #${picked}, its aircraft #${ofVisit}`);
  const parked = await page.locator('.board-row[data-visit]').evaluateAll((rows) =>
    rows.map((row) => Number(row.dataset.visit)).find((id) => window.__sfo.sim().airside.aircraft.some((a) => a.visit.id === id && a.phase === 'parked')));
  if (parked !== undefined) await page.locator(`.board-row[data-visit="${parked}"]`).click();
  await check('parked aircraft card shows fuel, maintenance and cabin cleaning', parked !== undefined && /Fuel uplift/.test(await page.textContent('.inspector')) && /inspection/i.test(await page.textContent('.inspector')) && /Cabin cleaning/.test(await page.textContent('.inspector')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyB');
  for (const [cell, label] of [['cleaning', 'ground handling'], ['takings', 'staffed concessions'], ['curbFlow', 'flight-driven curb demand']]) {
    const value = page.locator(`.ops [data-stat="${cell}"]`);
    await value.scrollIntoViewIfNeeded();
    await check(`operations shows ${label}`, /[0-9]/.test(await value.textContent()));
  }

  // Weather: a southeast storm turns the runways round, through the changeover.
  await page.click('[data-weather="storm"]');
  await run(300);
  const changing = await sfo('window.__sfo.ops()');
  await check('a southeast storm starts the change to the Southeast Plan', changing.plan === 'Southeast' && changing.changeover > 0, `${changing.plan}, ${Math.round(changing.changeover)} s of changeover`);
  await page.click('[data-weather="clear"]');
  await run(2000);
  const clearSky = await sfo('window.__sfo.layers()');
  await page.click('[data-weather="fog"]');
  await run(2000);
  const fog = await sfo('window.__sfo.ops()');
  await check('fog leaves one arrival stream', fog.paired === false && fog.landing.length === 1, fog.landing.join(' '));
  const foggy = await sfo('window.__sfo.layers()');
  await check('fog closes in on the picture', foggy.haze > 0.8 && foggy.fog > 5 * clearSky.fog, `haze ${foggy.haze.toFixed(2)}, fog density ${foggy.fog.toExponential(2)} against ${clearSky.fog.toExponential(2)} before`);
  await page.click('[data-weather="clear"]');
  await run(2000);
  await check('clear weather clears it again', (await sfo('window.__sfo.layers()')).haze < 0.05);

  // Runways and checkpoints. A closed runway takes no new departures; those already on their way
  // to it still use it, by design. So the clock runs on twenty minutes and every departure sent
  // on its way after the closure is looked at, not just the list the tower would choose from.
  await page.click('[data-runway="01R/19L"]');
  await run(300);
  const closedRunway = await sfo('window.__sfo.ops()');
  const closedAt = await page.evaluate(() => [...window.__sfo.sim().airside.events].reverse().find((e) => e.kind === 'runways' && e.text.startsWith('Runway 01R/19L closed'))?.time ?? null);
  await page.click('[data-speed="60"]');
  await run(20_000);
  await page.click('[data-speed="1"]');
  const sentOff = await page.evaluate((at) => {
    const sim = window.__sfo.sim();
    const since = at ?? Infinity;
    const sent = [...sim.airside.book.visits.values()].filter((v) => v.offBlockAt > since);
    return { minutes: (sim.time - since) / 60, sent: sent.length, toClosed: sent.filter((v) => v.departureRunway === '01R').map((v) => v.rotation.depFlight) };
  }, closedAt);
  await check(
    'closing 01R sends no new departures to it',
    closedRunway.runways.find((r) => r.id === '01R/19L').closed && !closedRunway.departing.includes('01R') && closedAt !== null && sentOff.sent >= 3 && sentOff.toClosed.length === 0,
    `taking off from ${closedRunway.departing.join(' ')}; ${sentOff.sent} departures pushed back in the ${Math.round(sentOff.minutes)} minutes after the closure, ${sentOff.toClosed.length} of them for 01R${sentOff.toClosed.length ? `: ${sentOff.toClosed.join(' ')}` : ''}`,
  );
  await page.click('[data-runway="01R/19L"]');
  const c = await sfo(`window.__sfo.ops().checkpoints.find((cp) => cp.name === 'C').id`);
  await page.click(`[data-checkpoint="${c}"]`);
  await run(300);
  await check('closing Checkpoint C is taken up', (await sfo('window.__sfo.operator().checkpoints')).includes(c) && (await page.textContent('.ops-log')).includes('Checkpoint C closed'));
  for (const name of ['E', 'F', 'G', 'A', 'B', 'D']) {
    const id = await sfo(`window.__sfo.ops().checkpoints.find((cp) => cp.name === '${name}').id`);
    await page.click(`[data-checkpoint="${id}"]`);
    await run(200);
  }
  const remaining = (await sfo('window.__sfo.ops().checkpoints')).filter((c) => !c.closed).map((c) => c.name);
  await check('closing the last open passenger checkpoint is refused, and says why', remaining.length === 1 && remaining[0] === 'D' && /No other way/.test(await page.textContent('.ops-notice')), await page.textContent('.ops-notice'));

  // The cut-away view: what is drawn, not just which button is lit.
  await page.click('[data-preset="terminals"]');
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  await page.keyboard.press('KeyI');
  await run(600);
  const departuresLevel = await sfo('window.__sfo.layers()');
  await check('I lifts the roofs onto the departures level', (await page.isVisible('[data-inside="departures"].on')) && !departuresLevel.roofs && departuresLevel.departures && !departuresLevel.arrivals && departuresLevel.people, JSON.stringify(departuresLevel));
  await page.keyboard.press('KeyI');
  await run(600);
  const arrivalsLevel = await sfo('window.__sfo.layers()');
  await check('I again shows the arrivals level', !arrivalsLevel.roofs && arrivalsLevel.arrivals && !arrivalsLevel.departures && arrivalsLevel.people, JSON.stringify(arrivalsLevel));
  await page.keyboard.press('KeyI');
  await run(300);
  const roofsBack = await sfo('window.__sfo.layers()');
  await check('I a third time puts the roofs back', roofsBack.roofs && !roofsBack.departures && !roofsBack.arrivals);

  // The map sends the real camera to a selected public place and draws its floor.
  await page.keyboard.press('KeyM');
  await page.getByRole('combobox', { name: 'Passenger terminal' }).selectOption({ label: 'Terminal 2' });
  await page.getByRole('combobox', { name: 'Passenger destination' }).selectOption({ label: 'Gate D1' });
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  const located = await page.evaluate(() => {
    const gate = window.__sfo.sim().terminals.plan.holdroom.get('D1');
    const v = window.__sfo.view();
    return window.__sfo.layers().departures && Math.hypot(gate.x - v.x, gate.y - v.y) < 1;
  });
  await check('passenger map locates gate D1 inside Terminal 2', located && await page.isVisible('.terminal-map'));
  await page.getByRole('combobox', { name: 'Passenger floor' }).selectOption('arrivals');
  await page.getByRole('combobox', { name: 'Passenger destination' }).selectOption({ label: 'Baggage Claim D' });
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 30_000 });
  const claimLocated = await page.evaluate(() => {
    const claim = window.__sfo.sim().terminals.plan.claim.get('D').domestic;
    const v = window.__sfo.view();
    return window.__sfo.layers().arrivals && Math.hypot(claim.x - v.x, claim.y - v.y) < 1;
  });
  await check('passenger map locates baggage claim on arrivals', claimLocated);
  await page.keyboard.press('Escape');
  await check('Escape closes the passenger map', !(await page.isVisible('.terminal-map')));

  // The day jump keeps what the viewer set up, and goes to the time asked for.
  await page.click('[data-jump="dusk"]');
  await page.waitForFunction(() => window.__sfo.settled(), null, { timeout: 60_000 });
  const after = await sfo('window.__sfo.ops()');
  const clock = await sfo('window.__sfo.time()');
  await check('a jump in time goes to dusk and keeps the closed checkpoints', Math.abs(clock - 19 * 3600) < 120 && after.checkpoints.filter((cp) => cp.closed).length === 6, `${(clock / 3600).toFixed(2)} h; closed: ${after.checkpoints.filter((cp) => cp.closed).map((cp) => cp.name).join(' ')}`);
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
