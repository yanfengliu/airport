// Roads section: the drivable network with lanes, speeds and heights above ground.

import { closestOnSegment, dist, pointInRing, polylineLength, round1, type Vec2 } from '../../src/shared/geo.ts';
import type { RoadClass, RoadEdge, RoadNode, Roads } from '../../src/shared/layout.ts';
import { buildGraph, components } from './lib/graph.ts';
import { numberTag, type OsmData, type OsmWay, type Tags } from './lib/osm.ts';

/**
 * Height above ground of an OSM layer, metres. Layers only say what is above what, so the first
 * step is the terminal's departures deck over arrivals and the upper steps are squeezed: the
 * AirTrain guideway is tagged layer 5 and really runs about 20 m up.
 */
const LAYER_UP = [0, 6.5, 11.5, 15, 17.5, 20];
export function layerHeight(layer: number): number {
  if (layer >= 0) return LAYER_UP[Math.min(layer, LAYER_UP.length - 1)];
  return -6.5 * Math.min(2, -layer);
}
/** Steepest ramp the height solver lets an approach road take. */
const MAX_GRADE = 0.055;
const MPH = 0.44704;

const CLASS_OF: Record<string, RoadClass> = {
  motorway: 'motorway',
  motorway_link: 'motorway_link',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  unclassified: 'local',
  residential: 'local',
  service: 'service',
};

const DEFAULT_SPEED_MPH: Record<RoadClass, number> = {
  motorway: 65,
  motorway_link: 40,
  trunk: 45,
  primary: 35,
  secondary: 30,
  tertiary: 30,
  local: 25,
  service: 15,
  airside: 15,
};

const DEFAULT_LANES: Record<RoadClass, number> = {
  motorway: 4,
  motorway_link: 1,
  trunk: 2,
  primary: 2,
  secondary: 1,
  tertiary: 1,
  local: 1,
  service: 1,
  airside: 1,
};

interface Attrs {
  cls: RoadClass;
  lanes: number;
  back: number;
  speed: number;
  name?: string;
  bridge: boolean;
  tunnel: boolean;
  reversed: boolean;
}

export interface HeightSolver {
  /** Height above ground of an OSM node that lies on a selected way. */
  z(nodeId: number): number;
}

/** Layer of a way that is really carried above or below ground, else 0. */
export function structureLayer(tags: Tags): number {
  const layer = Number.parseInt(tags.layer ?? '0', 10) || 0;
  const bridge = tags.bridge !== undefined && tags.bridge !== 'no';
  const tunnel = tags.tunnel === 'yes';
  if (bridge) return layer > 0 ? layer : 1;
  if (tunnel) return layer < 0 ? layer : -1;
  return 0;
}

/**
 * Heights for every node of the given ways. Nodes on a bridge or in a tunnel sit at their layer;
 * every other node follows the ground, except where it has to climb to meet a structure, which it
 * does at no more than MAX_GRADE along the way.
 */
export function solveHeights(osm: OsmData, ways: readonly OsmWay[], isAtGrade: (way: OsmWay) => boolean): HeightSolver {
  const fixed = new Map<number, number[]>();
  const adjacency = new Map<number, { to: number; len: number }[]>();
  const link = (a: number, b: number): void => {
    const len = dist(osm.xy(a), osm.xy(b));
    (adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push({ to: b, len });
    (adjacency.get(b) ?? adjacency.set(b, []).get(b)!).push({ to: a, len });
  };
  for (const way of ways) {
    const layer = isAtGrade(way) ? 0 : structureLayer(way.tags ?? {});
    for (let i = 0; i < way.nodes.length; i += 1) {
      const id = way.nodes[i];
      if (layer !== 0) (fixed.get(id) ?? fixed.set(id, []).get(id)!).push(layerHeight(layer));
      if (i > 0) link(way.nodes[i - 1], id);
    }
  }
  const height = new Map<number, number>();
  const pinned = new Set<number>();
  for (const [id, values] of fixed) {
    height.set(id, values.reduce((s, v) => s + v, 0) / values.length);
    pinned.add(id);
  }
  // Where two structures at different levels join, the deck has to slope between them: free the
  // pinned nodes within reach of such a step so the smoothing below can make the transition.
  const loose = new Set<number>();
  for (const id of pinned) {
    const z = height.get(id)!;
    const steps = (adjacency.get(id) ?? []).some((n) => pinned.has(n.to) && Math.abs(height.get(n.to)! - z) > 1);
    if (!steps) continue;
    const frontier: { id: number; left: number }[] = [{ id, left: 90 }];
    while (frontier.length) {
      const at = frontier.pop()!;
      if (loose.has(at.id) && at.left < 90) continue;
      loose.add(at.id);
      for (const n of adjacency.get(at.id) ?? []) if (pinned.has(n.to) && at.left - n.len > 0 && !loose.has(n.to)) frontier.push({ id: n.to, left: at.left - n.len });
    }
  }
  // Spread outwards from the structures, highest first, losing height with distance.
  for (const sign of [1, -1]) {
    const queue = [...pinned].filter((id) => sign * height.get(id)! > 0).map((id) => ({ id, z: sign * height.get(id)! }));
    queue.sort((a, b) => a.z - b.z);
    while (queue.length) {
      const top = queue.pop()!;
      if (sign * (height.get(top.id) ?? 0) > top.z + 1e-6) continue;
      for (const { to, len } of adjacency.get(top.id) ?? []) {
        if (pinned.has(to)) continue;
        const z = top.z - len * MAX_GRADE;
        if (z <= 0.05 || z <= sign * (height.get(to) ?? 0)) continue;
        height.set(to, sign * z);
        let at = queue.length;
        queue.push({ id: to, z });
        while (at > 0 && queue[at - 1].z > z) {
          queue[at] = queue[at - 1];
          at -= 1;
        }
        queue[at] = { id: to, z };
      }
    }
  }
  // Round off the kinks: every node that is not held at a structure's level moves towards the
  // length-weighted mean of its neighbours. Flat stretches stay flat; ramps become smooth.
  for (let pass = 0; pass < 40; pass += 1) {
    const next = new Map<number, number>();
    for (const [id, links] of adjacency) {
      if (pinned.has(id) && !loose.has(id)) continue;
      const z = height.get(id) ?? 0;
      let sum = 0;
      let weight = 0;
      let any = z !== 0;
      for (const n of links) {
        const nz = height.get(n.to) ?? 0;
        if (nz !== 0) any = true;
        const w = 1 / Math.max(2, n.len);
        sum += nz * w;
        weight += w;
      }
      if (!any || weight === 0 || links.length < 2) continue;
      next.set(id, z + (sum / weight - z) * 0.5);
    }
    for (const [id, z] of next) height.set(id, z);
  }
  return { z: (nodeId) => height.get(nodeId) ?? 0 };
}

/** Ways that cross water and nothing else are bridges in name only: the road stays at grade. */
export function atGradeBridges(osm: OsmData, candidates: readonly OsmWay[], others: readonly OsmWay[]): Set<number> {
  const water: Vec2[][] = [];
  for (const w of osm.taggedWays('waterway')) water.push(osm.wayPoints(w));
  for (const w of osm.taggedWays('natural', /^(water|coastline)$/)) water.push(osm.wayPoints(w));
  const lines = others.map((w) => ({ id: w.id, nodes: new Set(w.nodes), layer: structureLayer(w.tags ?? {}), pts: osm.wayPoints(w) }));
  const result = new Set<number>();
  for (const way of candidates) {
    const tags = way.tags ?? {};
    if (!(tags.bridge !== undefined && tags.bridge !== 'no')) continue;
    const layer = structureLayer(tags);
    if (layer > 1) continue;
    const pts = osm.wayPoints(way);
    if (!water.some((line) => crosses(pts, line))) continue;
    const overTraffic = lines.some((o) => o.id !== way.id && o.layer < layer && !way.nodes.some((n) => o.nodes.has(n)) && crosses(pts, o.pts));
    if (!overTraffic) result.add(way.id);
  }
  return result;
}

function crosses(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      if (segmentsCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

function segmentsCross(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): boolean {
  const d = (p2[0] - p[0]) * (q2[1] - q[1]) - (p2[1] - p[1]) * (q2[0] - q[0]);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((q[0] - p[0]) * (q2[1] - q[1]) - (q[1] - p[1]) * (q2[0] - q[0])) / d;
  const u = ((q[0] - p[0]) * (p2[1] - p[1]) - (q[1] - p[1]) * (p2[0] - p[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

export function aerodromeRing(osm: OsmData): Vec2[] | null {
  for (const w of osm.taggedWays('aeroway', 'aerodrome')) {
    const ring = osm.wayRing(w);
    if (ring) return ring;
  }
  return null;
}

function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) best = Math.min(best, closestOnSegment(p, ring[j], ring[i]).distance);
  return best;
}

export function buildRoads(osm: OsmData, log: (line: string) => void): Roads {
  const airport = aerodromeRing(osm);
  const selected: { way: OsmWay; attrs: Attrs }[] = [];
  let skippedService = 0;
  for (const way of osm.taggedWays('highway')) {
    const tags = way.tags!;
    let cls = CLASS_OF[tags.highway];
    if (!cls || tags.area === 'yes' || way.nodes.length < 2) continue;
    if (tags.indoor && tags.indoor !== 'no') continue;
    const pts = osm.wayPoints(way);
    if (pts.length < 2) continue;
    if (cls === 'service') {
      const mid = pts[Math.floor(pts.length / 2)];
      const inside = airport ? pointInRing(mid[0], mid[1], airport) : false;
      const nearAirport = airport ? inside || distanceToRing(mid, airport) < 120 : true;
      const restricted = tags.access === 'private' || tags.access === 'no';
      const minor = tags.service === 'parking_aisle' || tags.service === 'driveway' || tags.service === 'drive-through' || tags.service === 'alley';
      if (restricted && inside && !minor) cls = 'airside';
      else if (!restricted && nearAirport && !minor) cls = 'service';
      else if (tags.name && !restricted && !minor) cls = 'service';
      else {
        skippedService += 1;
        continue;
      }
    }
    const oneway = tags.oneway === 'yes' || tags.oneway === '-1' || tags.highway === 'motorway' || tags.junction === 'roundabout';
    const reversed = tags.oneway === '-1';
    const total = numberTag(tags, 'lanes');
    let lanes: number;
    let back: number;
    if (oneway) {
      lanes = total ?? DEFAULT_LANES[cls];
      back = 0;
    } else {
      const forward = numberTag(tags, 'lanes:forward');
      const backward = numberTag(tags, 'lanes:backward');
      if (forward !== undefined && backward !== undefined) {
        lanes = forward;
        back = backward;
      } else if (total !== undefined && total >= 2) {
        lanes = Math.ceil(total / 2);
        back = Math.floor(total / 2);
      } else {
        lanes = DEFAULT_LANES[cls];
        back = DEFAULT_LANES[cls];
      }
    }
    const mph = /^(\d+)\s*mph$/.exec(tags.maxspeed ?? '')?.[1];
    const speed = (mph ? Number(mph) : DEFAULT_SPEED_MPH[cls]) * MPH;
    const name = tags.ref && cls.startsWith('motorway') ? tags.ref.split(';')[0] : tags.name;
    selected.push({
      way,
      attrs: {
        cls,
        lanes: Math.max(1, Math.min(7, Math.round(lanes))),
        back: Math.max(0, Math.min(4, Math.round(back))),
        speed: Math.round(speed * 10) / 10,
        name,
        bridge: tags.bridge !== undefined && tags.bridge !== 'no',
        tunnel: tags.tunnel === 'yes',
        reversed,
      },
    });
  }

  const ways = selected.map((s) => s.way);
  const railWays = [...osm.taggedWays('railway', /^(rail|light_rail|subway|monorail|tram|narrow_gauge)$/)];
  const flatBridges = atGradeBridges(osm, ways, [...ways, ...railWays]);
  const heights = solveHeights(osm, ways, (w) => flatBridges.has(w.id));

  const signals = new Set<number>();
  for (const n of osm.taggedNodes('highway', 'traffic_signals')) signals.add(n.id);
  const raw = buildGraph(selected, signals);
  const comp = components(raw.nodeIds.length, raw.edges);

  // Keep the main network and any separate piece long enough to matter (airside loops).
  const lengthOf = new Map<number, number>();
  for (const e of raw.edges) {
    const len = polylineLength(e.osmNodes.map((id) => osm.xy(id)));
    lengthOf.set(comp.label[e.a], (lengthOf.get(comp.label[e.a]) ?? 0) + len);
  }
  const keepComponent = (label: number): boolean => label === comp.largest || (lengthOf.get(label) ?? 0) > 400;

  const nodeIndex = new Map<number, number>();
  const nodes: RoadNode[] = [];
  const nodeFor = (rawIndex: number): number => {
    let index = nodeIndex.get(rawIndex);
    if (index === undefined) {
      const id = raw.nodeIds[rawIndex];
      const p = osm.xy(id);
      index = nodes.length;
      const node: RoadNode = { x: round1(p[0]), y: round1(p[1]), z: round1(heights.z(id)) };
      if (signals.has(id)) node.signal = 1;
      nodes.push(node);
      nodeIndex.set(rawIndex, index);
    }
    return index;
  };

  const edges: RoadEdge[] = [];
  const perClass: Record<string, number> = {};
  for (const e of raw.edges) {
    if (!keepComponent(comp.label[e.a])) continue;
    const ids = e.attrs.reversed ? [...e.osmNodes].reverse() : e.osmNodes;
    const pts3 = simplify3(ids.map((id) => [...osm.xy(id), heights.z(id)] as [number, number, number]), 0.4);
    const len = polylineLength(pts3.map((p) => [p[0], p[1]] as Vec2));
    if (len < 0.5) continue;
    const a = nodeFor(e.attrs.reversed ? e.b : e.a);
    const b = nodeFor(e.attrs.reversed ? e.a : e.b);
    const edge: RoadEdge = {
      a,
      b,
      pts: pts3.flatMap((p) => [round1(p[0]), round1(p[1]), round1(p[2])]),
      len: round1(len),
      cls: e.attrs.cls,
      lanes: e.attrs.lanes,
      back: e.attrs.back,
      speed: e.attrs.speed,
    };
    if (e.attrs.name) edge.name = e.attrs.name;
    if (e.attrs.bridge && !flatBridges.has(e.wayId)) edge.bridge = 1;
    if (e.attrs.tunnel) edge.tunnel = 1;
    edges.push(edge);
    perClass[edge.cls] = (perClass[edge.cls] ?? 0) + len;
  }
  log(`${selected.length} ways selected (${skippedService} minor or private service ways left out), ${flatBridges.size} bridges kept at grade over water`);
  log(`graph: ${nodes.length} nodes (${nodes.filter((n) => n.signal).length} signals), ${edges.length} edges, ${comp.count} components before pruning`);
  log(`km by class: ${JSON.stringify(Object.fromEntries(Object.entries(perClass).map(([k, v]) => [k, +(v / 1000).toFixed(1)])))}`);
  log(`highest node ${Math.max(...nodes.map((n) => n.z))} m, lowest ${Math.min(...nodes.map((n) => n.z))} m`);
  return { nodes, edges };
}

/** Douglas-Peucker on the plan view that also keeps points where the height profile bends. */
export function simplify3(points: readonly [number, number, number][], tolerance: number): [number, number, number][] {
  if (points.length <= 2) return points.map((p) => [...p] as [number, number, number]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    const a = points[first];
    const b = points[last];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    for (let i = first + 1; i < last; i += 1) {
      const p = points[i];
      const plan = closestOnSegment([p[0], p[1]], [a[0], a[1]], [b[0], b[1]]);
      const zLine = a[2] + (b[2] - a[2]) * Math.min(1, Math.hypot(p[0] - a[0], p[1] - a[1]) / span);
      const d = Math.max(plan.distance, Math.abs(p[2] - zLine) * 1.5);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: [number, number, number][] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push([...points[i]] as [number, number, number]);
  return out;
}
