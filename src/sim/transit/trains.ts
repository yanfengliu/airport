// Trains on fixed routes: the AirTrain's loops, BART in and out of its terminus, Caltrain passing
// through. A route is a line with stops along it; a train runs along the line, slows for each
// stop, opens its doors for a while and moves on.

export interface Stop {
  name: string;
  /** Distance along the route. */
  s: number;
  /** Seconds the doors stay open. */
  dwell: number;
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
  carLength: number;
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
 * SAMPLE metres; they share track where they run within SAME_TRACK metres of each other, level.
 */
const SAMPLE = 4;
const SAME_TRACK = 1.5;
/** Points of one route this far apart along it are different places on it, not the same one. */
const SELF_APART = 60;
/** A block reaches this far past where the lines meet and part, for the width of the trains. */
const BLOCK_PAD = 8;
/** Two stretches of one block on one route closer than this are one: a train cannot wait between. */
const BLOCK_JOIN = 100;
/** Where a train waits for a block, short of it. */
const BLOCK_STAND = 10;

/** A stretch of a route that lies in a block, from `from` to `to` along it. */
interface BlockSpan {
  from: number;
  to: number;
  block: number;
}

export function makeRoute(id: string, kind: TransitRoute['kind'], pts: number[], loop: boolean, stops: Stop[], speed: number, cars: number, carLength: number): TransitRoute {
  const cum = [0];
  for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]));
  return { id, kind, pts, cum, total: cum[cum.length - 1], loop, stops: [...stops].sort((a, b) => a.s - b.s), speed, cars, carLength };
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

  /**
   * Find where routes share track, with one another or with themselves, and make each such place
   * a block. Called once every route is on.
   */
  findSharedTrack(): void {
    const samples: { r: number; s: number; x: number; y: number; z: number }[] = [];
    const point = { x: 0, y: 0, z: 0 };
    const firstOf: number[] = [];
    this.routes.forEach((route, r) => {
      firstOf.push(samples.length);
      for (let s = 0; s <= route.total; s += SAMPLE) {
        this.pointAt(route, s, point);
        samples.push({ r, s, x: point.x, y: point.y, z: point.z });
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
    const CELL = 4;
    const grid = new Map<string, number[]>();
    samples.forEach((p, i) => {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    });
    samples.forEach((p, i) => {
      const cx = Math.floor(p.x / CELL);
      const cy = Math.floor(p.y / CELL);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i) continue;
            const q = samples[j];
            if (Math.hypot(p.x - q.x, p.y - q.y) > SAME_TRACK || Math.abs(p.z - q.z) > SAME_TRACK) continue;
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
    // Stretches of one block close together on one route are one: there is no room to wait between.
    for (let r = 0; r < this.spans.length; r += 1) {
      const spans = this.spans[r].sort((a, b) => a.from - b.from);
      const joined: BlockSpan[] = [];
      for (const span of spans) {
        const last = joined[joined.length - 1];
        if (last && last.block === span.block && span.from - last.to < BLOCK_JOIN) last.to = Math.max(last.to, span.to);
        else joined.push({ ...span });
      }
      this.spans[r] = joined;
    }
    this.holders = [...blockOf.values()].map(() => new Set<number>());
  }

  /** A point `s` along a route. */
  private pointAt(route: TransitRoute, s: number, out: { x: number; y: number; z: number }): void {
    const d = Math.max(0, Math.min(route.total, s));
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
        // Off the edge of the map: gone for a while, then back the other way.
        this.releaseBlocks(train);
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
    const d = Math.max(0, Math.min(route.total, s));
    const cum = route.cum;
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
    out.x = route.pts[i] + (route.pts[i + 3] - route.pts[i]) * t;
    out.y = route.pts[i + 1] + (route.pts[i + 4] - route.pts[i + 1]) * t;
    out.z = route.pts[i + 2] + (route.pts[i + 5] - route.pts[i + 2]) * t;
    out.heading = Math.atan2(route.pts[i + 4] - route.pts[i + 1], route.pts[i + 3] - route.pts[i]) + (train.direction === -1 ? Math.PI : 0);
    if (out.z < -1) out.visible = false;
  }
}
