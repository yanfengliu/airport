import { expect, it } from 'vitest';
import { COURTYARD_3, courtyard3 } from '../src/shared/courtyard3.ts';
import { insidePolygon } from '../src/sim/terminal/fittings.ts';
import { AIRLINES } from '../src/sim/fleet.ts';
import { buildTerminalPlan, FLOOR } from '../src/sim/terminal/plan.ts';
import { passengerMaps, PASSENGER_TERMINALS } from '../src/ui/terminal-map-data.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const plan = buildTerminalPlan(layout, AIRLINES);
const maps = passengerMaps(layout, plan);

it('places every simulated passenger gate under the official terminal and on the departure floor', () => {
  const seen = new Set<string>();
  for (const [i, map] of maps.entries()) {
    expect(map.outline.length).toBeGreaterThan(0);
    expect(map.destinations.some((p) => p.group === 'Baggage claim' && p.floor === 'arrivals')).toBe(true);
    expect(map.destinations.some((p) => p.group === 'Dining')).toBe(true);
    expect(PASSENGER_TERMINALS[i].map).toMatch(/^https:\/\/www\.flysfo\.com\/.*\.pdf$/);
    for (const p of map.destinations.filter((q) => q.group === 'Gates')) {
      const id = p.name.slice(5);
      const gate = plan.holdroom.get(id)!;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      expect(PASSENGER_TERMINALS[i].gates).toContain(gate.area);
      expect(gate.floor).toBe(FLOOR.airside);
      expect(p).toMatchObject({ x: gate.x, y: gate.y, floor: 'departures' });
    }
  }
  expect(seen.size).toBe(plan.holdroom.size);
});

it('locates named art on the mapped points, and serves Terminals 2 and 3 from the same station', () => {
  const art = maps.flatMap((map) => map.destinations.filter((p) => p.group === 'Public art'));
  expect(art.length).toBeGreaterThan(10);
  for (const p of art) {
    expect(layout.terminals.pois.some((q) => q.kind === 'art' && q.x === p.x && q.y === p.y && q.name === p.name.split(' · near Gate ')[0])).toBe(true);
  }
  const station = (i: number) => maps[i].destinations.find((p) => p.name === 'AirTrain · Terminals 2 and 3');
  expect(station(1)).toBeDefined();
  expect(station(2)).toEqual(station(1));
  expect(maps[2].destinations.some((p) => p.name === 'AirTrain · Terminal 3')).toBe(false);
});

it('locates the same departures-level Courtyard 3 gallery from both connecting terminals', () => {
  const places = maps.map((map) => map.destinations.find((p) => p.name === COURTYARD_3));
  expect(places.map(Boolean)).toEqual([false, true, true, false]);
  expect(places[1]).toEqual(places[2]);
  const gallery = places[1]!;
  expect(gallery.floor).toBe('departures');
  expect(gallery.room).toBe(courtyard3(layout.terminals));
  expect(insidePolygon(gallery.room!, gallery.x, gallery.y)).toBe(true);
});
