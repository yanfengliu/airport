// Trains run: AirTrain round both its lines calling at every station, BART into the airport and
// Millbrae, Caltrain through Millbrae and San Bruno, and no two trains on one line run into each
// other. Bound: one simulated hour.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config.ts';
import { buildTransit } from '../src/sim/transit/routes.ts';
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

describe('an hour of trains', () => {
  const transit = buildTransit(layout.rail);
  const calls = new Map<string, number>();
  transit.onDoorsOpen = (_train, route, stop) => {
    const key = `${route.id}|${stop.name}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  };
  let closest = Infinity;
  let now = 8 * 3600;
  for (let i = 0; i < 3600 / CONFIG.dt; i += 1) {
    now += CONFIG.dt;
    transit.step(CONFIG.dt, now);
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
});
