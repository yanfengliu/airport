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
/** Ways that meet within this distance along them are one junction where they come close, not one over the other. */
const JUNCTION_REACH = 200;
/** The furthest a clearance moves a way from its own level, in metres. */
const MOVE_MOST = 4;
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
 * What one way passing over another needs: within `near` metres of each other in plan they are one
 * above the other, and the upper must then be at least `height` metres above the lower.
 */
export interface Clearance {
  near: number;
  height: number;
}

/**
 * Heights for every node of the given ways. Nodes on a bridge or in a tunnel sit at their layer;
 * every other node follows the ground, except where it has to climb to meet a structure, which it
 * does at no more than MAX_GRADE along the way. With a `clearance`, wherever a way passes over or
 * under another without meeting it, too close above it, the lower one is held down (or, if it
 * cannot go lower, the upper one up) and the heights are worked out again.
 */
export function solveHeights(osm: OsmData, ways: readonly OsmWay[], isAtGrade: (way: OsmWay) => boolean, clearance?: Clearance, log?: (line: string) => void): HeightSolver {
  const fixed = new Map<number, number[]>();
  const adjacency = new Map<number, { to: number; len: number }[]>();
  const link = (a: number, b: number): void => {
    const len = dist(osm.xy(a), osm.xy(b));
    (adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push({ to: b, len });
    (adjacency.get(b) ?? adjacency.set(b, []).get(b)!).push({ to: a, len });
  };
  const layers = new Map<number, number>();
  for (const way of ways) {
    const layer = isAtGrade(way) ? 0 : structureLayer(way.tags ?? {});
    layers.set(way.id, layer);
    for (let i = 0; i < way.nodes.length; i += 1) {
      const id = way.nodes[i];
      if (layer !== 0) (fixed.get(id) ?? fixed.set(id, []).get(id)!).push(layerHeight(layer));
      if (i > 0) link(way.nodes[i - 1], id);
    }
  }
  // Nodes held down under a way above, and held up over one below; down wins where both are asked.
  const ceilings = new Map<number, number>();
  const floors = new Map<number, number>();
  const held = new Map<number, number>();
  let height = heightsFrom(fixed, held, adjacency);
  if (!clearance) return { z: (nodeId) => height.get(nodeId) ?? 0 };
  for (let round = 0; round < 6; round += 1) {
    const found = clearanceConflicts(osm, ways, layers, height, clearance, adjacency);
    if (!found.length) break;
    for (const { node, z } of found) {
      if (z < (height.get(node) ?? 0)) ceilings.set(node, Math.min(ceilings.get(node) ?? Infinity, z));
      else floors.set(node, Math.max(floors.get(node) ?? -Infinity, z));
    }
    held.clear();
    for (const [node, z] of floors) held.set(node, z);
    for (const [node, z] of ceilings) held.set(node, z);
    log?.(`clearance: round ${round + 1}, ${found.length} nodes moved`);
    height = heightsFrom(fixed, held, adjacency);
  }
  const details: string[] = [];
  clearanceConflicts(osm, ways, layers, height, clearance, adjacency, details);
  if (details.length) log?.(`clearance: ${details.length} places still too close: ${details.slice(0, 12).join('; ')}`);
  return { z: (nodeId) => height.get(nodeId) ?? 0 };
}

/**
 * Nodes to move so that ways one above the other clear each other: for each pair of segments of
 * different ways, at different levels and sharing no node, that come within `near` of each other
 * in plan, the ends of the lower one at the height it must not rise above, or, where that would be
 * underground, the ends of the upper one at the height it must reach.
 */
function clearanceConflicts(osm: OsmData, ways: readonly OsmWay[], layers: ReadonlyMap<number, number>, height: ReadonlyMap<number, number>, clearance: Clearance, adjacency: ReadonlyMap<number, { to: number; len: number }[]>, details?: string[]): { node: number; z: number }[] {
  const nameOf = new Map(ways.map((w) => [w.id, w.tags?.name ?? w.tags?.highway ?? w.tags?.railway ?? '?']));
  /** Whether two nodes are joined along the ways within `reach` metres: then they are one junction, not one way over another. */
  const joined = (from: number, goals: readonly number[], reach: number): boolean => {
    const best = new Map<number, number>([[from, 0]]);
    const open: { id: number; d: number }[] = [{ id: from, d: 0 }];
    while (open.length) {
      let k = 0;
      for (let i = 1; i < open.length; i += 1) if (open[i].d < open[k].d) k = i;
      const at = open.splice(k, 1)[0];
      if (goals.includes(at.id)) return true;
      for (const n of adjacency.get(at.id) ?? []) {
        const d = at.d + n.len;
        if (d > reach || d >= (best.get(n.to) ?? Infinity)) continue;
        best.set(n.to, d);
        open.push({ id: n.to, d });
      }
    }
    return false;
  };
  const CELL = 25;
  const segments: { way: number; a: number; b: number; pa: Vec2; pb: Vec2 }[] = [];
  const grid = new Map<string, number[]>();
  for (const way of ways) {
    const nodes = way.nodes.filter((id) => osm.hasNode(id));
    for (let i = 1; i < nodes.length; i += 1) {
      const pa = osm.xy(nodes[i - 1]);
      const pb = osm.xy(nodes[i]);
      const index = segments.length;
      segments.push({ way: way.id, a: nodes[i - 1], b: nodes[i], pa, pb });
      const x0 = Math.floor((Math.min(pa[0], pb[0]) - clearance.near) / CELL);
      const x1 = Math.floor((Math.max(pa[0], pb[0]) + clearance.near) / CELL);
      const y0 = Math.floor((Math.min(pa[1], pb[1]) - clearance.near) / CELL);
      const y1 = Math.floor((Math.max(pa[1], pb[1]) + clearance.near) / CELL);
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const key = `${x},${y}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(index);
        }
      }
    }
  }
  const z = (id: number): number => height.get(id) ?? 0;
  const moves = new Map<number, number>();
  const move = (node: number, to: number, down: boolean): void => {
    const was = moves.get(node);
    moves.set(node, was === undefined ? to : down ? Math.min(was, to) : Math.max(was, to));
  };
  const seen = new Set<string>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const p = segments[list[i]];
        const q = segments[list[j]];
        if (p.way === q.way || p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
        const key = list[i] < list[j] ? `${list[i]}:${list[j]}` : `${list[j]}:${list[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const near = closestBetween(p.pa, p.pb, q.pa, q.pb);
        if (near.distance > clearance.near) continue;
        const zp = z(p.a) + (z(p.b) - z(p.a)) * near.s;
        const zq = z(q.a) + (z(q.b) - z(q.a)) * near.t;
        const lp = layers.get(p.way) ?? 0;
        const lq = layers.get(q.way) ?? 0;
        // Ways on one level side by side, or meeting where the map has no junction, are not stacked.
        if (lp === lq && Math.abs(zp - zq) < 0.3) continue;
        if (Math.abs(zp - zq) >= clearance.height - 0.05) continue;
        if (joined(p.a, [q.a, q.b], JUNCTION_REACH)) continue;
        // The way on the higher layer is the upper one; on one layer, the higher one now.
        const pUpper = lp !== lq ? lp > lq : zp > zq;
        const [upper, lower, zu, zl] = pUpper ? [p, q, zp, zq] : [q, p, zq, zp];
        const ceiling = zu - clearance.height;
        const floor = zl + clearance.height;
        // A way is moved at most MOVE_MOST from its own level, and a road at grade never below the
        // ground: moved further, it drags the ways it joins after it.
        const layerLower = layers.get(lower.way) ?? 0;
        const layerUpper = layers.get(upper.way) ?? 0;
        const lowest = layerLower === 0 ? 0 : layerHeight(layerLower) - MOVE_MOST;
        const highest = layerHeight(layerUpper) + MOVE_MOST;
        if (ceiling >= lowest) {
          for (const n of [lower.a, lower.b]) if (z(n) > ceiling) move(n, ceiling, true);
        } else if (floor <= highest) {
          for (const n of [upper.a, upper.b]) if (z(n) < floor) move(n, floor, false);
        } else {
          details?.push(`${nameOf.get(upper.way)} (layer ${layerUpper}, ${zu.toFixed(1)} m) over ${nameOf.get(lower.way)} (layer ${layerLower}, ${zl.toFixed(1)} m) ${near.distance.toFixed(1)} m apart at (${(p.pa[0] + (p.pb[0] - p.pa[0]) * near.s).toFixed(0)},${(p.pa[1] + (p.pb[1] - p.pa[1]) * near.s).toFixed(0)})`);
          continue;
        }
        details?.push(`${nameOf.get(upper.way)} (layer ${layerUpper}, ${zu.toFixed(1)} m) over ${nameOf.get(lower.way)} (layer ${layerLower}, ${zl.toFixed(1)} m) ${near.distance.toFixed(1)} m apart at (${(p.pa[0] + (p.pb[0] - p.pa[0]) * near.s).toFixed(0)},${(p.pa[1] + (p.pb[1] - p.pa[1]) * near.s).toFixed(0)})`);
      }
    }
  }
  return [...moves].map(([node, to]) => ({ node, z: to }));
}

/** The closest points of two segments in plan: how far apart, and how far along each, 0 to 1. */
function closestBetween(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): { distance: number; s: number; t: number } {
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const vx = q1[0] - q0[0];
  const vy = q1[1] - q0[1];
  const wx = p0[0] - q0[0];
  const wy = p0[1] - q0[1];
  const a = ux * ux + uy * uy;
  const b = ux * vx + uy * vy;
  const c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy;
  const e = vx * wx + vy * wy;
  const denom = a * c - b * b;
  let s = denom > 1e-9 ? Math.max(0, Math.min(1, (b * e - c * d) / denom)) : 0;
  let t = c > 1e-9 ? (b * s + e) / c : 0;
  if (t < 0) {
    t = 0;
    s = a > 1e-9 ? Math.max(0, Math.min(1, -d / a)) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 1e-9 ? Math.max(0, Math.min(1, (b - d) / a)) : 0;
  }
  const dx = wx + s * ux - t * vx;
  const dy = wy + s * uy - t * vy;
  return { distance: Math.hypot(dx, dy), s, t };
}

/** Heights from the structures' levels, with `held` nodes kept where the clearances put them. */
function heightsFrom(fixed: ReadonlyMap<number, number[]>, held: ReadonlyMap<number, number>, adjacency: ReadonlyMap<number, { to: number; len: number }[]>): Map<number, number> {
  const height = new Map<number, number>();
  const pinned = new Set<number>();
  for (const [id, values] of fixed) {
    height.set(id, values.reduce((s, v) => s + v, 0) / values.length);
    pinned.add(id);
  }
  for (const [id, z] of held) {
    height.set(id, z);
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
    const visited = new Set<number>();
    while (frontier.length) {
      const at = frontier.pop()!;
      if ((loose.has(at.id) && at.left < 90) || visited.has(at.id)) continue;
      visited.add(at.id);
      // A node held for a clearance stays where it was put; the decks either side of it give.
      if (!held.has(at.id)) loose.add(at.id);
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
  return height;
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
  // A deck over a road clears the traffic on it: five metres road surface to road surface, the
  // step between the upper layers, leaves 3.7 m under a deck drawn 1.3 m thick. Centrelines within
  // 4 m of each other in plan are one over the other.
  const heights = solveHeights(osm, ways, (w) => flatBridges.has(w.id), { near: 4, height: 5 }, log);

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
