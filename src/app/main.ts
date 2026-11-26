// Entry point: load the layout, build the world, run the frame loop, wire the controls.

import * as THREE from 'three';
import { MapCamera } from '../render/camera.ts';
import { AircraftLayer } from '../render/dynamic/aircraft-layer.ts';
import { TrainLayer } from '../render/dynamic/train-layer.ts';
import { VehicleLayer } from '../render/dynamic/vehicle-layer.ts';
import { Stage } from '../render/stage.ts';
import { buildStaticWorld } from '../render/world.ts';
import { formatClock } from '../shared/sun.ts';
import { CONFIG } from '../sim/config.ts';
import { Sim } from '../sim/sim.ts';
import { SPEEDS, createHud } from '../ui/hud.ts';
import { loadLayout } from './layout-loader.ts';
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
  // The simulation is started some minutes early and run up to the clock time, so the first
  // frame already has aircraft on approach, taxiing and at the gates.
  const WARM_UP = 30 * 60;
  const ROAD_WARM_UP = 7 * 60;
  const startSim = (at: number): Sim => {
    const fresh = new Sim(layout, { seed, startTime: at - WARM_UP, roads: true });
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
  const vehicleLayer = new VehicleLayer();
  const trainLayer = new TrainLayer();
  stage.scene.add(aircraftLayer.group, vehicleLayer.group, trainLayer.group);
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

  const hud = createHud(document.querySelector<HTMLElement>('#hud')!, PRESETS, provenance.attribution, {
    setSpeed,
    jumpTo: (seconds) => {
      // Another time of day is another run of the same day.
      secondsOfDay = seconds;
      sim = startSim(seconds);
      owed = 0;
    },
    goToPreset: (id) => goToPreset(id),
  });
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
    } else if (event.code === 'KeyH') {
      const root = document.querySelector<HTMLElement>('#hud')!;
      hud.setVisible(root.style.display === 'none');
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
    if (sim.roads) vehicleLayer.update(sim.roads.traffic.vehicles, owed / CONFIG.dt, camera.distance, lamps);
    if (sim.transit) trainLayer.update(sim.transit, owed / CONFIG.dt);
    world.update(realSeconds, stage.day, { height: canvas.height, fov: stage.camera.fov, fog: stage.fogDensity, lamp: stage.lampGain });
    stage.render();
    hud.update({ secondsOfDay, speed, fps, presetId });
  };

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
