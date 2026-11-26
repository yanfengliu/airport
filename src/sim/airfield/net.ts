// The taxi network aircraft move on: the layout's taxi graph cut into short blocks, with the
// rules for getting from one block to the next and a router over them.
//
// A block is at most BLOCK_MAX metres of centreline between two nodes. An arc is a block taken in
// one direction: arc = block * 2 for a→b, block * 2 + 1 for b→a. Routes are lists of arcs.

import { angleDiff } from '../../shared/geo.ts';
import type { Airfield, Runway, RunwayEnd, Stand, TaxiEdgeKind } from '../../shared/layout.ts';
import { TileGrid } from './tiles.ts';

const BLOCK_MAX = 85;
const BLOCK_TARGET = 60;
/** Sharpest change of direction an aircraft makes from one block to the next, radians. */
export const MAX_TURN = 1.9;

export interface NetNode {
  x: number;
  y: number;
  hold: boolean;
  /** Runways whose centreline passes through this node. */
  rwy: string[];
  /** Blocks that meet here. */
  blocks: number[];
  /** Stand whose stop point this is. */
  stand?: string;
}

export interface Block {
  id: number;
  a: number;
  b: number;
  /** x, y pairs from a to b. */
  pts: number[];
  /** Distance from a at each point. */
  cum: number[];
  len: number;
  kind: TaxiEdgeKind;
  ref?: string;
  rwy?: string;
  /** Taxi speed limit on this block, m/s. */
  speed: number;
  /** Direction of travel at a going to b, and at b arriving from a, radians. */
  headA: number;
  headB: number;
}

export interface RunwayEndInfo {
  runway: Runway;
  end: RunwayEnd;
  other: RunwayEnd;
  /** Unit vector along the runway, from this end towards the other. */
  ux: number;
  uy: number;
  heading: number;
  /** Nodes on the centreline with their distance from this end's pavement edge, nearest first. */
  nodes: { node: number; along: number }[];
}

export interface RunwayExit {
  node: number;
  /** Distance from the landing threshold. */
  along: number;
  /** First arc off the runway. */
  arc: number;
  /** Angle turned to leave the runway, radians; small for a high-speed exit. */
  angle: number;
  /** Fastest speed at which the turn-off can be taken, m/s. */
  speed: number;
  /** Which side of the landing direction the exit leaves on: +1 left, -1 right. */
  side: 1 | -1;
}

export interface StandLine {
  /** The node where the line leaves the taxiway. */
  junction: number;
  /** Arcs from the junction to the stop point, in the order an arriving aircraft takes them. */
  arcsIn: number[];
  blocks: Set<number>;
  length: number;
}

export interface RouteOptions {
  /** Blocks that may not be used. */
  forbid?: ReadonlySet<number>;
  /** Arcs that may not be used: a block can be shut one way and open the other. */
  closed?: (arc: number) => boolean;
  /** Extra seconds of cost for using an arc, for one-way preferences. */
  arcCost?: (arc: number) => number;
  /** Let the route run along runway centrelines. */
  allowRunway?: boolean;
  /** Stand whose own line the route may use; no route uses any other stand's. */
  stand?: string;
}

export class TaxiNet {
  readonly nodes: NetNode[] = [];
  readonly blocks: Block[] = [];
  readonly stands = new Map<string, Stand>();
  readonly standNode = new Map<string, number>();
  readonly runwayEnds = new Map<string, RunwayEndInfo>();
  /** The ground as tiles, for keeping aircraft apart. */
  readonly grid: TileGrid;
  /** Arcs leaving each node. */
  private readonly out: number[][] = [];
  private readonly lines = new Map<string, StandLine | null>();

  constructor(airfield: Airfield) {
    for (const n of airfield.nodes) this.nodes.push({ x: n.x, y: n.y, hold: Boolean(n.hold), rwy: n.rwy ? [...n.rwy] : [], blocks: [] });
    for (const e of airfield.edges) {
      const pieces = e.len > BLOCK_MAX ? Math.ceil(e.len / BLOCK_TARGET) : 1;
      const cut = splitPolyline(e.pts, pieces);
      let from = e.a;
      for (let i = 0; i < cut.length; i += 1) {
        const pts = cut[i];
        let to = e.b;
        if (i < cut.length - 1) {
          to = this.nodes.length;
          this.nodes.push({ x: pts[pts.length - 2], y: pts[pts.length - 1], hold: false, rwy: e.kind === 'rwy' && e.rwy ? [e.rwy] : [], blocks: [] });
        }
        this.addBlock(from, to, pts, e.kind, e.ref, e.rwy);
        from = to;
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    this.grid = new TileGrid(minX, minY, maxX, maxY);
    for (let n = 0; n < this.nodes.length; n += 1) this.out.push([]);
    for (const b of this.blocks) {
      this.out[b.a].push(b.id * 2);
      this.out[b.b].push(b.id * 2 + 1);
    }
    for (const s of airfield.stands) {
      this.stands.set(s.id, s);
      this.standNode.set(s.id, s.node);
      this.nodes[s.node].stand = s.id;
    }
    for (const runway of airfield.runways) {
      for (const [end, other] of [[runway.ends[0], runway.ends[1]], [runway.ends[1], runway.ends[0]]] as const) {
        const ux = (other.x - end.x) / runway.length;
        const uy = (other.y - end.y) / runway.length;
        const nodes: { node: number; along: number }[] = [];
        this.nodes.forEach((n, index) => {
          if (!n.rwy.includes(runway.id)) return;
          const along = (n.x - end.x) * ux + (n.y - end.y) * uy;
          const across = Math.abs(-(n.x - end.x) * uy + (n.y - end.y) * ux);
          if (across < 12) nodes.push({ node: index, along });
        });
        nodes.sort((p, q) => p.along - q.along);
        this.runwayEnds.set(end.name, { runway, end, other, ux, uy, heading: Math.atan2(uy, ux), nodes });
      }
    }
  }

  private addBlock(a: number, b: number, pts: number[], kind: TaxiEdgeKind, ref: string | undefined, rwy: string | undefined): void {
    const cum = [0];
    let turned = 0;
    let previous: number | null = null;
    for (let i = 2; i < pts.length; i += 2) {
      const dx = pts[i] - pts[i - 2];
      const dy = pts[i + 1] - pts[i - 1];
      cum.push(cum[cum.length - 1] + Math.hypot(dx, dy));
      const h = Math.atan2(dy, dx);
      if (previous !== null) turned += Math.abs(angleDiff(h, previous));
      previous = h;
    }
    const len = cum[cum.length - 1];
    const n = pts.length;
    const limit = kind === 'stand' ? 6 : kind === 'rwy' ? 20 : 15;
    // A bend limits speed: keep sideways acceleration near 1 m/s².
    const radius = turned > 0.05 ? len / turned : Infinity;
    const speed = Math.max(4, Math.min(limit, Math.sqrt(radius)));
    const block: Block = {
      id: this.blocks.length,
      a,
      b,
      pts,
      cum,
      len,
      kind,
      speed,
      headA: Math.atan2(pts[3] - pts[1], pts[2] - pts[0]),
      headB: Math.atan2(pts[n - 1] - pts[n - 3], pts[n - 2] - pts[n - 4]),
    };
    if (ref) block.ref = ref;
    if (rwy) block.rwy = rwy;
    this.blocks.push(block);
    this.nodes[a].blocks.push(block.id);
    this.nodes[b].blocks.push(block.id);
  }

  // ---- arcs -----------------------------------------------------------------------------

  arcBlock(arc: number): Block {
    return this.blocks[arc >> 1];
  }

  arcFrom(arc: number): number {
    const b = this.blocks[arc >> 1];
    return arc & 1 ? b.b : b.a;
  }

  arcTo(arc: number): number {
    const b = this.blocks[arc >> 1];
    return arc & 1 ? b.a : b.b;
  }

  /** Direction of travel at the start and at the end of an arc. */
  arcStartHeading(arc: number): number {
    const b = this.blocks[arc >> 1];
    return arc & 1 ? b.headB + Math.PI : b.headA;
  }

  arcEndHeading(arc: number): number {
    const b = this.blocks[arc >> 1];
    return arc & 1 ? b.headA + Math.PI : b.headB;
  }

  arcsFrom(node: number): readonly number[] {
    return this.out[node];
  }

  /** Change of direction going from one arc into the next, radians, 0 for straight on. */
  turn(from: number, to: number): number {
    return Math.abs(angleDiff(this.arcStartHeading(to), this.arcEndHeading(from)));
  }

  /** x, y pairs of an arc in its direction of travel. */
  arcPoints(arc: number): number[] {
    const pts = this.blocks[arc >> 1].pts;
    if (!(arc & 1)) return pts;
    const out: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
    return out;
  }

  // ---- routing --------------------------------------------------------------------------

  /**
   * The quickest route from where `startArcs` end to `goal`, never reversing and never turning
   * more sharply than an aircraft can. `startArcs` are arcs already taken (the route continues
   * from the end of one of them); the result lists the arcs after it, and which start was used.
   */
  route(startArcs: readonly number[], goal: number | ((node: number, arc: number) => boolean), options: RouteOptions = {}): { start: number; arcs: number[]; seconds: number } | null {
    const arcCount = this.blocks.length * 2;
    const best = new Float64Array(arcCount).fill(Infinity);
    const cameFrom = new Int32Array(arcCount).fill(-1);
    const origin = new Int32Array(arcCount).fill(-1);
    const isGoal = typeof goal === 'number' ? (node: number): boolean => node === goal : goal;
    const goalNode = typeof goal === 'number' ? this.nodes[goal] : null;
    const estimate = (node: number): number => (goalNode ? Math.hypot(this.nodes[node].x - goalNode.x, this.nodes[node].y - goalNode.y) / 15 : 0);
    const ownLine = options.stand ? this.standLine(options.stand)?.blocks : undefined;

    // A small binary heap of [priority, arc].
    const heapPriority: number[] = [];
    const heapArc: number[] = [];
    const push = (priority: number, arc: number): void => {
      let i = heapPriority.length;
      heapPriority.push(priority);
      heapArc.push(arc);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapPriority[parent] <= priority) break;
        heapPriority[i] = heapPriority[parent];
        heapArc[i] = heapArc[parent];
        i = parent;
      }
      heapPriority[i] = priority;
      heapArc[i] = arc;
    };
    const pop = (): number => {
      const top = heapArc[0];
      const priority = heapPriority.pop()!;
      const arc = heapArc.pop()!;
      const n = heapPriority.length;
      if (n > 0) {
        let i = 0;
        for (;;) {
          let child = i * 2 + 1;
          if (child >= n) break;
          if (child + 1 < n && heapPriority[child + 1] < heapPriority[child]) child += 1;
          if (heapPriority[child] >= priority) break;
          heapPriority[i] = heapPriority[child];
          heapArc[i] = heapArc[child];
          i = child;
        }
        heapPriority[i] = priority;
        heapArc[i] = arc;
      }
      return top;
    };

    const relax = (from: number, cost: number, start: number): void => {
      const node = this.arcTo(from);
      for (const next of this.out[node]) {
        if ((next ^ 1) === from) continue;
        const block = this.blocks[next >> 1];
        if (options.forbid?.has(block.id) || options.closed?.(next)) continue;
        if (block.kind === 'rwy' && !options.allowRunway) continue;
        const angle = this.turn(from, next);
        if (angle > MAX_TURN) continue;
        // A stand's line is for reaching or leaving that stand, never a way through the apron.
        if (block.kind === 'stand' && !(ownLine && ownLine.has(block.id))) continue;
        let step = block.len / block.speed + angle * angle * 5;
        if (options.arcCost) step += options.arcCost(next);
        const total = cost + step;
        if (total < best[next]) {
          best[next] = total;
          cameFrom[next] = from;
          origin[next] = start;
          push(total + estimate(this.arcTo(next)), next);
        }
      }
    };

    // The arcs already taken cost nothing and are never re-entered, so no route loops back
    // through its own start.
    for (const start of startArcs) best[start] = 0;
    for (const start of startArcs) {
      if (isGoal(this.arcTo(start), start)) return { start, arcs: [], seconds: 0 };
      relax(start, 0, start);
    }
    const starts = new Set(startArcs);
    while (heapArc.length) {
      const arc = pop();
      const node = this.arcTo(arc);
      if (isGoal(node, arc)) {
        const arcs: number[] = [];
        let at = arc;
        while (at !== -1 && !starts.has(at)) {
          arcs.push(at);
          at = cameFrom[at];
        }
        arcs.reverse();
        return { start: origin[arc], arcs, seconds: best[arc] };
      }
      // A stand's stop point is a dead end for everyone else.
      const stand = this.nodes[node].stand;
      if (stand && stand !== options.stand) continue;
      relax(arc, best[arc], origin[arc]);
    }
    return null;
  }

  /**
   * A stand's own line: the shortest way along stand lines from a taxiway to its stop point. Null
   * for a stand whose line reaches no taxiway.
   */
  standLine(id: string): StandLine | null {
    const known = this.lines.get(id);
    if (known !== undefined) return known;
    const start = this.standNode.get(id);
    let line: StandLine | null = null;
    if (start !== undefined) {
      const best = new Map<number, { length: number; arcs: number[] }>([[start, { length: 0, arcs: [] }]]);
      const open = [start];
      while (open.length) {
        open.sort((a, b) => best.get(a)!.length - best.get(b)!.length);
        const node = open.shift()!;
        const here = best.get(node)!;
        if (this.out[node].some((arc) => this.blocks[arc >> 1].kind === 'twy')) {
          // Found walking away from the stop point; an aircraft arriving takes it the other way.
          line = { junction: node, arcsIn: here.arcs.map((arc) => arc ^ 1).reverse(), blocks: new Set(here.arcs.map((arc) => arc >> 1)), length: here.length };
          break;
        }
        for (const arc of this.out[node]) {
          const block = this.blocks[arc >> 1];
          const to = this.arcTo(arc);
          if (block.kind !== 'stand' || this.nodes[to].stand) continue;
          const length = here.length + block.len;
          if (length >= (best.get(to)?.length ?? Infinity)) continue;
          best.set(to, { length, arcs: [...here.arcs, arc] });
          if (!open.includes(to)) open.push(to);
        }
      }
    }
    this.lines.set(id, line);
    return line;
  }

  /**
   * May a route go from one arc straight into the next? The same rules as `route`, without costs
   * and without any stand's line, which only the aircraft bound for that stand may use.
   */
  private follows(from: number, next: number, allowRunway: boolean): boolean {
    if ((next ^ 1) === from) return false;
    const kind = this.blocks[next >> 1].kind;
    if (kind === 'stand' || (kind === 'rwy' && !allowRunway)) return false;
    // Nobody taxis through a stand's stop point.
    if (this.nodes[this.arcTo(from)].stand) return false;
    return this.turn(from, next) <= MAX_TURN;
  }

  /** Every arc a route starting on one of `starts` can come to use; 1 where it can. */
  reachableFrom(starts: readonly number[], allowRunway = false): Uint8Array {
    const seen = new Uint8Array(this.blocks.length * 2);
    const queue: number[] = [];
    for (const arc of starts) {
      if (!seen[arc]) {
        seen[arc] = 1;
        queue.push(arc);
      }
    }
    for (let i = 0; i < queue.length; i += 1) {
      const from = queue[i];
      for (const next of this.out[this.arcTo(from)]) {
        if (seen[next] || !this.follows(from, next, allowRunway)) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    return seen;
  }

  /** Every arc from which a route can come to use one of `goals`; 1 where it can. */
  reaching(goals: readonly number[], allowRunway = false): Uint8Array {
    const seen = new Uint8Array(this.blocks.length * 2);
    const queue: number[] = [];
    for (const arc of goals) {
      if (!seen[arc]) {
        seen[arc] = 1;
        queue.push(arc);
      }
    }
    for (let i = 0; i < queue.length; i += 1) {
      const next = queue[i];
      // Arcs that arrive where `next` starts are the reverses of the arcs that leave there.
      for (const leaving of this.out[this.arcFrom(next)]) {
        const from = leaving ^ 1;
        if (seen[from] || !this.follows(from, next, allowRunway)) continue;
        seen[from] = 1;
        queue.push(from);
      }
    }
    return seen;
  }

  /** Arcs that leave a node roughly along a heading; used to start a route from a pose. */
  arcsLeaving(node: number, heading: number, tolerance = MAX_TURN): number[] {
    return this.out[node].filter((arc) => Math.abs(angleDiff(this.arcStartHeading(arc), heading)) <= tolerance);
  }

  // ---- runways --------------------------------------------------------------------------

  /** Where an aircraft landing from `endName` can leave the runway, nearest the threshold first. */
  exits(endName: string): RunwayExit[] {
    const info = this.runwayEnds.get(endName);
    if (!info) return [];
    const exits: RunwayExit[] = [];
    for (const { node, along } of info.nodes) {
      for (const arc of this.out[node]) {
        const block = this.blocks[arc >> 1];
        if (block.kind !== 'twy') continue;
        const leave = this.arcStartHeading(arc);
        const angle = Math.abs(angleDiff(leave, info.heading));
        if (angle > 1.75) continue;
        const side = angleDiff(leave, info.heading) > 0 ? 1 : -1;
        exits.push({ node, along: along - info.end.displaced, arc, angle, speed: angle < 0.75 ? 22 : angle < 1.2 ? 13 : 8, side });
      }
    }
    return exits;
  }

  /**
   * Nodes from which a departure can line up on `endName`: where a taxiway meets the runway
   * within `within` metres of the start of its pavement.
   */
  lineUpNodes(endName: string, within = 320): { node: number; along: number }[] {
    const info = this.runwayEnds.get(endName);
    if (!info) return [];
    return info.nodes.filter(({ node, along }) => along <= within && this.out[node].some((arc) => this.blocks[arc >> 1].kind === 'twy'));
  }

  /** Position and direction of travel at a distance along an arc. */
  pointOnArc(arc: number, s: number): { x: number; y: number; heading: number } {
    const block = this.blocks[arc >> 1];
    const reversed = Boolean(arc & 1);
    const d = Math.max(0, Math.min(block.len, reversed ? block.len - s : s));
    const cum = block.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i += 1;
    const span = cum[i] - cum[i - 1] || 1;
    const t = (d - cum[i - 1]) / span;
    const x0 = block.pts[(i - 1) * 2];
    const y0 = block.pts[(i - 1) * 2 + 1];
    const x1 = block.pts[i * 2];
    const y1 = block.pts[i * 2 + 1];
    const heading = Math.atan2(y1 - y0, x1 - x0) + (reversed ? Math.PI : 0);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, heading };
  }
}

/** Cut a polyline (x, y pairs) into `pieces` parts of equal length. */
function splitPolyline(pts: readonly number[], pieces: number): number[][] {
  if (pieces <= 1) return [[...pts]];
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  const total = cum[cum.length - 1];
  const out: number[][] = [];
  let current: number[] = [pts[0], pts[1]];
  let piece = 1;
  for (let i = 1; i < cum.length; i += 1) {
    while (piece < pieces && cum[i] >= (total * piece) / pieces) {
      const target = (total * piece) / pieces;
      const span = cum[i] - cum[i - 1] || 1;
      const t = (target - cum[i - 1]) / span;
      const x = pts[(i - 1) * 2] + (pts[i * 2] - pts[(i - 1) * 2]) * t;
      const y = pts[(i - 1) * 2 + 1] + (pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]) * t;
      const rx = Math.round(x * 10) / 10;
      const ry = Math.round(y * 10) / 10;
      const lastX = current[current.length - 2];
      const lastY = current[current.length - 1];
      if (Math.hypot(rx - lastX, ry - lastY) > 0.05) current.push(rx, ry);
      out.push(current);
      current = [rx, ry];
      piece += 1;
    }
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    if (Math.hypot(x - current[current.length - 2], y - current[current.length - 1]) > 0.05) current.push(x, y);
  }
  if (current.length >= 4) out.push(current);
  else if (out.length) out[out.length - 1].push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
