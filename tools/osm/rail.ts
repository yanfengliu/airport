// Rail section: the AirTrain guideway, BART and Caltrain, with their stations.

import { dist, polylineLength, round1, type Vec2 } from '../../src/shared/geo.ts';
import type { Rail, RailLine, RailStation } from '../../src/shared/layout.ts';
import type { OsmData, OsmWay } from './lib/osm.ts';
import { simplify3, solveHeights } from './roads.ts';

type Kind = RailLine['kind'];

function kindOf(way: OsmWay): Kind | null {
  const t = way.tags!;
  if (t.railway === 'monorail') return 'airtrain';
  if (t.railway === 'subway') return 'bart';
  if (t.railway === 'rail' && /Caltrain/.test(t.name ?? '')) return 'caltrain';
  return null;
}

export function buildRail(osm: OsmData, log: (line: string) => void): Rail {
  const ways: { way: OsmWay; kind: Kind }[] = [];
  for (const way of osm.taggedWays('railway', /^(monorail|subway|rail)$/)) {
    const kind = kindOf(way);
    if (!kind) continue;
    const service = way.tags!.service;
    // Yards and sidings are not part of a passenger's journey; crossovers are kept so a route can
    // change track where the real one does.
    if (service && service !== 'crossover') continue;
    ways.push({ way, kind });
  }
  // One line over another clears a train on the lower one with its guideway: about six metres,
  // rail to rail, where the tracks are within a train's width of each other in plan.
  const heights = solveHeights(osm, ways.map((w) => w.way), () => false, { near: 3.5, height: 6 }, log);

  const lines: RailLine[] = [];
  const perKind: Record<string, number> = {};
  for (const { way, kind } of ways) {
    const pts3 = simplify3(way.nodes.filter((id) => osm.hasNode(id)).map((id) => [...osm.xy(id), heights.z(id)] as [number, number, number]), 0.3);
    if (pts3.length < 2) continue;
    const line: RailLine = { kind, pts: pts3.flatMap((p) => [round1(p[0]), round1(p[1]), round1(p[2])]) };
    if (way.tags!.service === 'crossover') line.name = 'crossover';
    lines.push(line);
    perKind[kind] = (perKind[kind] ?? 0) + polylineLength(pts3.map((p) => [p[0], p[1]] as Vec2));
  }

  const vertices: Record<Kind, { p: Vec2; z: number }[]> = { airtrain: [], bart: [], caltrain: [] };
  for (const { way, kind } of ways) for (const id of way.nodes) if (osm.hasNode(id)) vertices[kind].push({ p: osm.xy(id), z: heights.z(id) });
  const nearest = (kind: Kind, p: Vec2): { z: number; distance: number } => {
    let best = { z: 0, distance: Infinity };
    for (const v of vertices[kind]) {
      const d = dist(p, v.p);
      if (d < best.distance) best = { z: v.z, distance: d };
    }
    return best;
  };

  const networkKind = (network: string | undefined): Kind | null => (network === 'SFO AirTrain' ? 'airtrain' : network === 'BART' ? 'bart' : network === 'Caltrain' ? 'caltrain' : null);
  const stations: RailStation[] = [];
  for (const n of osm.taggedNodes('railway', 'station')) {
    const kind = networkKind(n.tags!.network);
    if (!kind || !n.tags!.name) continue;
    const p = osm.xy(n.id);
    const near = nearest(kind, p);
    if (near.distance > 150) continue;
    stations.push({ kind, name: n.tags!.name, x: round1(p[0]), y: round1(p[1]), z: round1(near.z), stops: [] });
  }
  // Where trains actually stop: the stop positions on each track, matched to their station by name.
  for (const n of osm.taggedNodes('railway', 'stop')) {
    const kind = networkKind(n.tags!.network);
    if (!kind) continue;
    const p = osm.xy(n.id);
    const candidates = stations.filter((s) => s.kind === kind && dist([s.x, s.y], p) < 160);
    const station = candidates.sort((a, b) => dist([a.x, a.y], p) - dist([b.x, b.y], p))[0];
    if (station) station.stops.push([round1(p[0]), round1(p[1])]);
  }
  stations.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  log(`${lines.length} lines; km ${JSON.stringify(Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, +(v / 1000).toFixed(1)])))}`);
  log(`stations: ${stations.map((s) => `${s.kind}:${s.name}(${s.stops.length} stops, z ${s.z})`).join(', ')}`);
  return { lines, stations };
}
