// Entry point: load the layout, build the world, run the frame loop, wire the controls.

import * as THREE from 'three';
import { MapCamera } from '../render/camera.ts';
import { AircraftLayer } from '../render/dynamic/aircraft-layer.ts';
import { BridgeLayer } from '../render/dynamic/bridge-layer.ts';
import { GseLayer } from '../render/dynamic/gse-layer.ts';
import { PeopleLayer } from '../render/dynamic/people-layer.ts';
import { TrainLayer } from '../render/dynamic/train-layer.ts';
import { buildInteriors } from '../render/static/interiors.ts';
import { VehicleLayer } from '../render/dynamic/vehicle-layer.ts';
import { Stage } from '../render/stage.ts';
import { buildStaticWorld } from '../render/world.ts';
import { formatClock } from '../shared/sun.ts';
import { CONFIG } from '../sim/config.ts';
import { AIRLINE_BY_CODE } from '../sim/fleet.ts';
import { Sim } from '../sim/sim.ts';
import { WEATHER_PRESETS, type Weather } from '../sim/weather.ts';
import { createBoard } from '../ui/board.ts';
import { INSIDE, SPEEDS, createHud, type Inside, type PanelId } from '../ui/hud.ts';
import { createInspector } from '../ui/inspector.ts';
import { createOpsPanel } from '../ui/ops.ts';
import { describeAircraft, pickAircraft } from './inspect.ts';
import { loadLayout } from './layout-loader.ts';
import { opsSnapshot } from './ops-source.ts';
import { PRESETS, presetById } from './presets.ts';

declare global {
  interface Window {
    /** Handles for automated checks; not an API for the page itself. */
    __sfo?: Record<string, unknown>;
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

const params = new URLSearchParams(window.location.search);

function parseClock(value: string | null, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return fallback;
  return (Number(match[1]) % 24) * 3600 + Number(match[2]) * 60;
}

const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingFill = document.querySelector<HTMLElement>('#loading-fill')!;
const loadingText = document.querySelector<HTMLElement>('#loading-text')!;

function progress(fraction: number, text: string): void {
  loadingFill.style.width = `${Math.round(fraction * 100)}%`;
  loadingText.textContent = text;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function start(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  const stage = new Stage({ canvas, preserveDrawingBuffer: params.has('capture') });
  const camera = new MapCamera(stage.camera, canvas);

  const { layout, provenance } = await loadLayout((done, total) => progress((done / total) * 0.6, 'Loading the airport…'));
  progress(0.7, 'Building the scene…');
  await nextFrame();
  const world = buildStaticWorld(layout);
  stage.scene.add(world.group);
  const [west, south, east, north] = layout.land.bounds;
  camera.bounds = Math.max(Math.abs(west), Math.abs(south), east, north) + 400;

  let secondsOfDay = parseClock(params.get('t'), 8.5 * 3600);
  const seed = Number(params.get('seed') ?? 7) || 7;
  /** What the viewer has set the airport up for: kept when the day is started again at another time. */
  const operator = {
    weather: WEATHER_PRESETS.some((p) => p.id === params.get('weather')) ? params.get('weather')! : 'clear',
    runways: new Set<string>(),
    checkpoints: new Set<number>(),
  };
  const weatherOf = (id: string): Weather => (WEATHER_PRESETS.find((p) => p.id === id) ?? WEATHER_PRESETS[0]).weather;
  // The simulation is started some minutes early and run up to the clock time, so the first
  // frame already has aircraft on approach, taxiing and at the gates.
  const WARM_UP = 30 * 60;
  const ROAD_WARM_UP = 7 * 60;
  const startSim = (at: number): Sim => {
    const fresh = new Sim(layout, { seed, startTime: at - WARM_UP, roads: true, people: true, weather: weatherOf(operator.weather) });
    for (const id of operator.runways) fresh.setRunwayClosed(id, true);
    for (const id of operator.checkpoints) fresh.setCheckpointClosed(id, true);
    // The roads fill in a few minutes; the airfield needs longer to get its aircraft into place.
    fresh.roadsRunning = false;
    fresh.run(WARM_UP - ROAD_WARM_UP);
    fresh.roadsRunning = true;
    fresh.run(ROAD_WARM_UP);
    return fresh;
  };
  progress(0.85, 'Starting the day…');
  await nextFrame();
  let sim = startSim(secondsOfDay);
  /** Simulated seconds owed to the simulation, less than one step. */
  let owed = 0;
  const aircraftLayer = new AircraftLayer();
  const gseLayer = new GseLayer(new Set(layout.airfield.stands.filter((s) => !s.contact).map((s) => s.id)));
  const bridgeLayer = new BridgeLayer(world.bridgeEnds);
  const vehicleLayer = new VehicleLayer();
  const trainLayer = new TrainLayer();
  const peopleLayer = new PeopleLayer(60_000);
  const interiors = buildInteriors(layout, sim.terminals!);
  stage.scene.add(aircraftLayer.group, gseLayer.group, bridgeLayer.group, vehicleLayer.group, trainLayer.group, peopleLayer.group, interiors.departures, interiors.arrivals);
  let inside: Inside = 'off';
  /** Lift the terminal roofs and show one level inside, or put them back. */
  const setInside = (next: Inside): void => {
    inside = next;
    world.terminalShell.visible = next === 'off';
    interiors.departures.visible = next === 'departures';
    interiors.arrivals.visible = next === 'arrivals';
    peopleLayer.group.visible = next !== 'off';
    peopleLayer.floors = [next === 'arrivals', next === 'departures', next === 'departures'];
  };
  const asked = params.get('inside');
  if (asked === 'departures' || asked === 'arrivals') setInside(asked);
  let speed = Number(params.get('speed') ?? 1);
  if (!Number.isFinite(speed) || speed < 0) speed = 1;
  let resumeSpeed = speed || 1;
  let presetId: string | null = presetById(params.get('view') ?? '')?.id ?? 'overview';
  let fps = 60;

  const setSpeed = (next: number): void => {
    if (next > 0) resumeSpeed = next;
    speed = next;
  };
  const goToPreset = (id: string, immediate = false): void => {
    const preset = presetById(id);
    if (!preset) return;
    presetId = id;
    camera.setFollow(null);
    camera.setView({ h: 0, ...preset.view }, immediate);
  };
  camera.onUserPan = () => {
    presetId = null;
  };

  // ---- panels: operations, flight boards, the aircraft inspector ----------------------------
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const panels: Record<PanelId, boolean> = { flights: params.get('board') === '1', ops: params.get('ops') !== '0' };
  const ops = createOpsPanel(WEATHER_PRESETS, {
    setWeather: (id) => {
      operator.weather = id;
      sim.setWeather(weatherOf(id));
      refreshPanels();
    },
    setRunwayClosed: (id, closed) => {
      if (closed) operator.runways.add(id);
      else operator.runways.delete(id);
      sim.setRunwayClosed(id, closed);
      refreshPanels();
    },
    setCheckpointClosed: (id, closed) => {
      const refused = sim.setCheckpointClosed(id, closed);
      if (refused) ops.notice(refused);
      else if (closed) operator.checkpoints.add(id);
      else operator.checkpoints.delete(id);
      refreshPanels();
    },
  });
  /** The aircraft shown in the inspector, and the one the camera follows, by id; null for none. */
  let selected: number | null = null;
  let followed: number | null = null;
  const inspector = createInspector({
    toggleFollow: () => follow(!(camera.isFollowing && followed === selected)),
    close: () => select(null),
  });
  const refreshInspector = (): void => {
    const a = selected !== null ? sim.airside.byIdMap.get(selected) : undefined;
    if (!a || a.phase === 'gone') {
      selected = null;
      inspector.show(null);
      return;
    }
    inspector.show(describeAircraft(sim, a, camera.isFollowing && followed === a.id));
  };
  const follow = (on: boolean): void => {
    if (on && selected !== null) {
      const id = selected;
      followed = id;
      presetId = null;
      camera.setFollow(() => {
        const a = sim.airside.byIdMap.get(id);
        return a && a.phase !== 'gone' ? { x: a.x, y: a.y, h: a.alt } : null;
      });
    } else {
      camera.setFollow(null);
      followed = null;
    }
    refreshInspector();
  };
  const select = (id: number | null, andFollow = false): void => {
    selected = id;
    if (andFollow) follow(true);
    else if (followed !== null && followed !== id) follow(false);
    refreshInspector();
  };
  const board = createBoard(
    {
      departures: (limit) => sim.airside.book.departuresBoard(sim.time, limit),
      arrivals: (limit) => sim.airside.book.arrivalsBoard(sim.time, limit),
      airlineName: (code) => AIRLINE_BY_CODE[code]?.name ?? code,
    },
    (visit) => {
      const a = sim.airside.aircraft.find((x) => x.visit.id === visit && x.phase !== 'gone');
      if (a) select(a.id, true);
      else ops.notice('That flight has no aircraft here yet');
    },
  );
  const refreshPanels = (): void => {
    ops.root.hidden = !panels.ops;
    board.root.hidden = !panels.flights;
    if (panels.ops) ops.update(opsSnapshot(sim), operator.weather);
    if (panels.flights) board.refresh();
    refreshInspector();
  };
  const togglePanel = (id: PanelId): void => {
    panels[id] = !panels[id];
    refreshPanels();
  };
  camera.onClick = (x, y) => {
    const a = pickAircraft(sim, stage.camera, canvas, x, y);
    select(a ? a.id : null);
  };

  const hud = createHud(hudRoot, PRESETS, provenance.attribution, {
    setSpeed,
    jumpTo: (seconds) => {
      // Another time of day is another run of the same day, set up as the viewer left it.
      secondsOfDay = seconds;
      select(null);
      follow(false);
      sim = startSim(seconds);
      owed = 0;
      refreshPanels();
    },
    goToPreset: (id) => goToPreset(id),
    setInside,
    togglePanel,
  });
  hudRoot.append(board.root, ops.root, inspector.root);
  refreshPanels();
  if (params.get('hud') === '0') hud.setVisible(false);

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code.startsWith('Digit')) {
      const preset = PRESETS[Number(event.code.slice(5)) - 1];
      if (preset) goToPreset(preset.id);
    } else if (event.code === 'Space') {
      event.preventDefault();
      setSpeed(speed === 0 ? resumeSpeed : 0);
    } else if (event.code === 'BracketRight' || event.code === 'BracketLeft') {
      const index = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
      const step = event.code === 'BracketRight' ? 1 : -1;
      setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (index === -1 ? 1 : index) + step))]);
    } else if (event.code === 'KeyI') {
      const order = INSIDE.map((o) => o.id);
      setInside(order[(order.indexOf(inside) + 1) % order.length]);
    } else if (event.code === 'KeyH') {
      hud.setVisible(hudRoot.style.display === 'none');
    } else if (event.code === 'KeyB') {
      togglePanel('flights');
    } else if (event.code === 'KeyO') {
      togglePanel('ops');
    } else if (event.code === 'KeyF') {
      if (selected !== null) follow(!(camera.isFollowing && followed === selected));
    } else if (event.code === 'Escape') {
      select(null);
    }
  });

  // Open a little above the first view and settle into it.
  goToPreset(presetId ?? 'overview', true);
  if (!params.has('capture')) {
    const view = camera.view();
    camera.setView({ distance: view.distance * 1.5, tilt: Math.max(8, view.tilt - 14) }, true);
    goToPreset(presetId ?? 'overview');
  }

  const focus = new THREE.Vector3();
  const drawFrame = (realSeconds: number): void => {
    focus.set(camera.x, camera.h, -camera.y);
    stage.update(secondsOfDay, focus, Math.max(160, camera.distance * 0.9));
    world.lights.begin();
    // Moving lights are only worth placing once it is dark enough to see them.
    const lamps = stage.day < 0.85 ? world.lights : null;
    aircraftLayer.update(sim.airside.aircraft, owed / CONFIG.dt, lamps);
    gseLayer.update(sim.airside.aircraft, sim.time + owed, owed / CONFIG.dt, camera.distance);
    bridgeLayer.update(sim.airside.aircraft, sim.time + owed);
    if (sim.roads) vehicleLayer.update(sim.roads.traffic.vehicles, owed / CONFIG.dt, camera.distance, lamps);
    if (sim.transit) trainLayer.update(sim.transit, owed / CONFIG.dt);
    if (sim.terminals && inside !== 'off') {
      peopleLayer.update(sim.terminals.people, owed / CONFIG.dt, camera.distance);
      interiors.update(sim.terminals, realSeconds);
    }
    world.update(realSeconds, stage.day, { height: canvas.height, fov: stage.camera.fov, fog: stage.fogDensity, lamp: stage.lampGain });
    stage.render();
    hud.update({ secondsOfDay, speed, fps, presetId, inside, panels });
    // The panels are text: once a second of real time is often enough.
    if (realSeconds >= nextPanels || realSeconds < nextPanels - 2) {
      nextPanels = realSeconds + 1;
      refreshPanels();
    }
  };
  let nextPanels = 0;

  /** Run the simulation on by a span of simulated time, in whole steps, keeping the remainder. */
  const advance = (seconds: number): void => {
    owed += seconds;
    // A slow frame is not made up for with a burst of steps that would make the next one slow too.
    let steps = Math.min(240, Math.floor(owed / CONFIG.dt));
    owed -= steps * CONFIG.dt;
    if (owed > CONFIG.dt) owed = CONFIG.dt;
    for (; steps > 0; steps -= 1) sim.step();
    secondsOfDay = (sim.secondsOfDay + owed) % 86400;
  };

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    advance(dt * speed);
    camera.update(dt);
    drawFrame(now / 1000);
    requestAnimationFrame(frame);
  };

  const gl = stage.renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown';

  window.__sfo = {
    ready: true,
    gpu,
    layout,
    stage,
    camera,
    world,
    view: () => camera.view(),
    settled: () => camera.isSettled(),
    time: () => secondsOfDay,
    sim: () => sim,
    fps: () => fps,
    renderInfo: () => ({ calls: stage.renderer.info.render.calls, triangles: stage.renderer.info.render.triangles }),
    ops: () => opsSnapshot(sim),
    selected: () => selected,
    following: () => (camera.isFollowing ? followed : null),
    operator: () => ({ weather: operator.weather, runways: [...operator.runways], checkpoints: [...operator.checkpoints] }),
    /** Screen position of an aircraft's middle, for driving clicks at it. */
    screenOf: (id: number) => {
      const a = sim.airside.byIdMap.get(id);
      if (!a) return null;
      const p = new THREE.Vector3(a.x, a.alt + 2, -a.y).project(stage.camera);
      const box = canvas.getBoundingClientRect();
      return { x: box.left + ((p.x + 1) / 2) * box.width, y: box.top + ((1 - p.y) / 2) * box.height, onScreen: p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
    },
  };
  window.render_game_to_text = () =>
    JSON.stringify({
      clock: formatClock(secondsOfDay, true),
      speed,
      view: camera.view(),
      preset: presetId,
      aircraft: sim.airside.aircraft.reduce<Record<string, number>>((count, a) => {
        count[a.phase] = (count[a.phase] ?? 0) + 1;
        return count;
      }, {}),
      movements: sim.airside.tower.stats,
      vehicles: sim.roads ? sim.roads.traffic.vehicles.length : 0,
      world: world.stats,
      layout: {
        runways: layout.airfield.runways.map((r) => r.id),
        stands: layout.airfield.stands.length,
        roadEdges: layout.roads.edges.length,
        buildings: layout.buildings.buildings.length + layout.buildings.boxes.length / 6,
      },
    });
  window.advanceTime = (ms: number) => {
    const seconds = ms / 1000;
    advance(seconds * speed);
    camera.update(seconds);
    drawFrame(performance.now() / 1000);
  };

  progress(1, 'Ready');
  drawFrame(0);
  requestAnimationFrame(frame);
  loading.classList.add('done');
  canvas.focus();
}

start().catch((error: unknown) => {
  console.error(error);
  loadingText.classList.add('error');
  loadingText.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
});
