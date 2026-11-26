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
}

const ACCEL = 0.9;
const BRAKE = 0.9;

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

  addRoute(route: TransitRoute): number {
    this.routes.push(route);
    return this.routes.length - 1;
  }

  /** Put `count` trains on a route, evenly spread. */
  addTrains(routeIndex: number, count: number): void {
    const route = this.routes[routeIndex];
    for (let k = 0; k < count; k += 1) {
      const s = route.loop ? (route.total * k) / count : (route.total * (k + 0.5)) / count;
      const train: Train = { id: this.nextId, route: routeIndex, s, ps: s, v: 0, direction: 1, target: 0, doorsUntil: -1, load: 0, awayUntil: -1 };
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
        // At the end of an out-and-back route the train turns round.
        if (!route.loop) {
          if (train.direction === 1 && train.target === route.stops.length - 1 && route.stops[train.target].s > route.total - 60) train.direction = -1;
          else if (train.direction === -1 && train.target === 0 && route.stops[0].s < 60) train.direction = 1;
        }
        train.target = this.stopAhead(route, train);
      }
      // How far it may run: to the next stop, to the train ahead, or to the end of the line.
      let room = train.target >= 0 ? this.ahead(route, train, route.stops[train.target].s) : train.direction === 1 ? route.total - train.s + 400 : train.s + 400;
      for (const other of this.trains) {
        if (other === train || other.route !== train.route || other.awayUntil >= 0) continue;
        if (!route.loop && other.direction !== train.direction) continue;
        const gap = this.ahead(route, train, other.s) - route.cars * route.carLength - 25;
        if (gap > -route.cars * route.carLength && gap < room) room = Math.max(0, gap);
      }
      const allowed = Math.min(route.speed, Math.sqrt(2 * BRAKE * Math.max(0, room)));
      train.v += Math.max(-BRAKE * 1.5 * dt, Math.min(ACCEL * dt, allowed - train.v));
      if (train.v < 0) train.v = 0;
      // Never past the stop it is braking for: a step is at most the room left.
      train.s += Math.min(train.v * dt, train.target >= 0 ? Math.max(0, room) : Infinity) * train.direction;
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
