// The committed layout is what the plan says it is: SFO's real runways, taxiways, gates, roads
// and rail, connected well enough to drive and taxi on. Bound: these read public/data as
// committed; they do not re-run the OSM build.

import { describe, expect, it } from 'vitest';
import { LAYOUT_FILES } from '../src/shared/layout.ts';
import { loadLayoutFromDisk, loadProvenanceFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();

/** Published runway lengths in metres (FAA airport data, feet converted). */
const PUBLISHED: Record<string, number> = { '01L/19R': 2332, '01R/19L': 2636, '10L/28R': 3618, '10R/28L': 3469 };

function reachable(nodeCount: number, edges: readonly { a: number; b: number }[], from: number): Uint8Array {
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const e of edges) {
    adjacency[e.a].push(e.b);
    adjacency[e.b].push(e.a);
  }
  const seen = new Uint8Array(nodeCount);
  const stack = [from];
  seen[from] = 1;
  while (stack.length) {
    for (const next of adjacency[stack.pop()!]) {
      if (!seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return seen;
}

describe('airfield', () => {
  const { airfield } = layout;

  it('has the four runways at their published lengths, within 1%', () => {
    expect(airfield.runways.map((r) => r.id).sort()).toEqual(Object.keys(PUBLISHED).sort());
    for (const r of airfield.runways) {
      expect(Math.abs(r.length - PUBLISHED[r.id]) / PUBLISHED[r.id], r.id).toBeLessThan(0.01);
      expect(r.ends.map((e) => e.name).sort().join('/'), r.id).toBe(r.id.split('/').sort().join('/'));
    }
  });

  it('names each runway end by the direction flown from it', () => {
    for (const r of airfield.runways) {
      for (const [from, to] of [[r.ends[0], r.ends[1]], [r.ends[1], r.ends[0]]] as const) {
        const bearing = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
        const magnetic = (((bearing - 13) % 360) + 360) % 360;
        const number = Number.parseInt(from.name, 10) * 10;
        const off = Math.abs(((magnetic - number + 540) % 360) - 180);
        expect(off, `${from.name} flown on ${magnetic.toFixed(0)} magnetic`).toBeLessThan(8);
      }
    }
  });

  it('has at least 100 numbered contact gates, each once', () => {
    const gates = airfield.stands.filter((s) => s.contact);
    expect(gates.length).toBeGreaterThanOrEqual(100);
    for (const g of gates) expect(g.id).toMatch(/^[A-G]\d{1,2}[A-Z]?$/);
    expect(new Set(airfield.stands.map((s) => s.id)).size).toBe(airfield.stands.length);
    for (const area of 'ABCDEFG') expect(gates.filter((g) => g.area === area).length, `boarding area ${area}`).toBeGreaterThanOrEqual(8);
  });

  it('joins every stand to every runway through the taxi graph', () => {
    const onRunway = airfield.nodes.findIndex((n) => n.rwy?.length);
    const seen = reachable(airfield.nodes.length, airfield.edges, onRunway);
    expect(seen.reduce((sum, v) => sum + v, 0)).toBe(airfield.nodes.length);
    for (const r of airfield.runways) expect(airfield.nodes.some((n) => n.rwy?.includes(r.id)), r.id).toBe(true);
    for (const s of airfield.stands) {
      const node = airfield.nodes[s.node];
      expect(Math.hypot(node.x - s.x, node.y - s.y), `stand ${s.id} sits on its node`).toBeLessThan(0.3);
    }
  });

  it('keeps each edge consistent with its nodes', () => {
    for (const e of airfield.edges) {
      const a = airfield.nodes[e.a];
      const b = airfield.nodes[e.b];
      const n = e.pts.length;
      expect(Math.hypot(e.pts[0] - a.x, e.pts[1] - a.y)).toBeLessThan(0.3);
      expect(Math.hypot(e.pts[n - 2] - b.x, e.pts[n - 1] - b.y)).toBeLessThan(0.3);
      expect(e.len).toBeGreaterThan(0);
    }
    expect(airfield.nodes.filter((n) => n.hold).length).toBeGreaterThanOrEqual(60);
    expect(new Set(airfield.edges.filter((e) => e.ref).map((e) => e.ref)).size).toBeGreaterThanOrEqual(40);
  });
});

describe('roads and rail', () => {
  const { roads, rail } = layout;

  it('carries US-101, I-380 and both levels of the terminal loop', () => {
    const km = (test: (name: string) => boolean): number => roads.edges.filter((e) => e.name && test(e.name)).reduce((sum, e) => sum + e.len, 0) / 1000;
    expect(km((n) => n === 'US 101')).toBeGreaterThan(8);
    expect(km((n) => n === 'I 380')).toBeGreaterThan(2);
    expect(km((n) => n === 'Departures')).toBeGreaterThan(1.5);
    expect(km((n) => n === 'Arrivals')).toBeGreaterThan(1.5);
    const raised = roads.edges.filter((e) => e.name === 'Departures' && e.pts.some((v, i) => i % 3 === 2 && v > 5));
    expect(raised.length, 'the departures road is on its deck').toBeGreaterThan(0);
  });

  it('is one connected public network with sane heights and lanes', () => {
    const publicEdges = roads.edges.filter((e) => e.cls !== 'airside');
    const seen = reachable(roads.nodes.length, publicEdges, publicEdges.find((e) => e.name === 'US 101')!.a);
    const total = publicEdges.reduce((sum, e) => sum + e.len, 0);
    const joined = publicEdges.filter((e) => seen[e.a]).reduce((sum, e) => sum + e.len, 0);
    expect(joined / total).toBeGreaterThan(0.97);
    for (const n of roads.nodes) {
      expect(n.z).toBeLessThanOrEqual(20.5);
      expect(n.z).toBeGreaterThanOrEqual(-13);
    }
    for (const e of roads.edges) {
      expect(e.lanes).toBeGreaterThanOrEqual(1);
      // The slowest posted limit on the map is 5 mph, on the garage ramps.
      expect(e.speed).toBeGreaterThan(2);
      expect(e.pts.length % 3).toBe(0);
    }
    expect(roads.nodes.filter((n) => n.signal).length, 'traffic signals').toBeGreaterThan(10);
  });

  it('has the AirTrain stations, BART at the airport and Caltrain', () => {
    const airtrain = rail.stations.filter((s) => s.kind === 'airtrain');
    expect(airtrain.length).toBeGreaterThanOrEqual(9);
    for (const s of airtrain) expect(s.stops.length, s.name).toBeGreaterThanOrEqual(2);
    expect(rail.stations.some((s) => s.kind === 'bart' && /International Airport/.test(s.name))).toBe(true);
    for (const kind of ['airtrain', 'bart', 'caltrain'] as const) expect(rail.lines.some((l) => l.kind === kind), kind).toBe(true);
  });
});

describe('terminals, buildings and land', () => {
  it('has the terminal buildings with their mapped interiors', () => {
    const { terminals } = layout;
    const names = terminals.buildings.map((b) => b.name);
    for (const name of ['Harvey Milk Terminal 1', 'Terminal 2', 'Terminal 3', 'International Terminal Main Hall', 'International Boarding Area A', 'International Boarding Area G']) {
      expect(names, name).toContain(name);
    }
    const count = (kind: string): number => terminals.areas.filter((a) => a.kind === kind).length;
    expect(count('security')).toBeGreaterThanOrEqual(5);
    expect(count('checkin')).toBeGreaterThanOrEqual(10);
    expect(count('claim')).toBeGreaterThanOrEqual(4);
    expect(count('shop') + count('food')).toBeGreaterThanOrEqual(60);
    expect(terminals.pois.filter((p) => p.kind === 'door').length).toBeGreaterThanOrEqual(40);
  });

  it('has buildings, one shoreline polygon and the airport boundary', () => {
    const { buildings, land } = layout;
    expect(buildings.buildings.length).toBeGreaterThan(500);
    expect(buildings.boxes.length % 6).toBe(0);
    expect(land.land.length).toBe(1);
    expect(land.airport.length).toBe(1);
    const [west, south, east, north] = land.bounds;
    expect(east - west).toBeGreaterThan(5000);
    expect(north - south).toBeGreaterThan(5000);
    expect(land.piers.length).toBeGreaterThan(3);
  });
});

describe('provenance', () => {
  it('records the source, the licence and every theme the layout was built from', () => {
    const provenance = loadProvenanceFromDisk();
    expect(provenance.license).toMatch(/ODbL/);
    expect(provenance.attribution).toMatch(/OpenStreetMap contributors/);
    for (const theme of ['aero', 'roads', 'roadnodes', 'rail', 'buildings', 'land', 'poi']) {
      expect(provenance.themes[theme], theme).toBeDefined();
      expect(provenance.themes[theme].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(LAYOUT_FILES.length).toBe(6);
  });
});
