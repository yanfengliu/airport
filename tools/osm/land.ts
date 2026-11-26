// Land section: the shoreline, ground cover, the airport boundary and the approach-light piers.

import { polylineLength, project, ringArea, simplify, type Vec2 } from '../../src/shared/geo.ts';
import type { Land, PolygonData, Surface, SurfaceKind, Waterway } from '../../src/shared/layout.ts';
import { flat } from './airfield.ts';
import type { OsmData, OsmWay, Polygon, Tags } from './lib/osm.ts';
import { aerodromeRing } from './roads.ts';

const FAR = 26_000;

function surfaceKind(tags: Tags): SurfaceKind | null {
  const { natural, landuse, leisure, amenity, man_made: manMade } = tags;
  if (natural === 'water' || landuse === 'reservoir' || landuse === 'basin') return 'water';
  if (natural === 'wetland') return 'wetland';
  if (natural === 'wood' || landuse === 'forest') return 'wood';
  if (natural === 'scrub' || natural === 'shrubbery') return 'scrub';
  if (leisure === 'park') return 'park';
  if (landuse === 'grass' || landuse === 'recreation_ground' || landuse === 'flowerbed' || landuse === 'allotments') return 'grass';
  if (leisure === 'pitch' || leisure === 'golf_course' || leisure === 'garden' || leisure === 'playground') return 'grass';
  if (landuse === 'residential') return 'residential';
  if (landuse === 'commercial' || landuse === 'retail') return 'commercial';
  if (landuse === 'industrial' || landuse === 'railway' || landuse === 'construction' || landuse === 'brownfield' || landuse === 'military') return 'industrial';
  if (amenity === 'parking' && tags.parking !== 'multi-storey' && tags.parking !== 'underground' && !tags.building) return 'parking';
  if (manMade === 'breakwater') return 'rock';
  return null;
}

/** Join coastline ways end to start; the result keeps OSM's rule that land is on the left. */
function coastChain(osm: OsmData): Vec2[] {
  const ways = [...osm.taggedWays('natural', 'coastline')];
  const byStart = new Map<number, OsmWay>();
  const ends = new Set<number>();
  for (const w of ways) {
    byStart.set(w.nodes[0], w);
    ends.add(w.nodes[w.nodes.length - 1]);
  }
  let best: number[] = [];
  for (const first of ways.filter((w) => !ends.has(w.nodes[0]))) {
    const chain = [...first.nodes];
    const seen = new Set<number>([first.id]);
    let next = byStart.get(chain[chain.length - 1]);
    while (next && !seen.has(next.id)) {
      seen.add(next.id);
      chain.push(...next.nodes.slice(1));
      next = byStart.get(chain[chain.length - 1]);
    }
    if (chain.length > best.length) best = chain;
  }
  return best.filter((id) => osm.hasNode(id)).map((id) => osm.xy(id));
}

const toData = (p: Polygon, tolerance: number): PolygonData | null => {
  const outer = simplifyRing(p.outer, tolerance);
  if (outer.length < 3) return null;
  const holes = p.holes.map((h) => simplifyRing(h, tolerance)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 30);
  const data: PolygonData = { outer: flat(outer) };
  if (holes.length) data.holes = holes.map(flat);
  return data;
};

export function simplifyRing(ring: readonly Vec2[], tolerance: number): Vec2[] {
  if (ring.length <= 4) return ring.map((p) => [p[0], p[1]] as Vec2);
  // Simplify as an open line between the two points farthest apart, so no vertex is privileged.
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i += 1) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const first = simplify(ring.slice(0, far + 1), tolerance);
  const second = simplify([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

export function buildLand(osm: OsmData, bbox: [number, number, number, number], log: (line: string) => void): Land {
  const [south, west, north, east] = bbox;
  const sw = project(south, west);
  const ne = project(north, east);
  const bounds: [number, number, number, number] = [Math.round(sw[0]), Math.round(sw[1]), Math.round(ne[0]), Math.round(ne[1])];

  // ---- the shore ------------------------------------------------------------------------
  const chain = simplify(coastChain(osm), 1);
  if (chain.length < 2) throw new Error('no coastline in the extract');
  const start = chain[0];
  const end = chain[chain.length - 1];
  // Beyond the extract the shore carries on south-east towards San Mateo and north towards
  // Brisbane; the land is everything to the west of it.
  const startOut: Vec2 = [start[0] + 0.8 * FAR, start[1] - 0.6 * FAR];
  const endOut: Vec2 = [end[0], end[1] + FAR];
  const land: Vec2[] = [startOut, ...chain, endOut, [-FAR, endOut[1]], [-FAR, startOut[1]]];
  const landData: PolygonData = { outer: flat(ringArea(land) < 0 ? land.reverse() : land) };
  log(`shoreline: ${chain.length} points over ${Math.round(polylineLength(chain))} m`);

  // ---- ground cover -----------------------------------------------------------------------
  const found: { kind: SurfaceKind; name?: string; polygon: Polygon; area: number }[] = [];
  const consider = (tags: Tags | undefined, polygons: Polygon[]): void => {
    if (!tags) return;
    const kind = surfaceKind(tags);
    if (!kind) return;
    for (const polygon of polygons) {
      const area = Math.abs(ringArea(polygon.outer));
      if (area < 60) continue;
      found.push({ kind, name: tags.name, polygon, area });
    }
  };
  for (const w of osm.ways.values()) {
    if (!w.tags) continue;
    const ring = osm.wayRing(w);
    if (ring) consider(w.tags, [{ outer: ring, holes: [] }]);
  }
  for (const r of osm.relations.values()) {
    if (r.tags?.type === 'multipolygon' && r.tags.natural !== 'bay') consider(r.tags, osm.relationPolygons(r));
  }
  const airport = aerodromeRing(osm);
  if (airport) found.push({ kind: 'airfield', name: 'San Francisco International Airport', polygon: { outer: airport, holes: [] }, area: 1e12 });
  found.sort((a, b) => b.area - a.area);

  const surfaces: Surface[] = [];
  const counts: Record<string, number> = {};
  for (const f of found) {
    const data = toData(f.polygon, f.area > 20_000 ? 1.2 : 0.6);
    if (!data) continue;
    const surface: Surface = { kind: f.kind, poly: data };
    if (f.name && f.area > 5000) surface.name = f.name;
    surfaces.push(surface);
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  }
  log(`surfaces: ${surfaces.length} ${JSON.stringify(counts)}`);

  // ---- water lines and piers ------------------------------------------------------------
  const widths: Record<string, number> = { river: 9, canal: 9, stream: 3.5 };
  const waterways: Waterway[] = [];
  for (const w of osm.taggedWays('waterway', /^(river|canal|stream)$/)) {
    if (w.tags!.tunnel) continue;
    const pts = simplify(osm.wayPoints(w), 0.8);
    if (polylineLength(pts) > 25) waterways.push({ width: widths[w.tags!.waterway], pts: flat(pts) });
  }
  const piers = [...osm.taggedWays('man_made', 'pier')]
    .filter((w) => !osm.isClosed(w))
    .map((w) => simplify(osm.wayPoints(w), 0.5))
    .filter((pts) => polylineLength(pts) > 20)
    .map(flat);
  log(`${waterways.length} waterways, ${piers.length} piers`);

  return { bounds, land: [landData], surfaces, airport: airport ? [{ outer: flat(simplifyRing(airport, 1)) }] : [], waterways, piers };
}
