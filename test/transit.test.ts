// Trains run: AirTrain round both its lines calling at every station, BART into the airport and
// Millbrae, Caltrain through Millbrae and San Bruno, and no two trains on one line run into each
// other. Bound: one simulated hour.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config.ts';
import { buildTransit } from '../src/sim/transit/routes.ts';
import type { Transit } from '../src/sim/transit/trains.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const airtrainStations = layout.rail.stations.filter((s) => s.kind === 'airtrain').map((s) => s.name);
const outlying = ['West Field Road', 'Rental Car Center', 'Long Term Parking'];

describe('train routes', () => {
  const transit = buildTransit(layout.rail);
  const route = (id: string) => transit.routes.find((r) => r.id === id);

  it('runs the AirTrain Red Line round the terminals and the Blue Line out to the car parks', () => {
    const red = route('AirTrain Red Line');
    const blue = route('AirTrain Blue Line');
    expect(red && blue).toBeTruthy();
    const ring = airtrainStations.filter((n) => !outlying.includes(n));
    expect(new Set(red!.stops.map((s) => s.name))).toEqual(new Set(ring));
    expect(new Set(blue!.stops.map((s) => s.name))).toEqual(new Set(airtrainStations));
    expect(red!.loop && blue!.loop).toBe(true);
  });

  it('brings BART to the airport and to Millbrae, and Caltrain through Millbrae and San Bruno', () => {
    const bartStops = transit.routes.filter((r) => r.kind === 'bart').flatMap((r) => r.stops.map((s) => s.name));
    expect(bartStops.some((n) => /International Airport/.test(n))).toBe(true);
    expect(bartStops).toContain('Millbrae');
    const caltrainStops = transit.routes.filter((r) => r.kind === 'caltrain').flatMap((r) => r.stops.map((s) => s.name));
    expect(caltrainStops).toContain('Millbrae');
    expect(caltrainStops).toContain('San Bruno');
  });
});

/**
 * Pairs of trains whose bodies are inside each other, wherever they are: points every few metres
 * along every visible car, compared with every other train's within a body's width and height.
 */
function trainsInsideEachOther(transit: Transit): number {
  const pose = { x: 0, y: 0, z: 0, heading: 0, visible: false };
  const CELL = 6;
  const grid = new Map<string, { train: number; x: number; y: number; z: number }[]>();
  const points: { train: number; x: number; y: number; z: number }[] = [];
  for (const train of transit.trains) {
    const route = transit.routes[train.route];
    for (let car = 0; car < route.cars; car += 1) {
      transit.carPose(train, car, pose);
      if (!pose.visible) continue;
      for (let along = -route.carLength / 2; along <= route.carLength / 2; along += 3) {
        const p = { train: train.id, x: pose.x + Math.cos(pose.heading) * along, y: pose.y + Math.sin(pose.heading) * along, z: pose.z };
        points.push(p);
        const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(p);
      }
    }
  }
  const pairs = new Set<string>();
  for (const p of points) {
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (q.train <= p.train) continue;
          if (Math.hypot(p.x - q.x, p.y - q.y) < 2.4 && Math.abs(p.z - q.z) < 3) pairs.add(`${p.train}-${q.train}`);
        }
      }
    }
  }
  return pairs.size;
}

describe('an hour of trains', () => {
  const transit = buildTransit(layout.rail);
  const calls = new Map<string, number>();
  transit.onDoorsOpen = (_train, route, stop) => {
    const key = `${route.id}|${stop.name}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  };
  let closest = Infinity;
  let collisions = 0;
  let vanished = 0;
  /** Trains whose own cars lie on top of each other: a train folding back over itself. */
  let folded = 0;
  const folds = (): number => {
    let n = 0;
    for (const train of transit.trains) {
      const route = transit.routes[train.route];
      const centres: { x: number; y: number }[] = [];
      for (let car = 0; car < route.cars; car += 1) {
        transit.carPose(train, car, pose);
        if (pose.visible) centres.push({ x: pose.x, y: pose.y });
      }
      for (let a = 0; a < centres.length; a += 1) for (let b = a + 1; b < centres.length; b += 1) if (Math.hypot(centres[a].x - centres[b].x, centres[a].y - centres[b].y) < 0.7 * route.carLength) n += 1;
    }
    return n;
  };
  const pose = { x: 0, y: 0, z: 0, heading: 0, visible: false };
  const seen = (train: Transit['trains'][number]): number => {
    let n = 0;
    for (let car = 0; car < transit.routes[train.route].cars; car += 1) {
      transit.carPose(train, car, pose);
      if (pose.visible) n += 1;
    }
    return n;
  };
  let now = 8 * 3600;
  // Two hours: BART's two services share their track into the airport, and meet within the first.
  for (let i = 0; i < 7200 / CONFIG.dt; i += 1) {
    const standing = transit.trains.filter((t) => t.doorsUntil >= 0).map((t) => ({ train: t, cars: seen(t) }));
    now += CONFIG.dt;
    transit.step(CONFIG.dt, now);
    // A train that has just closed its doors, turning round or not, is still all there.
    for (const { train, cars } of standing) if (train.doorsUntil < 0 && seen(train) < cars) vanished += 1;
    if (i % 4 === 0) collisions += trainsInsideEachOther(transit);
    folded += folds();
    // On a loop, the gap from each train to the next one round the line, front to front.
    for (let r = 0; r < transit.routes.length; r += 1) {
      const route = transit.routes[r];
      if (!route.loop) continue;
      const positions = transit.trains.filter((t) => t.route === r).map((t) => t.s).sort((a, b) => a - b);
      for (let k = 0; k < positions.length; k += 1) {
        const next = k + 1 < positions.length ? positions[k + 1] : positions[0] + route.total;
        closest = Math.min(closest, next - positions[k] - route.cars * route.carLength);
      }
    }
  }

  it('calls at every AirTrain station on both lines, every few minutes', () => {
    for (const route of transit.routes.filter((r) => r.kind === 'airtrain')) {
      for (const stop of route.stops) expect(calls.get(`${route.id}|${stop.name}`) ?? 0, `${route.id} at ${stop.name}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('brings BART into the airport station', () => {
    const atAirport = [...calls.entries()].filter(([key]) => key.startsWith('BART') && /International Airport/.test(key)).reduce((sum, [, n]) => sum + n, 0);
    expect(atAirport).toBeGreaterThanOrEqual(3);
  });

  it('never lets one train run into the one ahead', () => {
    expect(closest).toBeGreaterThan(0);
  });

  it('works shared track as blocks, and never has two trains inside each other on any line', () => {
    expect(transit.blockCount).toBeGreaterThanOrEqual(2);
    expect(collisions).toBe(0);
  });

  it('keeps a train in view as it turns round at the end of its line', () => {
    expect(vanished).toBe(0);
  });

  it('turns a train round at a spur without it folding back through itself, and takes no turn a train cannot', () => {
    // Long Term Parking is at the end of a spur: the Blue Line goes out and comes back.
    const blue = transit.routes.find((r) => r.id === 'AirTrain Blue Line')!;
    expect(blue.stops.find((s) => s.name === 'Long Term Parking')?.reverses).toBe(true);
    expect(folded).toBe(0);
    // Between stops a line bends, never doubles back: a train cannot reverse through a junction.
    for (const route of transit.routes) {
      const p = route.pts;
      let previous: number | null = null;
      for (let i = 0; i + 1 < route.cum.length; i += 1) {
        // Points a hair apart, where one leg of a route joins the next, have no direction between them.
        if (route.cum[i + 1] - route.cum[i] < 0.05) continue;
        const heading = Math.atan2(p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 3] - p[i * 3]);
        if (previous !== null) {
          const turn = Math.abs(Math.atan2(Math.sin(heading - previous), Math.cos(heading - previous)));
          const atStop = route.stops.some((s) => s.reverses && Math.abs(s.s - route.cum[i]) < 1);
          if (!atStop) expect(turn, `${route.id} at ${route.cum[i].toFixed(0)} m`).toBeLessThan(Math.PI / 2);
        }
        previous = heading;
      }
    }
  });
});
