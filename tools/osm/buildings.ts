// Buildings section: everything with a footprint that is not a passenger terminal.

import { pointInRing, ringArea, ringCentroid, round1, type Vec2 } from '../../src/shared/geo.ts';
import type { Building, BuildingKind, Buildings, PolygonData } from '../../src/shared/layout.ts';
import { flat } from './airfield.ts';
import { simplifyRing } from './land.ts';
import { numberTag, type OsmData, type Polygon, type Tags } from './lib/osm.ts';
import { aerodromeRing } from './roads.ts';

const LEVEL_HEIGHT = 3.4;
/** Below this footprint a plain building away from the airport is stored as a box. */
const BOX_BELOW_M2 = 420;

function classify(tags: Tags, area: number, onAirport: boolean): BuildingKind {
  const b = tags.building ?? tags['building:part'] ?? 'yes';
  const name = (tags.name ?? '').toLowerCase();
  if (tags.aeroway === 'hangar' || b === 'hangar' || /hangar|superbay/.test(name)) return 'hangar';
  if (tags.aeroway === 'tower' || tags.man_made === 'tower') return 'tower';
  if (tags.man_made === 'storage_tank') return 'tank';
  if (b === 'roof') return 'roof';
  if (b === 'parking' || tags.amenity === 'parking' || tags.parking === 'multi-storey' || /garage|parking|rental car/.test(name)) return area > 600 ? 'garage' : 'house';
  if (b === 'hotel' || tags.tourism === 'hotel' || /hotel|marriott|westin|hyatt|aloft/.test(name)) return 'hotel';
  if (/cargo/.test(name) || b === 'warehouse') return onAirport ? 'cargo' : 'industrial';
  if (b === 'industrial' || b === 'service' || b === 'shed') return onAirport && area > 1500 ? 'cargo' : 'industrial';
  if (b === 'office' || b === 'commercial' || b === 'retail' || b === 'government') return 'office';
  if (b === 'house' || b === 'residential' || b === 'detached' || b === 'apartments' || b === 'semidetached_house' || b === 'garage') return 'house';
  if (onAirport) return area > 2500 ? 'cargo' : 'industrial';
  return area < 500 ? 'house' : 'generic';
}

function heightOf(tags: Tags, kind: BuildingKind, area: number): number {
  const tagged = numberTag(tags, 'height');
  if (tagged && tagged > 1) return tagged;
  const levels = numberTag(tags, 'building:levels') ?? numberTag(tags, 'levels');
  if (levels && levels > 0) return Math.round((levels * LEVEL_HEIGHT + (kind === 'house' ? 1.5 : 1)) * 10) / 10;
  switch (kind) {
    case 'hangar':
      return area > 10_000 ? 30 : 16;
    case 'garage':
      return 17;
    case 'hotel':
      return 26;
    case 'cargo':
      return 11;
    case 'industrial':
      return area > 3000 ? 10 : 6.5;
    case 'office':
      return area > 2000 ? 14 : 8;
    case 'roof':
      return 5.5;
    case 'tank':
      return 9;
    case 'tower':
      return 30;
    case 'house':
      return area > 260 ? 7.2 : 5.4;
    default:
      return area > 2500 ? 11 : 7;
  }
}

/** Smallest rectangle around a ring, found by trying each edge direction. */
function boundingBox(ring: readonly Vec2[]): { cx: number; cy: number; halfLength: number; halfWidth: number; heading: number } {
  let best = { cx: 0, cy: 0, halfLength: 0, halfWidth: 0, heading: 0, area: Infinity };
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      best = { cx: mu * ux - mv * uy, cy: mu * uy + mv * ux, halfLength: (maxU - minU) / 2, halfWidth: (maxV - minV) / 2, heading: Math.atan2(uy, ux), area };
    }
  }
  return best;
}

export function buildBuildings(osm: OsmData, log: (line: string) => void): Buildings {
  const airport = aerodromeRing(osm);
  const buildings: Building[] = [];
  const boxes: number[] = [];
  const counts: Record<string, number> = {};
  let boxed = 0;

  const add = (tags: Tags, polygon: Polygon): void => {
    const area = Math.abs(ringArea(polygon.outer));
    if (area < 14) return;
    const centre = ringCentroid(polygon.outer);
    const onAirport = airport ? pointInRing(centre[0], centre[1], airport) : false;
    const kind = classify(tags, area, onAirport);
    const height = heightOf(tags, kind, area);
    const minHeight = numberTag(tags, 'min_height');
    counts[kind] = (counts[kind] ?? 0) + 1;
    const simple = kind === 'house' || kind === 'generic' || kind === 'industrial';
    if (simple && area < BOX_BELOW_M2 && !onAirport && !minHeight && polygon.holes.length === 0) {
      const box = boundingBox(polygon.outer);
      // An L-shaped house fills little of its bounding box; shrink the box to the real area.
      const fill = Math.sqrt(Math.min(1, area / Math.max(1, 4 * box.halfLength * box.halfWidth)));
      boxes.push(round1(box.cx), round1(box.cy), round1(box.halfLength * fill), round1(box.halfWidth * fill), Math.round(box.heading * 100) / 100, height);
      boxed += 1;
      return;
    }
    const outer = simplifyRing(polygon.outer, area > 2000 ? 0.5 : 0.35);
    if (outer.length < 3) return;
    const poly: PolygonData = { outer: flat(outer) };
    const holes = polygon.holes.map((h) => simplifyRing(h, 0.4)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 12);
    if (holes.length) poly.holes = holes.map(flat);
    const building: Building = { kind, poly, height };
    if (tags.name && area > 1500) building.name = tags.name;
    if (minHeight) building.minHeight = minHeight;
    buildings.push(building);
  };

  const isBuilding = (tags: Tags | undefined): tags is Tags => {
    if (!tags || tags.aeroway === 'terminal') return false;
    if (tags.building && tags.building !== 'no') return true;
    if (tags['building:part'] && tags['building:part'] !== 'no') return true;
    if (tags.man_made === 'storage_tank') return true;
    // Multi-storey car parks are often mapped as parking areas only.
    return tags.amenity === 'parking' && (tags.parking === 'multi-storey' || /garage/i.test(tags.name ?? ''));
  };
  for (const w of osm.ways.values()) {
    if (!isBuilding(w.tags)) continue;
    const ring = osm.wayRing(w);
    if (ring) add(w.tags, { outer: ring, holes: [] });
  }
  for (const r of osm.relations.values()) {
    if (!isBuilding(r.tags) || r.tags.type !== 'multipolygon') continue;
    for (const polygon of osm.relationPolygons(r)) add(r.tags, polygon);
  }
  buildings.sort((a, b) => a.kind.localeCompare(b.kind));
  log(`${buildings.length} as footprints, ${boxed} small ones as boxes; ${JSON.stringify(counts)}`);
  return { buildings, boxes };
}
