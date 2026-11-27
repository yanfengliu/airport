// Terminals section: the terminal buildings and what is mapped inside them.

import { closestOnSegment, pointInRing, ringArea, ringCentroid, round1, type Vec2 } from '../../src/shared/geo.ts';
import type { AreaKind, ClosedRoom, IndoorArea, IndoorFloor, IndoorWall, Poi, PoiKind, PolygonData, TerminalBuilding, Terminals } from '../../src/shared/layout.ts';
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
  const ringNames: string[] = [];
  const addBuilding = (id: string, tags: Tags, polygon: Polygon): void => {
    const area = Math.abs(ringArea(polygon.outer));
    if (area < 100) return;
    const outer = simplifyRing(polygon.outer, 0.3);
    const poly: PolygonData = { outer: flat(outer) };
    const holes = polygon.holes.map((h) => simplifyRing(h, 0.3)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 20);
    if (holes.length) poly.holes = holes.map(flat);
    buildings.push({ id, name: tags.name ?? '', poly, height: numberTag(tags, 'height') ?? 18, minHeight: numberTag(tags, 'min_height') ?? 0 });
    rings.push(polygon.outer);
    ringNames.push(tags.name || id);
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

  // ---- each terminal's floors as mapped -------------------------------------------------
  // The map numbers levels building by building: the domestic terminals' departures are level 1
  // and their baggage claim level 0, the International Terminal's 2 and 1. Each building's
  // departures floor is the level most of its shops, cafés, check-in and security are on; its
  // arrivals floor the level of its baggage claim, or of its passport control, or the one below.
  const buildingOf = (p: Vec2): number => rings.findIndex((ring) => pointInRing(p[0], p[1], ring));
  const votes = rings.map(() => ({ departures: new Map<number, number>(), arrivals: new Map<number, number>() }));
  for (const a of areas) {
    const k = buildingOf(ringCentroid(unflat(a.poly.outer)));
    if (k < 0) continue;
    const add = (m: Map<number, number>, weight: number): void => void m.set(a.level, (m.get(a.level) ?? 0) + weight);
    if (a.kind === 'shop' || a.kind === 'food' || a.kind === 'checkin' || a.kind === 'security') add(votes[k].departures, 1);
    if (a.kind === 'claim') add(votes[k].arrivals, 3);
    if (a.kind === 'customs') add(votes[k].arrivals, 1);
  }
  const most = (m: Map<number, number>): number | null => (m.size ? [...m].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0] : null);
  const floors = votes.map((v) => {
    const departures = most(v.departures) ?? 1;
    return { departures, arrivals: most(v.arrivals) ?? departures - 1 };
  });
  const floorAt = (p: Vec2, level: number): IndoorFloor | null => {
    const k = buildingOf(p);
    if (k < 0) return null;
    return level === floors[k].departures ? 'departures' : level === floors[k].arrivals ? 'arrivals' : null;
  };

  // ---- indoor walls, split where their doors open --------------------------------------
  const doorNode = (id: number): boolean => {
    const t = osm.nodes.get(id)?.tags;
    return Boolean(t && (t.door || t.indoor === 'door' || (t.entrance && t.entrance !== 'no')));
  };
  /** A mapped line as pieces of wall, with a gap the width of each door on it. */
  const wallPieces = (ids: readonly number[]): Vec2[][] => {
    const pieces: Vec2[][] = [];
    let current: Vec2[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const p = osm.xy(ids[i]);
      if (!doorNode(ids[i]) || i === 0 || i === ids.length - 1) {
        current.push(p);
        continue;
      }
      // Short of the door on the way in, and on again past it on the way out.
      const half = (numberTag(osm.nodes.get(ids[i])?.tags, 'width') ?? DOOR_WIDTH) / 2;
      const towards = (q: Vec2): Vec2 => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        return [p[0] + ((q[0] - p[0]) / d) * Math.min(half, d), p[1] + ((q[1] - p[1]) / d) * Math.min(half, d)];
      };
      current.push(towards(osm.xy(ids[i - 1])));
      pieces.push(current);
      current = [towards(osm.xy(ids[i + 1]))];
    }
    pieces.push(current);
    return pieces.filter((piece) => piece.length >= 2);
  };
  const walls: IndoorWall[] = [];
  for (const w of osm.ways.values()) {
    if (w.tags?.indoor !== 'wall' || !w.nodes.every((id) => osm.hasNode(id))) continue;
    const points = w.nodes.map((id) => osm.xy(id));
    const middle = points[Math.floor(points.length / 2)];
    for (const level of levelsOf(w.tags, 1)) {
      const floor = floorAt(middle, level);
      if (!floor) continue;
      for (const piece of wallPieces(w.nodes)) walls.push({ floor, pts: flat(simplifyLine(piece, 0.15)) });
    }
  }

  // ---- rooms closed to travellers --------------------------------------------------------
  // A room the map gives no use the simulation has a place for: unlabelled, an office, a
  // storeroom, a nursing or prayer room. Not one named as somewhere travellers go, nor one the
  // size of a hall, which a room so large most likely is, mapped as a room.
  const closed: ClosedRoom[] = [];
  const addClosed = (tags: Tags, polygon: Polygon, doorIds: readonly number[]): void => {
    if (areaKind(tags) || PUBLIC.test(tags.name ?? '') || /^(yes|customers|permissive)$/.test(tags.access ?? '')) return;
    const area = Math.abs(ringArea(polygon.outer));
    if (area < 4 || area > CLOSED_LARGEST) return;
    const level = levelsOf(tags, 1)[0];
    const floor = floorAt(ringCentroid(polygon.outer), level);
    if (!floor) return;
    const outer = simplifyRing(polygon.outer, 0.15);
    if (outer.length < 3) return;
    closed.push({ floor, poly: { outer: flat(outer) }, doors: flat(doorIds.filter(doorNode).map((id) => osm.xy(id)).map(([x, y]) => [round1(x), round1(y)] as Vec2)) });
  };
  for (const w of osm.ways.values()) {
    if (w.tags?.indoor !== 'room') continue;
    const ring = osm.wayRing(w);
    if (ring) addClosed(w.tags, { outer: ring, holes: [] }, w.nodes);
  }
  for (const r of osm.relations.values()) {
    if (r.tags?.indoor !== 'room') continue;
    const ids = r.members.filter((m) => m.type === 'way').flatMap((m) => osm.ways.get(m.ref)?.nodes ?? []);
    for (const polygon of osm.relationPolygons(r)) addClosed(r.tags, polygon, ids);
  }
  walls.sort((a, b) => a.floor.localeCompare(b.floor) || a.pts[0] - b.pts[0] || a.pts[1] - b.pts[1]);
  closed.sort((a, b) => a.floor.localeCompare(b.floor) || a.poly.outer[0] - b.poly.outer[0] || a.poly.outer[1] - b.poly.outer[1]);

  log(`${buildings.length} terminal buildings: ${buildings.map((b) => b.name || b.id).join(', ')}`);
  log(`floors as mapped, departures/arrivals: ${ringNames.map((name, k) => `${name} ${floors[k].departures}/${floors[k].arrivals}`).join(', ')}`);
  log(`indoor areas: ${areas.length} ${JSON.stringify(perKind)}`);
  log(`indoor walls: ${walls.length} pieces, ${(walls.reduce((m, w) => m + lineLength(w.pts), 0) / 1000).toFixed(1)} km; rooms closed to travellers: ${closed.length}`);
  log(`points: ${pois.length} ${JSON.stringify(poiCount)}`);
  return { buildings, areas, pois, walls, closed };
}

/** A door's width where the map does not say, metres. */
const DOOR_WIDTH = 1.2;
/** A room larger than this, square metres, is taken for a hall mapped as a room, not closed. */
const CLOSED_LARGEST = 2500;
/** Names of places travellers go, mapped as rooms. */
const PUBLIC = /gate|hall|lobby|concourse|corridor|waiting|boarding|arrival|departure|terminal|connector|walkway|plaza|court|museum|gallery|chapel|meditation|yoga|play|nursing|lactation|pet|restroom|toilet/i;

function unflat(pts: readonly number[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
}

function lineLength(pts: readonly number[]): number {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
}

/** A line with the points dropped that lie within `tolerance` of the straight run between their neighbours. */
function simplifyLine(pts: readonly Vec2[], tolerance: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    if (closestOnSegment(pts[i], a, b).distance > tolerance) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [round1(x), round1(y)] as Vec2);
}
