// A place where people wait in line to be served: check-in desks, security lanes, passport
// booths, a gate. The line snakes back and forth between ropes inside a rectangle; the servers
// stand at its head. Who is in the line is held here; where each of them stands follows from how
// much line is ahead of them.

export interface QueueShape {
  /** Centre of the waiting area, the direction people face while queuing, and its size. */
  x: number;
  y: number;
  heading: number;
  length: number;
  width: number;
}

export interface Server {
  x: number;
  y: number;
  /** Where someone served here walks to before going on: through the lane, past the booth; NaN for nowhere. */
  exitX: number;
  exitY: number;
  /** Where someone called here comes by on the way: the mouth of a lane, behind its bins; NaN for straight there. */
  approachX: number;
  approachY: number;
  open: boolean;
  /** Person being served, or -1, and when their turn ends. */
  serving: number;
  until: number;
  /** People served since the facility opened, for throughput figures. */
  served: number;
}

/** A point on the line, and which way the line runs there towards its head. */
export interface LineSpot {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export const LANE_WIDTH = 1.3;
/** Metres of line each person takes up, on average. */
export const SPACING = 0.85;
/**
 * Where the crowd past the ropes may stand only on some of the floor: each of its people stands in
 * a whole place of its spiral, one in each, the spiral's places this much of a person apart so that
 * no two share one; and so many places are looked through for the next it may stand in.
 */
const CROWD_LOOSER = 0.75;
const CROWD_TRIES = 600;

export class ServiceQueue {
  readonly shape: QueueShape;
  readonly servers: Server[] = [];
  /** People in line, head first. */
  readonly line: number[] = [];
  /** Lanes the rope makes inside the rectangle. */
  readonly lanes: number;
  /** Corners of the snaking line, from the head back to the tail, as x, y pairs. */
  private readonly path: number[] = [];
  private readonly cum: number[] = [0];
  readonly capacity: number;
  /** Seconds waited by the last people to reach a server, for the measured wait. */
  private readonly recentWaits: number[] = [];
  private readonly joinedAt = new Map<number, number>();
  /** Where the crowd past the ropes may stand, or null for anywhere. */
  private readonly standable: ((x: number, y: number) => boolean) | null;
  /** The whole places of the crowd's spiral it may stand in, in the order it fills them: found as far as needed. */
  private readonly crowd: number[] = [];
  totalServed = 0;
  /** Seconds of waiting summed over everyone served. */
  totalWait = 0;
  longestWait = 0;

  constructor(shape: QueueShape, servers: readonly { x: number; y: number; exitX?: number; exitY?: number; approachX?: number; approachY?: number }[], standable: ((x: number, y: number) => boolean) | null = null) {
    this.shape = shape;
    this.standable = standable;
    for (const s of servers) this.servers.push({ x: s.x, y: s.y, exitX: s.exitX ?? NaN, exitY: s.exitY ?? NaN, approachX: s.approachX ?? NaN, approachY: s.approachY ?? NaN, open: false, serving: -1, until: 0, served: 0 });
    // The head of the line is at the front edge; lanes run back and forth behind it.
    const ux = Math.cos(shape.heading);
    const uy = Math.sin(shape.heading);
    const nx = -uy;
    const ny = ux;
    this.lanes = Math.max(1, Math.floor(shape.width / LANE_WIDTH));
    const halfL = shape.length / 2;
    for (let lane = 0; lane < this.lanes; lane += 1) {
      const across = (lane - (this.lanes - 1) / 2) * LANE_WIDTH;
      const near: [number, number] = [shape.x + ux * halfL + nx * across, shape.y + uy * halfL + ny * across];
      const far: [number, number] = [shape.x - ux * halfL + nx * across, shape.y - uy * halfL + ny * across];
      const [first, second] = lane % 2 === 0 ? [near, far] : [far, near];
      this.addPoint(first[0], first[1]);
      this.addPoint(second[0], second[1]);
    }
    this.capacity = Math.max(4, Math.floor(this.cum[this.cum.length - 1] / SPACING));
  }

  private addPoint(x: number, y: number): void {
    const n = this.path.length;
    if (n) this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(x - this.path[n - 2], y - this.path[n - 1]));
    this.path.push(x, y);
  }

  get openServers(): number {
    return this.servers.reduce((n, s) => n + (s.open ? 1 : 0), 0);
  }

  /** Open the first `count` servers and close the rest; a closing server finishes its customer. */
  setOpen(count: number): void {
    this.servers.forEach((s, i) => {
      s.open = i < count;
    });
  }

  /** People in line plus those being served. */
  get size(): number {
    return this.line.length + this.servers.reduce((n, s) => n + (s.serving >= 0 ? 1 : 0), 0);
  }

  join(person: number, now: number): void {
    this.line.push(person);
    this.joinedAt.set(person, now);
  }

  /** Everyone still in line, with how long each has waited so far. */
  waiting(now: number): { person: number; waited: number }[] {
    return this.line.map((person) => ({ person, waited: now - (this.joinedAt.get(person) ?? now) }));
  }

  /**
   * Take someone out of the line, or away from the server serving them, who has given up or been
   * called away: a server still holding them would finish with whoever is given their place next.
   */
  leave(person: number): void {
    const at = this.line.indexOf(person);
    if (at >= 0) this.line.splice(at, 1);
    this.joinedAt.delete(person);
    for (const server of this.servers) if (server.serving === person) server.serving = -1;
  }

  /** Metres of line between the ropes. */
  get roped(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Where the line is joined: the far end of the ropes. */
  get entrance(): { x: number; y: number } {
    return { x: this.path[this.path.length - 2], y: this.path[this.path.length - 1] };
  }

  /**
   * Where someone stands with `d` metres of line ahead of them (0 is the head), and which way the
   * line runs there.
   */
  spotAt(d: number, out: LineSpot): void {
    const total = this.cum[this.cum.length - 1];
    if (d <= total) {
      let i = 1;
      while (i < this.cum.length - 1 && this.cum[i] < d) i += 1;
      const x0 = this.path[(i - 1) * 2];
      const y0 = this.path[(i - 1) * 2 + 1];
      const x1 = this.path[i * 2];
      const y1 = this.path[i * 2 + 1];
      const span = this.cum[i] - this.cum[i - 1] || 1;
      const t = Math.max(0, Math.min(1, (d - this.cum[i - 1]) / span));
      out.x = x0 + (x1 - x0) * t;
      out.y = y0 + (y1 - y0) * t;
      // The path runs from the head back to the tail; the line faces the other way.
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      out.dx = (x0 - x1) / len;
      out.dy = (y0 - y1) / len;
      return;
    }
    // Past the end of the ropes the line is a loose crowd, behind the back of the rectangle where
    // the ropes begin, filling a half circle outwards from its middle as people bunch up there;
    // where the floor is limited, in the places of it the floor has.
    const k = (d - total) / SPACING;
    out.dx = Math.cos(this.shape.heading);
    out.dy = Math.sin(this.shape.heading);
    [out.x, out.y] = this.crowdAt(this.standable ? this.crowdPlace(Math.floor(k / CROWD_LOOSER)) : k);
  }

  /** The `k`th place of the crowd past the ropes, as its half circle fills, the floor aside. */
  private crowdAt(k: number): [number, number] {
    const ux = Math.cos(this.shape.heading);
    const uy = Math.sin(this.shape.heading);
    const n = this.path.length;
    const ex = this.path[n - 2];
    const ey = this.path[n - 1];
    // The entrance's place across the rectangle; the crowd stands behind the back edge there.
    const across = (ex - this.shape.x) * -uy + (ey - this.shape.y) * ux;
    const r = 0.95 * Math.sqrt(k + 0.5);
    const a = ((k * 2.39996323) % Math.PI) - Math.PI / 2;
    const back = this.shape.length / 2 + 0.9 + r * Math.cos(a);
    const side = across + r * Math.sin(a);
    return [this.shape.x - ux * back - uy * side, this.shape.y - uy * back + ux * side];
  }

  /** The `i`th whole place of the crowd's spiral that it may stand in (or, with none near, the next of any). */
  private crowdPlace(i: number): number {
    while (this.crowd.length <= i) {
      const after = this.crowd.length ? this.crowd[this.crowd.length - 1] + 1 : 0;
      let j = after;
      while (j < after + CROWD_TRIES && !this.standable!(...this.crowdAt(j))) j += 1;
      this.crowd.push(j < after + CROWD_TRIES ? j : after);
    }
    return this.crowd[i];
  }

  /**
   * The ropes that keep the line to its lanes, as polylines of x, y pairs: the two sides, one
   * between each pair of lanes, open at the end where the line turns, and the front and back,
   * open where the line leaves for the servers and where it is joined.
   */
  ropes(): number[][] {
    const { x, y, heading, length } = this.shape;
    const ux = Math.cos(heading);
    const uy = Math.sin(heading);
    const at = (along: number, across: number): [number, number] => [x + ux * along - uy * across, y + uy * along + ux * across];
    const lanes = this.lanes;
    const halfL = length / 2;
    const side = (lanes / 2) * LANE_WIDTH;
    const between = (i: number): number => (i + 1 - lanes / 2) * LANE_WIDTH;
    const out: number[][] = [
      [...at(halfL, -side), ...at(-halfL, -side)],
      [...at(halfL, side), ...at(-halfL, side)],
    ];
    for (let i = 0; i + 1 < lanes; i += 1) {
      // Lane i runs from the front to the back when i is even, so it joins the next at the back.
      if (i % 2 === 0) out.push([...at(halfL, between(i)), ...at(-halfL + LANE_WIDTH, between(i))]);
      else out.push([...at(halfL - LANE_WIDTH, between(i)), ...at(-halfL, between(i))]);
    }
    if (lanes >= 2) {
      // The last lane is joined at the back when there is an odd number of lanes, else at the front.
      const odd = lanes % 2 === 1;
      out.push([...at(halfL, between(0)), ...at(halfL, odd ? side : between(lanes - 2))]);
      if (odd) out.push([...at(-halfL, -side), ...at(-halfL, between(lanes - 2))]);
      else out.push([...at(-halfL, -side), ...at(-halfL, side)]);
    }
    return out;
  }

  /**
   * Move the line on: finish anyone whose time is up and call the next person to each free open
   * server. `serviceTime` gives how long a person will take; `done` is told who has finished and
   * `called` who has gone to which server.
   */
  step(now: number, serviceTime: (person: number) => number, called: (person: number, server: number, waited: number) => void, done: (person: number, server: number) => void): void {
    for (let i = 0; i < this.servers.length; i += 1) {
      const s = this.servers[i];
      if (s.serving >= 0 && now >= s.until) {
        const person = s.serving;
        s.serving = -1;
        s.served += 1;
        done(person, i);
      }
      if (s.serving < 0 && s.open && this.line.length) {
        const person = this.line.shift()!;
        const waited = now - (this.joinedAt.get(person) ?? now);
        this.joinedAt.delete(person);
        this.totalServed += 1;
        this.totalWait += waited;
        if (waited > this.longestWait) this.longestWait = waited;
        this.recentWaits.push(waited);
        if (this.recentWaits.length > 40) this.recentWaits.shift();
        s.serving = person;
        s.until = now + serviceTime(person);
        called(person, i, waited);
      }
    }
  }

  /** Average wait of the last few dozen people served, seconds. */
  get recentWait(): number {
    if (!this.recentWaits.length) return 0;
    return this.recentWaits.reduce((a, b) => a + b, 0) / this.recentWaits.length;
  }

  /** How long someone joining now can expect to wait, from the line and the rate it is moving. */
  expectedWait(meanService: number): number {
    const open = Math.max(1, this.openServers);
    return (this.line.length * meanService) / open;
  }
}
