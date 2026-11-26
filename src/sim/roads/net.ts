// The road network vehicles drive on: one link per direction of each mapped road, with its lanes
// and the rules for which lane leads where at each junction.

import { angleDiff } from '../../shared/geo.ts';
import type { RoadClass, Roads } from '../../shared/layout.ts';
import { laneOffset } from '../../shared/road-spec.ts';

/** How lanes of one link feed one of the links after it. */
export interface Connection {
  link: number;
  /** Lanes of the upstream link that may be used to take this connection, inclusive. */
  lo: number;
  hi: number;
  /** Lane on the downstream link reached from upstream lane `lo`; later lanes follow in order. */
  base: number;
  /** Change of heading, radians, positive to the left. */
  turn: number;
}

export interface Link {
  id: number;
  edge: number;
  from: number;
  to: number;
  len: number;
  lanes: number;
  opposing: number;
  cls: RoadClass;
  /** Free-flow speed, m/s. */
  speed: number;
  name: string;
  /** x, y, z triples in the direction of travel. */
  pts: number[];
  cum: number[];
  headIn: number;
  headOut: number;
  next: Connection[];
  /** Links that feed this one. */
  prev: number[];
  /** The link runs up to a signalled junction from outside it: its end is a stop line. */
  signal: boolean;
  /** Which junction's signals those are; every stop line of one junction shares a cycle. */
  junction: number;
  /** The link ends at the edge of the mapped area. */
  exits: boolean;
  /** The link starts at the edge of the mapped area. */
  enters: boolean;
}

export interface LanePoint {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** How much of an approach's width an exit of each class of road claims, lane for lane. */
const CLASS_WEIGHT: Record<RoadClass, number> = { motorway: 4, motorway_link: 3, trunk: 3, primary: 2.5, secondary: 2, tertiary: 1.2, local: 0.5, service: 0.3, airside: 0.3 };

/** Signal heads this close together belong to one junction. */
const JUNCTION_SPAN = 45;
/** A node this close to a signal head is inside that junction. */
const JUNCTION_REACH = 22;

/**
 * Which signalled junction each node belongs to, or -1. A big junction is mapped as several
 * signal nodes, one where each carriageway crosses; they are one junction with one cycle, and
 * the short links between them are inside it.
 */
function signalJunctions(roads: Roads): Int32Array {
  const heads: number[] = [];
  roads.nodes.forEach((n, i) => {
    if (n.signal) heads.push(i);
  });
  const parent = new Map<number, number>(heads.map((h) => [h, h]));
  const find = (i: number): number => {
    let at = i;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  for (let i = 0; i < heads.length; i += 1) {
    for (let j = i + 1; j < heads.length; j += 1) {
      const a = roads.nodes[heads[i]];
      const b = roads.nodes[heads[j]];
      if (Math.hypot(a.x - b.x, a.y - b.y) <= JUNCTION_SPAN && Math.abs(a.z - b.z) < 3) parent.set(find(heads[i]), find(heads[j]));
    }
  }
  const junction = new Int32Array(roads.nodes.length).fill(-1);
  for (const h of heads) junction[h] = find(h);
  roads.nodes.forEach((n, i) => {
    if (junction[i] !== -1) return;
    for (const h of heads) {
      const s = roads.nodes[h];
      if (Math.hypot(n.x - s.x, n.y - s.y) <= JUNCTION_REACH && Math.abs(n.z - s.z) < 3) {
        junction[i] = junction[h];
        return;
      }
    }
  });
  return junction;
}

export class RoadNet {
  readonly links: Link[] = [];
  readonly nodeCount: number;
  /** Links leaving each node. */
  readonly outOf: number[][];

  constructor(roads: Roads) {
    this.nodeCount = roads.nodes.length;
    this.outOf = Array.from({ length: roads.nodes.length }, () => []);
    const degree = new Int32Array(roads.nodes.length);
    roads.edges.forEach((e) => {
      if (e.cls === 'airside') return;
      degree[e.a] += 1;
      degree[e.b] += 1;
    });
    const junction = signalJunctions(roads);
    roads.edges.forEach((e, edge) => {
      if (e.cls === 'airside') return;
      const add = (reverse: boolean): void => {
        const pts: number[] = [];
        if (reverse) for (let i = e.pts.length - 3; i >= 0; i -= 3) pts.push(e.pts[i], e.pts[i + 1], e.pts[i + 2]);
        else pts.push(...e.pts);
        const cum = [0];
        for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]));
        const n = pts.length;
        const from = reverse ? e.b : e.a;
        const to = reverse ? e.a : e.b;
        const link: Link = {
          id: this.links.length,
          edge,
          from,
          to,
          len: cum[cum.length - 1],
          lanes: reverse ? e.back : e.lanes,
          opposing: reverse ? e.lanes : e.back,
          cls: e.cls,
          speed: e.speed,
          name: e.name ?? '',
          pts,
          cum,
          headIn: Math.atan2(pts[4] - pts[1], pts[3] - pts[0]),
          headOut: Math.atan2(pts[n - 2] - pts[n - 5], pts[n - 3] - pts[n - 6]),
          next: [],
          prev: [],
          // A link that starts inside the junction it ends in is part of the junction, not a way in.
          signal: junction[to] !== -1 && junction[from] !== junction[to],
          junction: junction[to],
          exits: degree[to] === 1,
          enters: degree[from] === 1,
        };
        this.links.push(link);
        this.outOf[from].push(link.id);
      };
      add(false);
      if (e.back > 0) add(true);
    });
    this.connect();
    // A carriageway can end at a node that other roads also touch, so the ends of the network
    // are told by where a link leads, not by how many roads meet at its last node.
    for (const link of this.links) {
      link.exits = link.next.length === 0;
      link.enters = link.prev.length === 0;
    }
  }

  /** Work out, at every junction, which lanes lead into which lanes. */
  private connect(): void {
    const into: number[][] = Array.from({ length: this.nodeCount }, () => []);
    for (const link of this.links) into[link.to].push(link.id);

    // Where each incoming link lands on each outgoing link: left-hand arrivals take the left lanes.
    const landing = new Map<number, number>();
    const key = (from: number, to: number): number => from * 65536 + to;
    for (let node = 0; node < this.nodeCount; node += 1) {
      for (const outId of this.outOf[node]) {
        const out = this.links[outId];
        const feeders = into[node].map((id) => this.links[id]).filter((l) => !(l.edge === out.edge && l.id !== out.id));
        // Sorted so the feeder arriving furthest from the left comes first.
        feeders.sort((p, q) => angleDiff(out.headIn, q.headOut) - angleDiff(out.headIn, p.headOut));
        feeders.forEach((feeder, index) => {
          const width = Math.min(out.lanes, feeder.lanes);
          let base = 0;
          if (feeders.length > 1) {
            const position = index / (feeders.length - 1);
            base = Math.round(position * (out.lanes - width));
          }
          landing.set(key(feeder.id, out.id), base);
        });
      }
    }

    for (const link of this.links) {
      const outs = this.outOf[link.to].map((id) => this.links[id]).filter((o) => o.edge !== link.edge);
      // Leftmost exit first. The link's lanes are shared out among its exits in proportion to
      // their own lanes, with no lane left leading nowhere: where there are more lanes than the
      // exit has, the outer ones run together as they cross the junction.
      outs.sort((p, q) => angleDiff(q.headIn, link.headOut) - angleDiff(p.headIn, link.headOut));
      // How much of the road each exit deserves: its lanes, more for a bigger road, more again
      // for the one that carries straight on. A side street does not get a third of a freeway.
      const weights = outs.map((out) => {
        const turn = Math.abs(angleDiff(out.headIn, link.headOut));
        return out.lanes * CLASS_WEIGHT[out.cls] * (turn < 0.35 ? 2 : 1);
      });
      const total = weights.reduce((sum, w) => sum + w, 0);
      let before = 0;
      outs.forEach((out, index) => {
        // Lanes from the exit's share of the width, left to right. Shares meet inside a lane more
        // often than between two, and then both exits are taken from that lane.
        const lo = Math.min(link.lanes - 1, Math.floor((before / total) * link.lanes + 1e-9));
        before += weights[index];
        const hi = Math.max(lo, Math.min(link.lanes - 1, Math.ceil((before / total) * link.lanes - 1e-9) - 1));
        link.next.push({ link: out.id, lo, hi, base: landing.get(key(link.id, out.id)) ?? 0, turn: angleDiff(out.headIn, link.headOut) });
        out.prev.push(link.id);
      });
    }
  }

  connection(from: number, to: number): Connection | undefined {
    return this.links[from].next.find((c) => c.link === to);
  }

  /** The lane reached on the next link from `lane` of this one. */
  landingLane(connection: Connection, lane: number): number {
    const next = this.links[connection.link];
    const clamped = Math.max(connection.lo, Math.min(connection.hi, lane));
    return Math.max(0, Math.min(next.lanes - 1, connection.base + clamped - connection.lo));
  }

  /** Position of a point `s` metres along a link, in a lane (which may be fractional mid-change). */
  point(link: Link, s: number, lane: number, out: LanePoint): LanePoint {
    const d = Math.max(0, Math.min(link.len, s));
    const cum = link.cum;
    let lo = 0;
    let hi = cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const span = cum[lo + 1] - cum[lo] || 1;
    const t = (d - cum[lo]) / span;
    const i = lo * 3;
    const x0 = link.pts[i];
    const y0 = link.pts[i + 1];
    const x1 = link.pts[i + 3];
    const y1 = link.pts[i + 4];
    const heading = Math.atan2(y1 - y0, x1 - x0);
    const offset = laneOffset(link.cls, link.lanes, link.opposing, lane);
    // To the right of the direction of travel.
    out.x = x0 + (x1 - x0) * t + Math.sin(heading) * offset;
    out.y = y0 + (y1 - y0) * t - Math.cos(heading) * offset;
    out.z = link.pts[i + 2] + (link.pts[i + 5] - link.pts[i + 2]) * t;
    out.heading = heading;
    return out;
  }

  /**
   * Quickest route by free-flow time from the end of `from` to a link accepted by `goal`,
   * as the links after `from`. Null when there is none.
   */
  route(from: number, goal: (link: Link) => boolean, avoid?: (link: Link) => number): number[] | null {
    const n = this.links.length;
    const cost = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heapCost: number[] = [];
    const heapLink: number[] = [];
    const push = (c: number, l: number): void => {
      let i = heapCost.length;
      heapCost.push(c);
      heapLink.push(l);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapCost[p] <= c) break;
        heapCost[i] = heapCost[p];
        heapLink[i] = heapLink[p];
        i = p;
      }
      heapCost[i] = c;
      heapLink[i] = l;
    };
    const pop = (): number => {
      const top = heapLink[0];
      const c = heapCost.pop()!;
      const l = heapLink.pop()!;
      const size = heapCost.length;
      if (size) {
        let i = 0;
        for (;;) {
          let child = i * 2 + 1;
          if (child >= size) break;
          if (child + 1 < size && heapCost[child + 1] < heapCost[child]) child += 1;
          if (heapCost[child] >= c) break;
          heapCost[i] = heapCost[child];
          heapLink[i] = heapLink[child];
          i = child;
        }
        heapCost[i] = c;
        heapLink[i] = l;
      }
      return top;
    };
    cost[from] = 0;
    push(0, from);
    while (heapLink.length) {
      const id = pop();
      if (done[id]) continue;
      done[id] = 1;
      const link = this.links[id];
      if (id !== from && goal(link)) {
        const path: number[] = [];
        for (let at = id; at !== from && at !== -1; at = prev[at]) path.push(at);
        return path.reverse();
      }
      for (const c of link.next) {
        const next = this.links[c.link];
        // Sharp turns cost time; U-turn-like ones are for dead ends only.
        const turn = Math.abs(c.turn);
        const step = next.len / next.speed + (turn > 2.4 ? 40 : turn > 0.9 ? 6 : 0) + (next.signal ? 8 : 0) + (avoid ? avoid(next) : 0);
        const total = cost[id] + step;
        if (total < cost[c.link]) {
          cost[c.link] = total;
          prev[c.link] = id;
          push(total, c.link);
        }
      }
    }
    return null;
  }
}
