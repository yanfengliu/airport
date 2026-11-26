// Terminals section: the terminal buildings and what is mapped inside them.

import { closestOnSegment, pointInRing, ringArea, ringCentroid, round1, type Vec2 } from '../../src/shared/geo.ts';
import type { AreaKind, IndoorArea, Poi, PoiKind, PolygonData, TerminalBuilding, Terminals } from '../../src/shared/layout.ts';
import { flat } from './airfield.ts';
import { simplifyRing } from './land.ts';
import { numberTag, type OsmData, type Polygon, type Tags } from './lib/osm.ts';

const FOOD = /^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court)$/;

function areaKind(tags: Tags): AreaKind | null {
  const name = tags.name ?? '';
  const amenity = tags.amenity ?? '';
  if (amenity === 'security_control' || /^checkpoint|security/i.test(name)) return 'security';
  if (tags.aeroway === 'check-in' || /check.?in/i.test(name)) return 'checkin';
  if (/gate/i.test(name) && /waiting area/i.test(name)) return 'gate';
  if (tags.aeroway === 'baggage_claim' || /baggage claim/i.test(name)) return 'claim';
  if (/primary|secondary|cbp|customs|immigration|re-check/i.test(name)) return 'customs';
  if (amenity === 'toilets') return 'toilets';
  if (amenity === 'lounge' || /lounge|club\b/i.test(name)) return 'lounge';
  if (tags.shop) return 'shop';
  if (FOOD.test(amenity)) return 'food';
  if (/marketplace|hall|lobby|waiting area|food court/i.test(name)) return 'hall';
  if (tags.indoor === 'corridor') return 'corridor';
  return null;
}

function poiKind(tags: Tags): PoiKind | null {
  if (tags.entrance && tags.entrance !== 'emergency' && tags.entrance !== 'service') return 'door';
  if (tags.shop) return 'shop';
  if (FOOD.test(tags.amenity ?? '')) return 'food';
  if (tags.amenity === 'toilets') return 'toilets';
  if (tags.tourism === 'information') return 'info';
  if (tags.amenity === 'atm') return 'atm';
  if (tags.tourism === 'artwork') return 'art';
  if (tags.amenity === 'bench') return 'seat';
  if (tags.amenity === 'drinking_water') return 'water';
  return null;
}

/** Levels named by a tag such as "1" or "0;1;2", lowest first. */
function levelsOf(tags: Tags, fallback: number): number[] {
  const raw = tags.level;
  if (!raw) return [fallback];
  const values = raw.split(';').map((v) => Number.parseFloat(v)).filter((v) => Number.isFinite(v));
  return values.length ? values.sort((a, b) => a - b) : [fallback];
}

function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) best = Math.min(best, closestOnSegment(p, ring[j], ring[i]).distance);
  return best;
}

export function buildTerminals(osm: OsmData, log: (line: string) => void): Terminals {
  // ---- buildings ------------------------------------------------------------------------
  const buildings: TerminalBuilding[] = [];
  const rings: Vec2[][] = [];
  const addBuilding = (id: string, tags: Tags, polygon: Polygon): void => {
    const area = Math.abs(ringArea(polygon.outer));
    if (area < 100) return;
    const outer = simplifyRing(polygon.outer, 0.3);
    const poly: PolygonData = { outer: flat(outer) };
    const holes = polygon.holes.map((h) => simplifyRing(h, 0.3)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 20);
    if (holes.length) poly.holes = holes.map(flat);
    buildings.push({ id, name: tags.name ?? '', poly, height: numberTag(tags, 'height') ?? 18, minHeight: numberTag(tags, 'min_height') ?? 0 });
    rings.push(polygon.outer);
  };
  for (const w of osm.taggedWays('aeroway', 'terminal')) {
    const ring = osm.wayRing(w);
    if (ring) addBuilding(`w${w.id}`, w.tags!, { outer: ring, holes: [] });
  }
  for (const r of osm.taggedRelations('aeroway', 'terminal')) {
    osm.relationPolygons(r).forEach((polygon, i) => addBuilding(`r${r.id}.${i}`, r.tags!, polygon));
  }
  buildings.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const nearTerminal = (p: Vec2, reach: number): boolean => rings.some((ring) => pointInRing(p[0], p[1], ring) || distanceToRing(p, ring) < reach);

  // ---- mapped interiors -----------------------------------------------------------------
  const areas: IndoorArea[] = [];
  const perKind: Record<string, number> = {};
  const addArea = (tags: Tags, polygon: Polygon): void => {
    const kind = areaKind(tags);
    if (!kind) return;
    const area = Math.abs(ringArea(polygon.outer));
    if (area < 12) return;
    if (!nearTerminal(ringCentroid(polygon.outer), 60)) return;
    const outer = simplifyRing(polygon.outer, 0.25);
    if (outer.length < 3) return;
    const entry: IndoorArea = { kind, level: levelsOf(tags, 1)[0], poly: { outer: flat(outer) } };
    if (tags.name) entry.name = tags.name;
    else if (tags.operator) entry.name = tags.operator;
    areas.push(entry);
    perKind[kind] = (perKind[kind] ?? 0) + 1;
  };
  const isIndoor = (tags: Tags | undefined): tags is Tags => Boolean(tags && ((tags.indoor && tags.indoor !== 'no' && tags.indoor !== 'wall' && tags.indoor !== 'door') || tags.aeroway === 'check-in' || tags.aeroway === 'baggage_claim'));
  for (const w of osm.ways.values()) {
    if (!isIndoor(w.tags)) continue;
    const ring = osm.wayRing(w);
    if (ring) addArea(w.tags, { outer: ring, holes: [] });
  }
  for (const r of osm.relations.values()) {
    if (!isIndoor(r.tags)) continue;
    for (const polygon of osm.relationPolygons(r)) addArea(r.tags, polygon);
  }
  areas.sort((a, b) => a.level - b.level || a.kind.localeCompare(b.kind) || (a.name ?? '').localeCompare(b.name ?? ''));

  // ---- points ---------------------------------------------------------------------------
  const pois: Poi[] = [];
  const poiCount: Record<string, number> = {};
  const addPoi = (poi: Poi): void => {
    pois.push(poi);
    poiCount[poi.kind] = (poiCount[poi.kind] ?? 0) + 1;
  };
  for (const n of osm.nodes.values()) {
    if (!n.tags) continue;
    const kind = poiKind(n.tags);
    if (!kind) continue;
    const p = osm.xy(n.id);
    if (!nearTerminal(p, kind === 'door' ? 6 : 2)) continue;
    const poi: Poi = { kind, x: round1(p[0]), y: round1(p[1]), level: levelsOf(n.tags, kind === 'door' ? 0 : 1)[0] };
    if (n.tags.name) poi.name = n.tags.name;
    addPoi(poi);
  }
  // Lifts, stairs and escalators: where one level reaches another.
  for (const w of osm.taggedWays('highway', /^(steps|elevator)$/)) {
    const levels = levelsOf(w.tags!, 0);
    if (levels.length < 2) continue;
    const pts = osm.wayPoints(w);
    const mid = ringCentroid(pts);
    if (!nearTerminal(mid, 40)) continue;
    addPoi({ kind: w.tags!.highway === 'elevator' ? 'lift' : 'stairs', x: round1(mid[0]), y: round1(mid[1]), level: levels[0], to: levels[levels.length - 1] });
  }
  for (const n of osm.taggedNodes('highway', 'elevator')) {
    const levels = levelsOf(n.tags!, 0);
    const p = osm.xy(n.id);
    if (levels.length < 2 || !nearTerminal(p, 40)) continue;
    addPoi({ kind: 'lift', x: round1(p[0]), y: round1(p[1]), level: levels[0], to: levels[levels.length - 1] });
  }
  pois.sort((a, b) => a.kind.localeCompare(b.kind) || a.level - b.level || a.x - b.x || a.y - b.y);

  log(`${buildings.length} terminal buildings: ${buildings.map((b) => b.name || b.id).join(', ')}`);
  log(`indoor areas: ${areas.length} ${JSON.stringify(perKind)}`);
  log(`points: ${pois.length} ${JSON.stringify(poiCount)}`);
  return { buildings, areas, pois };
}
