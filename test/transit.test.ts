// Trains run: AirTrain round both its lines calling at every station, BART into the airport and
// Millbrae, Caltrain through Millbrae and San Bruno, no two trains run into each other, and those
// aboard a train that leaves the map get off beyond it. Bound: two simulated hours, three for the riders.

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

/** A car seen from above, where and which way it is drawn: a box its route's car length, coupling gap included, and its full body width. */
interface CarBox {
  train: number;
  x: number;
  y: number;
  z: number;
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
}

/** How far two boxes are inside each other: the least they overlap along any of the four ways their sides face, above zero only if they overlap. */
function depthInside(a: CarBox, b: CarBox): number {
  const extent = (c: CarBox, nx: number, ny: number): number => c.halfLength * Math.abs(c.ux * nx + c.uy * ny) + c.halfWidth * Math.abs(c.ux * ny - c.uy * nx);
  let least = Infinity;
  for (const [nx, ny] of [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]]) least = Math.min(least, extent(a, nx, ny) + extent(b, nx, ny) - Math.abs((b.x - a.x) * nx + (b.y - a.y) * ny));
  return least;
}

/**
 * Pairs of trains whose bodies are inside each other, wherever they are: every visible car as a
 * box at its full size, compared with every other train's level with it. Also how deep the
 * deepest pair is in, metres.
 */
function trainsInsideEachOther(transit: Transit): { pairs: number; deepest: number } {
  const pose = { x: 0, y: 0, z: 0, heading: 0, visible: false };
  // Wider than any two cars can reach from their middles, so that only neighbouring cells need looking at.
  const CELL = 30;
  const grid = new Map<string, CarBox[]>();
  const boxes: CarBox[] = [];
  for (const train of transit.trains) {
    const route = transit.routes[train.route];
    for (let car = 0; car < route.cars; car += 1) {
      transit.carPose(train, car, pose);
      if (!pose.visible) continue;
      const box = { train: train.id, x: pose.x, y: pose.y, z: pose.z, ux: Math.cos(pose.heading), uy: Math.sin(pose.heading), halfLength: route.carLength / 2, halfWidth: route.width / 2 };
      boxes.push(box);
      const key = `${Math.floor(box.x / CELL)},${Math.floor(box.y / CELL)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(box);
    }
  }
  const pairs = new Set<string>();
  let deepest = 0;
  for (const a of boxes) {
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const b of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (b.train <= a.train || Math.abs(a.z - b.z) >= 3) continue;
          const depth = depthInside(a, b);
          if (depth <= 0) continue;
          pairs.add(`${a.train}-${b.train}`);
          deepest = Math.max(deepest, depth);
        }
      }
    }
  }
  return { pairs: pairs.size, deepest };
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
  let deepest = 0;
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
    // Every step: two trains passing on close tracks can be inside each other for only a second or two.
    const inside = trainsInsideEachOther(transit);
    collisions += inside.pairs;
    deepest = Math.max(deepest, inside.deepest);
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
    // The bodies are judged at their full size, so every route must say what that is.
    for (const route of transit.routes) expect(route.carLength > 0 && route.width > 0, `${route.id} has a car size`).toBe(true);
    expect(collisions, `the deepest pair was ${deepest.toFixed(2)} m inside each other`).toBe(0);
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

describe('riders on a train that leaves the map', () => {
  // A party boards at every call and nobody gets off at any, as at the airport's BART station,
  // which leads into the terminals: those aboard a train that runs off the map get off beyond it.
  const transit = buildTransit(layout.rail);
  const PARTY = 20;
  transit.onDoorsOpen = (train, route) => {
    if (!route.loop) train.load += PARTY;
  };
  /** Times a train left the map with people aboard, and steps it spent away with people still aboard. */
  let leftLoaded = 0;
  let awayLoaded = 0;
  const most = new Map<number, number>();
  const before = new Map<number, { load: number; away: boolean }>();
  let now = 8 * 3600;
  for (let i = 0; i < (3 * 3600) / CONFIG.dt; i += 1) {
    now += CONFIG.dt;
    transit.step(CONFIG.dt, now);
    for (const train of transit.trains) {
      if (transit.routes[train.route].loop) continue;
      const away = train.awayUntil >= 0;
      const was = before.get(train.id);
      if (away && was && !was.away && was.load > 0) leftLoaded += 1;
      if (away && train.load > 0) awayLoaded += 1;
      most.set(train.route, Math.max(most.get(train.route) ?? 0, train.load));
      before.set(train.id, { load: train.load, away });
    }
  }

  it('sets down everyone aboard once the train has gone, so its load comes back down', () => {
    expect(leftLoaded).toBeGreaterThan(0);
    expect(awayLoaded).toBe(0);
    // Each run along the line starts empty: never more aboard than one run's calls bring.
    for (const [r, load] of most) expect(load, transit.routes[r].id).toBeLessThanOrEqual(PARTY * transit.routes[r].stops.length);
  });
});
