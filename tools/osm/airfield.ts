// Airfield section: runways, the taxi graph aircraft move on, and the stands they park at.

import {
  angleDiff, closestOnSegment, compassDeg, dist, heading, polylineLength, ringCentroid, round1, simplify, type Vec2,
} from '../../src/shared/geo.ts';
import type { Airfield, Apron, Flat, Runway, RunwayEnd, Stand, TaxiEdge, TaxiEdgeKind, TaxiNode } from '../../src/shared/layout.ts';
import { buildGraph, components } from './lib/graph.ts';
import { numberTag, type OsmData, type OsmNode, type OsmWay } from './lib/osm.ts';

/** SFO's magnetic variation, degrees east: runway numbers are magnetic, the geometry is true. */
const MAG_VAR = 13;
/** Wingtip clearance between neighbouring stands, metres. */
const STAND_CLEARANCE = 7.5;

interface WorkNode {
  p: Vec2;
  hold: boolean;
  rwy: Set<string>;
}

interface WorkEdge {
  a: number;
  b: number;
  pts: Vec2[];
  kind: TaxiEdgeKind;
  ref?: string;
  rwy?: string;
  wayId: number;
}

export const flat = (points: readonly Vec2[]): Flat => points.flatMap((p) => [round1(p[0]), round1(p[1])]);

export function buildAirfield(osm: OsmData, log: (line: string) => void): Airfield {
  // ---- the movement graph ---------------------------------------------------------------
  const sources: { way: OsmWay; attrs: { kind: TaxiEdgeKind; ref?: string; rwy?: string } }[] = [];
  for (const way of osm.taggedWays('aeroway', /^(runway|taxiway|taxilane|parking_position)$/)) {
    const tag = way.tags!.aeroway;
    if (tag === 'runway') sources.push({ way, attrs: { kind: 'rwy', rwy: way.tags!.ref } });
    else if (tag === 'parking_position') sources.push({ way, attrs: { kind: 'stand', ref: way.tags!.ref } });
    else sources.push({ way, attrs: { kind: 'twy', ref: way.tags!.ref } });
  }
  const used = new Set<number>();
  for (const { way } of sources) for (const id of way.nodes) used.add(id);

  const holdIds = new Set<number>();
  for (const n of osm.taggedNodes('aeroway', 'holding_position')) if (used.has(n.id)) holdIds.add(n.id);
  for (const w of osm.taggedWays('aeroway', 'holding_position')) for (const id of w.nodes) if (used.has(id)) holdIds.add(id);

  const raw = buildGraph(sources, holdIds);
  const nodes: WorkNode[] = raw.nodeIds.map((id) => ({ p: osm.xy(id), hold: holdIds.has(id), rwy: new Set<string>() }));
  let edges: WorkEdge[] = raw.edges.map((e) => ({
    a: e.a,
    b: e.b,
    pts: e.osmNodes.map((id) => osm.xy(id)),
    kind: e.attrs.kind,
    ref: e.attrs.ref,
    rwy: e.attrs.rwy,
    wayId: e.wayId,
  }));
  for (const e of edges) {
    if (e.kind !== 'rwy' || !e.rwy) continue;
    nodes[e.a].rwy.add(e.rwy);
    nodes[e.b].rwy.add(e.rwy);
  }
  // A hold bar painted on the runway itself is not somewhere to wait.
  for (const n of nodes) if (n.rwy.size) n.hold = false;

  // ---- stands -------------------------------------------------------------------------
  const gateNodes = new Map<string, OsmNode>();
  for (const g of osm.taggedNodes('aeroway', 'gate')) if (g.tags!.ref) gateNodes.set(g.tags!.ref, g);

  const taxiVertices: Vec2[] = [];
  for (const { way, attrs } of sources) if (attrs.kind === 'twy') taxiVertices.push(...osm.wayPoints(way));
  const nearestTaxiVertex = (p: Vec2): number => {
    let best = Infinity;
    for (const v of taxiVertices) best = Math.min(best, dist(p, v));
    return best;
  };
  const degree = new Int32Array(nodes.length);
  for (const e of edges) {
    degree[e.a] += 1;
    degree[e.b] += 1;
  }

  interface Candidate {
    ref?: string;
    noseNode: number;
    entryNode: number;
    line: Vec2[];
    gateDistance: number;
  }
  const candidates: Candidate[] = [];
  for (const { way, attrs } of sources) {
    if (attrs.kind !== 'stand') continue;
    const pts = osm.wayPoints(way);
    if (pts.length < 2 || polylineLength(pts) < 8) continue;
    const first = raw.indexOf.get(way.nodes[0])!;
    const last = raw.indexOf.get(way.nodes[way.nodes.length - 1])!;
    const gate = attrs.ref ? gateNodes.get(attrs.ref) : undefined;
    let noseIsLast: boolean;
    let gateDistance = Infinity;
    if (gate) {
      const g = osm.xy(gate.id);
      noseIsLast = dist(pts[pts.length - 1], g) < dist(pts[0], g);
      gateDistance = Math.min(dist(pts[0], g), dist(pts[pts.length - 1], g));
    } else if ((degree[first] > 1) !== (degree[last] > 1)) {
      noseIsLast = degree[first] > 1;
    } else {
      noseIsLast = nearestTaxiVertex(pts[pts.length - 1]) > nearestTaxiVertex(pts[0]);
    }
    const line = noseIsLast ? pts : [...pts].reverse();
    candidates.push({ ref: attrs.ref, noseNode: noseIsLast ? last : first, entryNode: noseIsLast ? first : last, line, gateDistance });
  }
  // One stand per gate number (the line that ends nearest the gate), and one per nose point.
  candidates.sort((p, q) => p.gateDistance - q.gateDistance);
  const seenRef = new Set<string>();
  const seenNose = new Set<number>();
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (c.ref && seenRef.has(c.ref)) continue;
    if (seenNose.has(c.noseNode)) continue;
    // A nose point that other taxi lines run through is a junction, not a stand.
    if (degree[c.noseNode] > 1 && !c.ref) continue;
    if (c.ref) seenRef.add(c.ref);
    seenNose.add(c.noseNode);
    chosen.push(c);
  }

  // ---- join stands that were drawn without a link to the taxiways ---------------------------
  const splitEdge = (edgeIndex: number, segment: number, point: Vec2): number => {
    const e = edges[edgeIndex];
    const nodeIndex = nodes.length;
    nodes.push({ p: point, hold: false, rwy: new Set(e.kind === 'rwy' && e.rwy ? [e.rwy] : []) });
    const head = [...e.pts.slice(0, segment + 1), point];
    const tail = [point, ...e.pts.slice(segment + 1)];
    edges[edgeIndex] = { ...e, b: nodeIndex, pts: head };
    edges.push({ ...e, a: nodeIndex, pts: tail });
    return nodeIndex;
  };
  let comp = components(nodes.length, edges);
  let joined = 0;
  let dropped = 0;
  const kept: Candidate[] = [];
  for (const c of chosen) {
    if (comp.label[c.noseNode] === comp.largest) {
      kept.push(c);
      continue;
    }
    // Walk back from the tail of the stand line, along its own direction, to the first taxiway.
    const tailPoint = c.line[0];
    const back = heading(c.line[Math.min(1, c.line.length - 1)], tailPoint);
    const reach = 320;
    const far: Vec2 = [tailPoint[0] + Math.cos(back) * reach, tailPoint[1] + Math.sin(back) * reach];
    let hit: { edge: number; segment: number; point: Vec2; along: number } | null = null;
    let near: { edge: number; segment: number; point: Vec2; distance: number } | null = null;
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      if (e.kind !== 'twy' || comp.label[e.a] !== comp.largest) continue;
      for (let s = 1; s < e.pts.length; s += 1) {
        const x = segmentIntersection(tailPoint, far, e.pts[s - 1], e.pts[s]);
        if (x && (!hit || x.t < hit.along)) hit = { edge: i, segment: s - 1, point: x.point, along: x.t };
        const c2 = closestOnSegment(tailPoint, e.pts[s - 1], e.pts[s]);
        if (!near || c2.distance < near.distance) near = { edge: i, segment: s - 1, point: c2.point, distance: c2.distance };
      }
    }
    const target = hit ?? (near && near.distance < 260 ? near : null);
    if (!target) {
      dropped += 1;
      continue;
    }
    const junction = splitEdge(target.edge, target.segment, target.point);
    edges.push({ a: junction, b: c.entryNode, pts: [target.point, tailPoint], kind: 'stand', ref: c.ref, wayId: -1 });
    joined += 1;
    kept.push(c);
    comp = components(nodes.length, edges);
  }
  log(`stands: ${candidates.length} parking lines, ${chosen.length} distinct, ${joined} joined to the taxiways by a synthesized lead-in, ${dropped} dropped as unreachable`);

  // ---- keep only what is connected to the runways -------------------------------------------
  comp = components(nodes.length, edges);
  const keepNode = new Int32Array(nodes.length).fill(-1);
  const outNodes: WorkNode[] = [];
  edges = edges.filter((e) => comp.label[e.a] === comp.largest);
  for (const e of edges) {
    for (const end of [e.a, e.b]) {
      if (keepNode[end] === -1) {
        keepNode[end] = outNodes.length;
        outNodes.push(nodes[end]);
      }
    }
  }
  for (const e of edges) {
    e.a = keepNode[e.a];
    e.b = keepNode[e.b];
    e.pts = simplify(e.pts, 0.15);
  }

  // ---- runways --------------------------------------------------------------------------
  const runways = buildRunways(osm);
  for (const r of runways) log(`runway ${r.id}: ${r.length} m, ${r.ends[0].name} displaced ${r.ends[0].displaced} m, ${r.ends[1].name} displaced ${r.ends[1].displaced} m`);

  // ---- stand details ----------------------------------------------------------------------
  const bridgesByRef = new Map<string, Vec2[][]>();
  for (const w of osm.taggedWays('aeroway', 'jet_bridge')) {
    const ref = w.tags!.ref ?? /^([A-G]\d+[A-Z]?) Jetway$/.exec(w.tags!.name ?? '')?.[1];
    if (!ref) continue;
    const list = bridgesByRef.get(ref) ?? [];
    list.push(osm.wayPoints(w));
    bridgesByRef.set(ref, list);
  }
  const stands: Stand[] = [];
  let remote = 0;
  for (const c of kept) {
    const nose = c.line[c.line.length - 1];
    const total = polylineLength(c.line);
    const from = pointAlong(c.line, Math.max(0, total - 14));
    const h = heading(from, nose);
    const gate = c.ref ? gateNodes.get(c.ref) : undefined;
    const stand: Stand = {
      id: c.ref ?? `R${(remote += 1)}`,
      area: c.ref ? c.ref[0] : 'remote',
      contact: Boolean(gate),
      x: round1(nose[0]),
      y: round1(nose[1]),
      heading: Math.round(h * 1000) / 1000,
      node: keepNode[c.noseNode],
      span: 0,
    };
    if (gate) {
      const g = osm.xy(gate.id);
      stand.door = [round1(g[0]), round1(g[1])];
      const bridges = bridgesByRef.get(c.ref!);
      if (bridges?.length) {
        // Each bridge runs from the terminal out to the aircraft; the longest is the main one.
        const oriented = bridges
          .map((b) => (dist(b[0], nose) < dist(b[b.length - 1], nose) ? [...b].reverse() : b))
          .sort((p, q) => polylineLength(q) - polylineLength(p));
        stand.bridge = flat(oriented[0]);
      }
    }
    stands.push(stand);
  }
  assignSpans(stands);
  stands.sort((p, q) => p.id.localeCompare(q.id, 'en', { numeric: true }));
  const bySize = { narrow: 0, mid: 0, wide: 0, super: 0 };
  for (const s of stands) bySize[s.span >= 79 ? 'super' : s.span >= 60 ? 'wide' : s.span >= 45 ? 'mid' : 'narrow'] += 1;
  log(`stands kept: ${stands.length} (${stands.filter((s) => s.contact).length} contact gates, ${remote} remote); by span ${JSON.stringify(bySize)}`);

  // ---- areas ----------------------------------------------------------------------------
  const aprons: Apron[] = [];
  for (const w of osm.taggedWays('aeroway', 'apron')) {
    const ring = osm.wayRing(w);
    if (ring) aprons.push({ name: w.tags!.name, poly: { outer: flat(ring) } });
  }
  const stopways: Flat[] = [];
  for (const w of osm.taggedWays('aeroway', 'stopway')) {
    const ring = osm.wayRing(w);
    stopways.push(flat(ring ?? osm.wayPoints(w)));
  }
  const helipads: [number, number][] = [];
  for (const w of osm.taggedWays('aeroway', 'helipad')) {
    const c = ringCentroid(osm.wayPoints(w));
    helipads.push([round1(c[0]), round1(c[1])]);
  }
  let tower: [number, number] = [0, 0];
  for (const w of osm.taggedWays('aeroway', 'tower')) {
    const c = ringCentroid(osm.wayPoints(w));
    tower = [round1(c[0]), round1(c[1])];
  }

  const taxiNodes: TaxiNode[] = outNodes.map((n) => {
    const node: TaxiNode = { x: round1(n.p[0]), y: round1(n.p[1]) };
    if (n.hold) node.hold = 1;
    if (n.rwy.size) node.rwy = [...n.rwy].sort();
    return node;
  });
  const taxiEdges: TaxiEdge[] = edges.map((e) => {
    const edge: TaxiEdge = { a: e.a, b: e.b, pts: flat(e.pts), len: round1(polylineLength(e.pts)), kind: e.kind };
    if (e.ref && e.kind === 'twy') edge.ref = e.ref;
    if (e.rwy) edge.rwy = e.rwy;
    return edge;
  });
  const total = (kind: TaxiEdgeKind): number => Math.round(taxiEdges.filter((e) => e.kind === kind).reduce((s, e) => s + e.len, 0));
  log(`taxi graph: ${taxiNodes.length} nodes (${taxiNodes.filter((n) => n.hold).length} holds), ${taxiEdges.length} edges; ${total('rwy')} m runway, ${total('twy')} m taxiway, ${total('stand')} m stand lead-in`);

  return { runways, nodes: taxiNodes, edges: taxiEdges, stands, aprons, stopways, helipads, tower };
}

function buildRunways(osm: OsmData): Runway[] {
  const groups = new Map<string, OsmWay[]>();
  for (const w of osm.taggedWays('aeroway', 'runway')) {
    const ref = w.tags!.ref;
    if (!ref) continue;
    const list = groups.get(ref) ?? [];
    list.push(w);
    groups.set(ref, list);
  }
  const runways: Runway[] = [];
  for (const [id, ways] of groups) {
    const points = ways.flatMap((w) => osm.wayPoints(w));
    let p0 = points[0];
    let p1 = points[0];
    let best = -1;
    for (const a of points) {
      for (const b of points) {
        const d = dist(a, b);
        if (d > best) {
          best = d;
          p0 = a;
          p1 = b;
        }
      }
    }
    const displacedAt = (end: Vec2): number => {
      let sum = 0;
      for (const w of ways) {
        if (w.tags!.runway !== 'displaced_threshold') continue;
        const pts = osm.wayPoints(w);
        const mid = pointAlong(pts, polylineLength(pts) / 2);
        if (dist(mid, end) < best / 2) sum += polylineLength(pts);
      }
      return Math.round(sum);
    };
    const names = id.split('/');
    const endFor = (from: Vec2, to: Vec2): RunwayEnd => {
      const magnetic = (compassDeg(heading(from, to)) - MAG_VAR + 360) % 360;
      const name = names
        .map((n) => ({ n, off: Math.abs(angleDiff((Number.parseInt(n, 10) * 10 * Math.PI) / 180, (magnetic * Math.PI) / 180)) }))
        .sort((p, q) => p.off - q.off)[0].n;
      return { name, x: round1(from[0]), y: round1(from[1]), displaced: displacedAt(from) };
    };
    const width = numberTag(ways[0].tags, 'width') ?? 61;
    runways.push({ id, width, length: round1(best), ends: [endFor(p0, p1), endFor(p1, p0)] });
  }
  return runways.sort((a, b) => a.id.localeCompare(b.id));
}

/** The widest wingspan each stand takes, from how far its neighbours' centrelines are. */
function assignSpans(stands: Stand[]): void {
  for (const s of stands) {
    let gap = Infinity;
    const ux = Math.cos(s.heading);
    const uy = Math.sin(s.heading);
    for (const o of stands) {
      if (o === s) continue;
      const dx = o.x - s.x;
      const dy = o.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 140) continue;
      if (Math.abs(angleDiff(o.heading, s.heading)) > 0.9) continue;
      const along = dx * ux + dy * uy;
      const across = Math.abs(-dx * uy + dy * ux);
      if (Math.abs(along) > 70 || across < 12) continue;
      gap = Math.min(gap, across);
    }
    const fit = gap === Infinity ? 65 : gap - STAND_CLEARANCE;
    s.span = Math.max(28, Math.min(80, Math.round(fit)));
  }
}

function pointAlong(points: readonly Vec2[], s: number): Vec2 {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i += 1) {
    const len = dist(points[i - 1], points[i]);
    if (remaining <= len || i === points.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, remaining / len);
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
    remaining -= len;
  }
  return points[0];
}

function segmentIntersection(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): { point: Vec2; t: number } | null {
  const rx = p2[0] - p[0];
  const ry = p2[1] - p[1];
  const sx = q2[0] - q[0];
  const sy = q2[1] - q[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / denom;
  const u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: [p[0] + rx * t, p[1] + ry * t], t };
}
