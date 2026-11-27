// A place where people wait in line to be served: check-in desks, security lanes, passport
// booths, a gate. The line snakes back and forth inside a rectangle; the servers stand at its
// head. Who is in the line is held here; where each of them stands follows from their place.

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
  open: boolean;
  /** Person being served, or -1, and when their turn ends. */
  serving: number;
  until: number;
  /** People served since the facility opened, for throughput figures. */
  served: number;
}

const LANE_WIDTH = 1.3;
/** Metres of line each person takes up. */
export const SPACING = 0.85;

export class ServiceQueue {
  readonly shape: QueueShape;
  readonly servers: Server[] = [];
  /** People in line, head first. */
  readonly line: number[] = [];
  /** Corners of the snaking line, from the head back to the tail, as x, y pairs. */
  private readonly path: number[] = [];
  private readonly cum: number[] = [0];
  readonly capacity: number;
  /** Seconds waited by the last people to reach a server, for the measured wait. */
  private readonly recentWaits: number[] = [];
  private readonly joinedAt = new Map<number, number>();
  totalServed = 0;
  /** Seconds of waiting summed over everyone served. */
  totalWait = 0;
  longestWait = 0;

  constructor(shape: QueueShape, servers: readonly { x: number; y: number }[]) {
    this.shape = shape;
    for (const s of servers) this.servers.push({ x: s.x, y: s.y, open: false, serving: -1, until: 0, served: 0 });
    // The head of the line is at the front edge; lanes run back and forth behind it.
    const ux = Math.cos(shape.heading);
    const uy = Math.sin(shape.heading);
    const nx = -uy;
    const ny = ux;
    const lanes = Math.max(1, Math.floor(shape.width / LANE_WIDTH));
    const halfL = shape.length / 2;
    for (let lane = 0; lane < lanes; lane += 1) {
      const across = (lane - (lanes - 1) / 2) * LANE_WIDTH;
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

  /** Where the person at `place` in the line stands (0 is the head). */
  spot(place: number, out: { x: number; y: number }): void {
    const total = this.cum[this.cum.length - 1];
    // Beyond the end of the rope the line bunches up at the tail.
    const d = Math.min(total, place * SPACING);
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i += 1;
    const span = this.cum[i] - this.cum[i - 1] || 1;
    const t = (d - this.cum[i - 1]) / span;
    out.x = this.path[(i - 1) * 2] + (this.path[i * 2] - this.path[(i - 1) * 2]) * t;
    out.y = this.path[(i - 1) * 2 + 1] + (this.path[i * 2 + 1] - this.path[(i - 1) * 2 + 1]) * t;
    if (place * SPACING > total) {
      // A loose crowd behind the last rope, a row every 0.7 m.
      const extra = place * SPACING - total;
      const row = Math.floor(extra / (this.shape.width * 0.9)) + 1;
      const col = (extra % (this.shape.width * 0.9)) - this.shape.width * 0.45;
      const ux = Math.cos(this.shape.heading);
      const uy = Math.sin(this.shape.heading);
      out.x = this.shape.x - ux * (this.shape.length / 2 + row * 0.7) - uy * col;
      out.y = this.shape.y - uy * (this.shape.length / 2 + row * 0.7) + ux * col;
    }
  }

  /** Where people walk to in order to join: the tail of the line as it is now. */
  tail(out: { x: number; y: number }): void {
    this.spot(this.line.length, out);
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
