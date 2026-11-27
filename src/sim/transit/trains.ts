// Trains on fixed routes: the AirTrain's loops, BART in and out of its terminus, Caltrain passing
// through. A route is a line with stops along it; a train runs along the line, slows for each
// stop, opens its doors for a while and moves on.

import { CONFIG } from '../config.ts';

export interface Stop {
  name: string;
  /** Distance along the route. */
  s: number;
  /** Seconds the doors stay open. */
  dwell: number;
  /** The line doubles back here, at the end of a spur: the train leaves the way it came. */
  reverses?: boolean;
}

export interface TransitRoute {
  id: string;
  kind: 'airtrain' | 'bart' | 'caltrain';
  /** x, y, z triples. */
  pts: number[];
  cum: number[];
  total: number;
  /** A loop is run round and round; otherwise trains run to the end and come back. */
  loop: boolean;
  stops: Stop[];
  /** Top speed, m/s. */
  speed: number;
  cars: number;
  /** A car's length, coupled to the next, and the width of its body, metres. */
  carLength: number;
  width: number;
}

export interface Train {
  id: number;
  route: number;
  /** Distance of the front of the train along the route, and its speed. */
  s: number;
  v: number;
  /** Where the front was a step ago, for drawing between steps. */
  ps: number;
  /** +1 running out along the route, -1 running back. */
  direction: 1 | -1;
  /** Index of the stop it is heading for or standing at. */
  target: number;
  /** Simulation time until which it stands with doors open; negative when moving. */
  doorsUntil: number;
  /** People aboard. */
  load: number;
  /** While away past the end of a route: when it comes back. */
  awayUntil: number;
  /** Blocks of shared track it is in, or has been cleared into. */
  blocks: number[];
}

const ACCEL = 0.9;
const BRAKE = 0.9;

/**
 * Track shared by two routes, or by one route twice (out and back along one line), is worked as
 * a block: one train in it at a time, others waiting short of it. Routes are compared every
 * SAMPLE metres by the body of a car standing there as it is drawn, a box its length and width
 * pointing along the track; they share track wherever such a body on one comes within the passing
 * clearance of one on the other, level. Two trains passing there would be inside each other: on
 * the stretch out to Long Term Parking, mapped as two tracks about two metres apart, and where
 * Caltrain's two tracks are mapped little more than a car's width apart, so that the ends of a
 * car on a bend reach across.
 */
const SAMPLE = 4;
/** Tracks closer than this in height are level with each other. */
const LEVEL = 3;
/** Points of one route this far apart along it are different places on it, not the same one. */
const SELF_APART = 60;
/** A block reaches this far past where the bodies first and last touch, for the gaps between the samples. */
const BLOCK_PAD = 8;
/**
 * Two stretches of blocks on one route closer than this, or than the train's own length with the
 * room it stands short of a block and a pad, are one block. A train cannot wait between them: it
 * would still be in the one behind it, and with a train the other way waiting in the one ahead,
 * each would wait for the other for ever.
 */
const BLOCK_JOIN = 100;
/** Where a train waits for a block, short of it. */
const BLOCK_STAND = 10;

/** A stretch of a route that lies in a block, from `from` to `to` along it. */
interface BlockSpan {
  from: number;
  to: number;
  block: number;
}

/** A car's body seen from above: its middle, the way it points, and half its length and width. */
interface Body {
  x: number;
  y: number;
  z: number;
  cos: number;
  sin: number;
  halfLength: number;
  halfWidth: number;
}

/** How far two bodies seen from above are inside each other, metres: above zero where they overlap. */
function overlap(a: Body, b: Body): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let least = Infinity;
  // Two boxes are clear of each other exactly when, measured along one of the four ways their
  // sides face, they do not meet; the least they meet by along those four is how far in they are.
  for (const [ux, uy] of [[a.cos, a.sin], [-a.sin, a.cos], [b.cos, b.sin], [-b.sin, b.cos]]) {
    const ra = a.halfLength * Math.abs(a.cos * ux + a.sin * uy) + a.halfWidth * Math.abs(a.cos * uy - a.sin * ux);
    const rb = b.halfLength * Math.abs(b.cos * ux + b.sin * uy) + b.halfWidth * Math.abs(b.cos * uy - b.sin * ux);
    least = Math.min(least, ra + rb - Math.abs(dx * ux + dy * uy));
  }
  return least;
}

export function makeRoute(id: string, kind: TransitRoute['kind'], pts: number[], loop: boolean, stops: Stop[], speed: number, cars: number): TransitRoute {
  const cum = [0];
  for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]));
  const { length: carLength, width } = CONFIG.transit.cars[kind];
  const route: TransitRoute = { id, kind, pts, cum, total: cum[cum.length - 1], loop, stops: [...stops].sort((a, b) => a.s - b.s), speed, cars, carLength, width };
  // Where the line turns right round at a stop, the train goes back out along the track it came in on.
  const where = { x: 0, y: 0, z: 0, heading: 0 };
  const at = (s: number): [number, number] => {
    pointOn(route, s, where);
    return [where.x, where.y];
  };
  for (const stop of route.stops) {
    if (!loop) continue;
    const [ax, ay] = at(stop.s - REVERSE_LOOK);
    const [bx, by] = at(stop.s);
    const [cx, cy] = at(stop.s + REVERSE_LOOK);
    const turn = Math.atan2(cy - by, cx - bx) - Math.atan2(by - ay, bx - ax);
    if (Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > 2.6) stop.reverses = true;
  }
  return route;
}

/** How far either side of a stop the line is looked at to see whether it doubles back there, metres. */
const REVERSE_LOOK = 8;

/**
 * A point `s` along a route, which on a loop may be past its length or short of its start, and
 * the heading of the track there: a car whose middle is there is drawn pointing that way.
 */
function pointOn(route: TransitRoute, s: number, out: { x: number; y: number; z: number; heading: number }): void {
  const d = route.loop ? ((s % route.total) + route.total) % route.total : Math.max(0, Math.min(route.total, s));
  const cum = route.cum;
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const t = (d - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
  const i = lo * 3;
  out.x = route.pts[i] + (route.pts[i + 3] - route.pts[i]) * t;
  out.y = route.pts[i + 1] + (route.pts[i + 4] - route.pts[i + 1]) * t;
  out.z = route.pts[i + 2] + (route.pts[i + 5] - route.pts[i + 2]) * t;
  out.heading = Math.atan2(route.pts[i + 4] - route.pts[i + 1], route.pts[i + 3] - route.pts[i]);
}

/** Distance along a route (x, y, z triples) of the point nearest to (x, y). */
export function locate(pts: readonly number[], x: number, y: number): { s: number; distance: number } {
  let best = { s: 0, distance: Infinity };
  let run = 0;
  for (let i = 3; i < pts.length; i += 3) {
    const ax = pts[i - 3];
    const ay = pts[i - 2];
    const dx = pts[i] - ax;
    const dy = pts[i + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    if (d < best.distance) best = { s: run + len * t, distance: d };
    run += len;
  }
  return best;
}

export class Transit {
  readonly routes: TransitRoute[] = [];
  readonly trains: Train[] = [];
  /** Called when a train's doors open at a stop, and just before they close. */
  onDoorsOpen: ((train: Train, route: TransitRoute, stop: Stop) => void) | null = null;
  onDoorsClose: ((train: Train, route: TransitRoute, stop: Stop) => void) | null = null;
  private nextId = 1;
  /** Per route, the stretches of it that are blocks of shared track, in order along it. */
  private spans: BlockSpan[][] = [];
  /** Per block, the trains in it or cleared into it. */
  private holders: Set<number>[] = [];

  addRoute(route: TransitRoute): number {
    this.routes.push(route);
    this.spans.push([]);
    return this.routes.length - 1;
  }

  /** How many blocks of shared track there are; for the tests. */
  get blockCount(): number {
    return this.holders.length;
  }

  /** A number that changes if anything about the trains does; for the determinism test. */
  checksum(): number {
    let h = 2166136261;
    for (const t of this.trains) {
      h ^= (t.id * 31 + Math.round(t.s * 4) * 7 + (t.doorsUntil >= 0 ? 1 : 0) + t.load * 13) | 0;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Find where routes share track, with one another or with themselves, and make each such place
   * a block. Called once every route is on.
   */
  findSharedTrack(): void {
    const samples: { r: number; s: number; body: Body; reach: number }[] = [];
    const point = { x: 0, y: 0, z: 0, heading: 0 };
    const firstOf: number[] = [];
    // Each body is grown by half the clearance, so two that overlap come closer than the clearance.
    const grow = CONFIG.transit.passingClearance / 2;
    let widest = 0;
    this.routes.forEach((route, r) => {
      firstOf.push(samples.length);
      const halfLength = route.carLength / 2 + grow;
      const halfWidth = route.width / 2 + grow;
      const reach = Math.hypot(halfLength, halfWidth);
      widest = Math.max(widest, reach);
      for (let s = 0; s <= route.total; s += SAMPLE) {
        pointOn(route, s, point);
        samples.push({ r, s, reach, body: { x: point.x, y: point.y, z: point.z, cos: Math.cos(point.heading), sin: Math.sin(point.heading), halfLength, halfWidth } });
      }
    });
    firstOf.push(samples.length);
    const parent = samples.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const shared = new Uint8Array(samples.length);
    // Cells as wide as the middles of two bodies can be apart and the bodies still touch, so that
    // only the neighbouring cells need looking at.
    const CELL = 2 * widest;
    const grid = new Map<string, number[]>();
    samples.forEach(({ body }, i) => {
      const key = `${Math.floor(body.x / CELL)},${Math.floor(body.y / CELL)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    });
    samples.forEach((p, i) => {
      const cx = Math.floor(p.body.x / CELL);
      const cy = Math.floor(p.body.y / CELL);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i) continue;
            const q = samples[j];
            if (Math.abs(p.body.z - q.body.z) > LEVEL || Math.hypot(p.body.x - q.body.x, p.body.y - q.body.y) > p.reach + q.reach) continue;
            if (overlap(p.body, q.body) <= 0) continue;
            if (p.r === q.r) {
              const route = this.routes[p.r];
              let apart = Math.abs(p.s - q.s);
              if (route.loop) apart = Math.min(apart, route.total - apart);
              if (apart < SELF_APART) continue;
            }
            shared[i] = 1;
            shared[j] = 1;
            union(i, j);
          }
        }
      }
    });
    // Each unbroken run of shared track along a route is one stretch of one block.
    const runs: { r: number; from: number; to: number; sample: number }[] = [];
    this.routes.forEach((route, r) => {
      const lo = firstOf[r];
      const n = firstOf[r + 1] - lo;
      // On a loop, start counting where the track is not shared, so no run is cut in two.
      let start = 0;
      if (route.loop) while (start < n && shared[lo + start]) start += 1;
      if (start === n) start = 0;
      let run: { r: number; from: number; to: number; sample: number } | null = null;
      for (let k = 0; k < n; k += 1) {
        const i = lo + ((start + k) % n);
        if (!shared[i]) {
          run = null;
          continue;
        }
        if (run) {
          union(run.sample, i);
          // Past the join of a loop, distances along it carry on from its length.
          run.to = samples[i].s < run.from ? samples[i].s + route.total : samples[i].s;
        } else {
          run = { r, from: samples[i].s, to: samples[i].s, sample: i };
          runs.push(run);
        }
      }
    });
    const blockOf = new Map<number, number>();
    for (const run of runs) {
      const root = find(run.sample);
      if (!blockOf.has(root)) blockOf.set(root, blockOf.size);
      const route = this.routes[run.r];
      const block = blockOf.get(root)!;
      let from = run.from - BLOCK_PAD;
      let to = run.to + BLOCK_PAD;
      const spans = this.spans[run.r];
      if (!route.loop) {
        // Beyond the ends of a line that runs off the map nobody sees the trains: the block starts at the edge.
        from = Math.max(0, from);
        to = Math.min(route.total, to);
        spans.push({ from, to, block });
      } else if (from < 0) {
        spans.push({ from: from + route.total, to: route.total, block }, { from: 0, to, block });
      } else if (to > route.total) {
        spans.push({ from, to: route.total, block }, { from: 0, to: to - route.total, block });
      } else spans.push({ from, to, block });
    }
    // Stretches close together on one route are one block, whichever blocks they were: there is no
    // room to wait between them.
    const into = [...blockOf.values()];
    const top = (b: number): number => {
      while (into[b] !== b) b = into[b] = into[into[b]];
      return b;
    };
    const unite = (a: number, b: number): void => {
      const ra = top(a);
      const rb = top(b);
      if (ra !== rb) into[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const join = this.routes.map((route) => Math.max(BLOCK_JOIN, route.cars * route.carLength + BLOCK_STAND + BLOCK_PAD));
    for (let r = 0; r < this.spans.length; r += 1) {
      const spans = this.spans[r].sort((a, b) => a.from - b.from);
      let end = -Infinity;
      for (let k = 0; k < spans.length; k += 1) {
        if (k > 0 && spans[k].from - end < join[r]) unite(spans[k - 1].block, spans[k].block);
        end = Math.max(end, spans[k].to);
      }
      // Round the join of a loop, the last stretch is followed by the first.
      if (this.routes[r].loop && spans.length > 1 && spans[0].from + this.routes[r].total - end < join[r]) unite(spans[0].block, spans[spans.length - 1].block);
    }
    const numbered = new Map<number, number>();
    for (const spans of this.spans) {
      for (const span of spans) {
        const root = top(span.block);
        if (!numbered.has(root)) numbered.set(root, numbered.size);
        span.block = numbered.get(root)!;
      }
    }
    for (let r = 0; r < this.spans.length; r += 1) {
      const joined: BlockSpan[] = [];
      for (const span of this.spans[r]) {
        const last = joined[joined.length - 1];
        if (last && last.block === span.block && span.from - last.to < join[r]) last.to = Math.max(last.to, span.to);
        else joined.push({ ...span });
      }
      this.spans[r] = joined;
    }
    this.holders = [...numbered.keys()].map(() => new Set<number>());
  }

  /** Whether any of a train's body lies in a stretch of a block. */
  private bodyIn(route: TransitRoute, train: Train, span: BlockSpan): boolean {
    const length = route.cars * route.carLength;
    const a = train.direction === 1 ? train.s - length : train.s;
    const b = train.direction === 1 ? train.s : train.s + length;
    if (!route.loop) return b > span.from && a < span.to;
    for (const shift of [-route.total, 0, route.total]) if (b > span.from + shift && a < span.to + shift) return true;
    return false;
  }

  /**
   * Keep a train's hold on the blocks it is in, let go of those it has left, and clear it into
   * the next one ahead if that is free and it is first in line for it. Returns how far it may run
   * before a block it may not enter yet. `leader` is the gap to the next train ahead on its route.
   */
  private blockRoom(train: Train, route: TransitRoute, leader: number): number {
    const spans = this.spans[train.route];
    if (!spans.length) return Infinity;
    const inside = new Set<number>();
    for (const span of spans) if (this.bodyIn(route, train, span)) inside.add(span.block);
    // The nearest stretch ahead of a block it is not in already.
    let next: BlockSpan | null = null;
    let distance = Infinity;
    for (const span of spans) {
      if (inside.has(span.block)) continue;
      let d = train.direction === 1 ? span.from - train.s : train.s - span.to;
      if (route.loop && d < 0) d += route.total;
      if (d >= 0 && d < distance) {
        distance = d;
        next = span;
      }
    }
    const reach = (train.v * train.v) / (2 * BRAKE) + 40;
    const wanted = next && distance <= reach ? next.block : -1;
    for (const block of train.blocks) if (!inside.has(block) && block !== wanted) this.holders[block].delete(train.id);
    for (const block of inside) this.holders[block].add(train.id);
    train.blocks = [...this.holdersOf(train)];
    if (wanted < 0) return Infinity;
    const holders = this.holders[wanted];
    if (holders.has(train.id)) return Infinity;
    // Free, and nobody of its own line between it and the block: cleared in.
    if (holders.size === 0 && leader > distance) {
      holders.add(train.id);
      train.blocks.push(wanted);
      return Infinity;
    }
    return Math.max(0, distance - BLOCK_STAND);
  }

  private holdersOf(train: Train): number[] {
    const held: number[] = [];
    this.holders.forEach((set, block) => {
      if (set.has(train.id)) held.push(block);
    });
    return held;
  }

  /** Let go of every block a train holds, as when it leaves the map. */
  private releaseBlocks(train: Train): void {
    for (const block of train.blocks) this.holders[block].delete(train.id);
    train.blocks = [];
  }

  /** Put `count` trains on a route, evenly spread. */
  addTrains(routeIndex: number, count: number): void {
    const route = this.routes[routeIndex];
    for (let k = 0; k < count; k += 1) {
      const s = route.loop ? (route.total * k) / count : (route.total * (k + 0.5)) / count;
      const train: Train = { id: this.nextId, route: routeIndex, s, ps: s, v: 0, direction: 1, target: 0, doorsUntil: -1, load: 0, awayUntil: -1, blocks: [] };
      this.nextId += 1;
      train.target = this.stopAhead(route, train);
      this.trains.push(train);
    }
  }

  /** The next stop ahead of a train in its direction of travel. */
  private stopAhead(route: TransitRoute, train: Train): number {
    const n = route.stops.length;
    if (!n) return -1;
    if (train.direction === 1) {
      for (let i = 0; i < n; i += 1) if (route.stops[i].s > train.s + 1) return i;
      return route.loop ? 0 : -1;
    }
    for (let i = n - 1; i >= 0; i -= 1) if (route.stops[i].s < train.s - 1) return i;
    return -1;
  }

  /** Distance to go to reach a point at `s` in the direction of travel. */
  private ahead(route: TransitRoute, train: Train, s: number): number {
    let d = (s - train.s) * train.direction;
    // On a loop a point behind is a lap ahead, but a hair's breadth behind is here: a train that
    // has just pulled up at its stop must not find the stop a whole lap away.
    if (route.loop && d < -2) d += route.total;
    return d;
  }

  step(dt: number, now: number): void {
    for (const train of this.trains) {
      const route = this.routes[train.route];
      train.ps = train.s;
      if (train.awayUntil >= 0) {
        if (now < train.awayUntil) continue;
        train.awayUntil = -1;
      }
      if (train.doorsUntil >= 0) {
        if (now < train.doorsUntil) continue;
        const stop = route.stops[train.target];
        if (stop) this.onDoorsClose?.(train, route, stop);
        train.doorsUntil = -1;
        // At the end of an out-and-back route the train turns round: what was its back is now its
        // front, where it stands.
        if (!route.loop) {
          const turns = (train.direction === 1 && train.target === route.stops.length - 1 && route.stops[train.target].s > route.total - 60) || (train.direction === -1 && train.target === 0 && route.stops[0].s < 60);
          if (turns) {
            train.s -= train.direction * route.cars * route.carLength;
            train.ps = train.s;
            train.direction = train.direction === 1 ? -1 : 1;
          }
        } else if (stop?.reverses) {
          // On a loop that doubles back here: what was the back of the train leads out along the
          // track it came in on, the length of the train further round the loop.
          train.s = (train.s + route.cars * route.carLength) % route.total;
          train.ps = train.s;
        }
        train.target = this.stopAhead(route, train);
      }
      // How far it may run: to the next stop, to the train ahead, to a block of shared track it is
      // not yet cleared into, or to the end of the line.
      let room = train.target >= 0 ? this.ahead(route, train, route.stops[train.target].s) : train.direction === 1 ? route.total - train.s + 400 : train.s + 400;
      let leader = Infinity;
      for (const other of this.trains) {
        if (other === train || other.route !== train.route || other.awayUntil >= 0) continue;
        if (!route.loop && other.direction !== train.direction) continue;
        const gap = this.ahead(route, train, other.s) - route.cars * route.carLength - 25;
        if (gap > -route.cars * route.carLength && gap < leader) leader = Math.max(0, gap);
        if (gap > -route.cars * route.carLength && gap < room) room = Math.max(0, gap);
      }
      room = Math.min(room, this.blockRoom(train, route, leader));
      const allowed = Math.min(route.speed, Math.sqrt(2 * BRAKE * Math.max(0, room)));
      train.v += Math.max(-BRAKE * 1.5 * dt, Math.min(ACCEL * dt, allowed - train.v));
      if (train.v < 0) train.v = 0;
      // Never past the stop or the block it is braking for: a step is at most the room left.
      train.s += Math.min(train.v * dt, Math.max(0, room)) * train.direction;
      if (route.loop) train.s = ((train.s % route.total) + route.total) % route.total;

      if (train.target >= 0) {
        const stop = route.stops[train.target];
        if (this.ahead(route, train, stop.s) < 0.6 && train.v < 0.6) {
          train.s = stop.s;
          train.v = 0;
          train.doorsUntil = now + stop.dwell;
          this.onDoorsOpen?.(train, route, stop);
        }
      } else if (!route.loop && (train.s > route.total + 300 || train.s < -300)) {
        // Off the edge of the map: gone for a while, then back the other way. Those aboard get off
        // somewhere beyond the map, so it comes back empty.
        this.releaseBlocks(train);
        train.load = 0;
        train.direction = train.direction === 1 ? -1 : 1;
        train.s = train.direction === 1 ? -280 : route.total + 280;
        train.v = route.speed * 0.8;
        train.awayUntil = now + 240;
        train.target = this.stopAhead(route, train);
      }
    }
  }

  /**
   * Position of the middle of car `index` (0 at the front), for drawing. `alpha` is how far the
   * frame is between the last two steps.
   */
  carPose(train: Train, index: number, out: { x: number; y: number; z: number; heading: number; visible: boolean }, alpha = 1): void {
    const route = this.routes[train.route];
    // Over the join of a loop the two positions are a lap apart: take the short way.
    let moved = train.s - train.ps;
    if (route.loop && Math.abs(moved) > route.total / 2) moved -= Math.sign(moved) * route.total;
    let s = train.ps + moved * alpha - train.direction * (index + 0.5) * route.carLength;
    if (route.loop) s = ((s % route.total) + route.total) % route.total;
    out.visible = train.awayUntil < 0 && s >= 0 && s <= route.total;
    // The same pose the shared track was worked out for, so that what is drawn is what was kept apart.
    pointOn(route, s, out);
    if (train.direction === -1) out.heading += Math.PI;
    if (out.z < -1) out.visible = false;
  }
}
