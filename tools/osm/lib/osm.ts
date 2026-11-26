// Reading raw Overpass JSON: an index of nodes, ways and relations, projected to local metres.

import { readFileSync } from 'node:fs';
import { project, ringArea, type Vec2 } from '../../../src/shared/geo.ts';

export type Tags = Record<string, string>;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Tags;
}

export interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmMember[];
  tags?: Tags;
}

type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface Polygon {
  outer: Vec2[];
  holes: Vec2[][];
}

export class OsmData {
  readonly nodes = new Map<number, OsmNode>();
  readonly ways = new Map<number, OsmWay>();
  readonly relations = new Map<number, OsmRelation>();
  osmBase = '';
  private readonly projected = new Map<number, Vec2>();

  /** Later files add to earlier ones; an element seen with tags keeps them over a bare copy. */
  load(path: string): this {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { elements: OsmElement[]; osm3s?: { timestamp_osm_base?: string } };
    const base = json.osm3s?.timestamp_osm_base ?? '';
    if (base > this.osmBase) this.osmBase = base;
    for (const el of json.elements) {
      const store = (el.type === 'node' ? this.nodes : el.type === 'way' ? this.ways : this.relations) as Map<number, OsmElement>;
      const seen = store.get(el.id);
      if (!seen || (!seen.tags && el.tags)) store.set(el.id, el);
    }
    return this;
  }

  xy(nodeId: number): Vec2 {
    let p = this.projected.get(nodeId);
    if (!p) {
      const n = this.nodes.get(nodeId);
      if (!n) throw new Error(`node ${nodeId} is referenced and missing from the extract`);
      p = project(n.lat, n.lon);
      this.projected.set(nodeId, p);
    }
    return p;
  }

  hasNode(nodeId: number): boolean {
    return this.nodes.has(nodeId);
  }

  wayPoints(way: OsmWay): Vec2[] {
    return way.nodes.filter((id) => this.nodes.has(id)).map((id) => this.xy(id));
  }

  isClosed(way: OsmWay): boolean {
    return way.nodes.length >= 4 && way.nodes[0] === way.nodes[way.nodes.length - 1];
  }

  *taggedWays(key: string, value?: string | RegExp): Generator<OsmWay> {
    for (const w of this.ways.values()) {
      const v = w.tags?.[key];
      if (v === undefined) continue;
      if (value === undefined || (typeof value === 'string' ? v === value : value.test(v))) yield w;
    }
  }

  *taggedNodes(key: string, value?: string | RegExp): Generator<OsmNode> {
    for (const n of this.nodes.values()) {
      const v = n.tags?.[key];
      if (v === undefined) continue;
      if (value === undefined || (typeof value === 'string' ? v === value : value.test(v))) yield n;
    }
  }

  *taggedRelations(key: string, value?: string | RegExp): Generator<OsmRelation> {
    for (const r of this.relations.values()) {
      const v = r.tags?.[key];
      if (v === undefined) continue;
      if (value === undefined || (typeof value === 'string' ? v === value : value.test(v))) yield r;
    }
  }

  /** A closed way as a polygon ring without the repeated last point, counter-clockwise. */
  wayRing(way: OsmWay): Vec2[] | null {
    if (!this.isClosed(way)) return null;
    const pts = this.wayPoints(way);
    pts.pop();
    if (pts.length < 3) return null;
    return ringArea(pts) < 0 ? pts.reverse() : pts;
  }

  /** Multipolygon relation → polygons, each outer ring with the inner rings that fall inside it. */
  relationPolygons(rel: OsmRelation): Polygon[] {
    const collect = (role: string): Vec2[][] => {
      const segments: number[][] = [];
      for (const m of rel.members) {
        if (m.type !== 'way') continue;
        const isInner = m.role === 'inner';
        if ((role === 'inner') !== isInner) continue;
        const way = this.ways.get(m.ref);
        if (way && way.nodes.every((id) => this.nodes.has(id))) segments.push([...way.nodes]);
      }
      const rings: Vec2[][] = [];
      while (segments.length) {
        const ring = segments.pop()!;
        let grew = true;
        while (ring[0] !== ring[ring.length - 1] && grew) {
          grew = false;
          for (let i = 0; i < segments.length; i += 1) {
            const s = segments[i];
            const tail = ring[ring.length - 1];
            if (s[0] === tail) ring.push(...s.slice(1));
            else if (s[s.length - 1] === tail) ring.push(...s.slice(0, -1).reverse());
            else continue;
            segments.splice(i, 1);
            grew = true;
            break;
          }
        }
        if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) {
          const pts = ring.slice(0, -1).map((id) => this.xy(id));
          rings.push(ringArea(pts) < 0 ? pts.reverse() : pts);
        }
      }
      return rings;
    };
    const outers = collect('outer');
    const inners = collect('inner');
    const polygons: Polygon[] = outers.map((outer) => ({ outer, holes: [] }));
    for (const inner of inners) {
      const probe = inner[0];
      const host = polygons.find((p) => insideRing(probe, p.outer));
      if (host) host.holes.push(inner);
    }
    return polygons;
  }
}

function insideRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function numberTag(tags: Tags | undefined, key: string): number | undefined {
  const raw = tags?.[key];
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}
