// Everyone on foot: passengers and staff, held as flat arrays so tens of thousands are cheap.
// Each person runs a short script of steps (walk to a place, join a queue, wait, change floor,
// leave); the systems that own flights, security and shops write those scripts.

import { UNREACHABLE, type NavGrid } from './grid.ts';
import { SPACING, type LineSpot, type ServiceQueue } from './queue.ts';

export const ROLE = { passenger: 0, security: 1, agent: 2, gate: 3, shop: 4, cleaner: 5, ramp: 6, crew: 7, officer: 8 } as const;
export type RoleName = keyof typeof ROLE;

/** What a person is doing this moment. */
export const ACT = { idle: 0, walk: 1, toPoint: 2, queued: 3, served: 4, wait: 5, exit: 6 } as const;

/** How a person holds themselves: standing, or sitting in a seat. */
export const POSE = { standing: 0, sitting: 1 } as const;

/** Script step kinds. Each step is a kind and one argument. */
export const STEP = {
  /** Walk along distance field `arg` until close to its goal. */
  walk: 1,
  /** Walk straight to point `arg` in the point table. */
  point: 2,
  /** Join queue `arg`; the step ends when service ends. */
  queue: 3,
  /** Stand for `arg` seconds. */
  wait: 4,
  /** Stand until signal `arg` is raised. */
  until: 5,
  /** Move to floor `arg`, staying at the same place in plan. */
  floor: 6,
  /** Tell the owner: event `arg`. The owner may rewrite the rest of the script. */
  notify: 7,
  /** Leave the simulation. */
  leave: 8,
  /** Walk to seat `arg` in the seat table and sit down; the party takes it and the seats after it. */
  sit: 9,
} as const;

const STEPS = 14;
/** In `aim`: walking to the seat held, to sit down on arrival. */
const SEAT = -2;
/** Distance-field value below which a walk has arrived (tenths of a cell). */
const ARRIVED = 12;

export interface PeopleEvents {
  /** A `notify` step was reached. */
  notify(person: number, event: number): void;
  /** A person was called to a server after waiting `waited` seconds, and finished being served. */
  called(person: number, queue: number, server: number, waited: number): void;
  served(person: number, queue: number, server: number): void;
  /** A person ran their `leave` step. */
  left(person: number): void;
  /** How long a person takes at a queue's server, seconds. */
  serviceTime(person: number, queue: number): number;
}

export class People {
  readonly capacity: number;
  /** One past the highest index ever used. */
  high = 0;
  alive: Uint8Array;
  role: Uint8Array;
  act: Uint8Array;
  floor: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  h: Float32Array;
  px: Float32Array;
  py: Float32Array;
  ph: Float32Array;
  speed: Float32Array;
  cell: Int32Array;
  /** Target point while walking straight or shuffling in a queue. */
  tx: Float32Array;
  ty: Float32Array;
  until: Float64Array;
  queue: Int32Array;
  /** A small per-person offset inside a cell, so a crowd is not a grid of dots. */
  ox: Float32Array;
  oy: Float32Array;
  colour: Uint8Array;
  /** How many people walk together as this one: a travel party, or one member of staff. */
  size: Uint8Array;
  /** Free for the owner: which flight, which party, flags. */
  visit: Int32Array;
  party: Int32Array;
  flags: Uint16Array;
  /** Standing or sitting (POSE). */
  pose: Uint8Array;
  /** The way a person faces while standing still or sitting, radians from east. */
  facing: Float32Array;
  /**
   * The first of the seats a party holds, from when the owner gives them to it, while it walks
   * there and sits, until it gets up; -1 for none.
   */
  seat: Int32Array;
  /** Suitcases the party pulls along: set by the owner. */
  luggage: Uint8Array;
  /** Who each one is: a number given once and never again, unlike the index, which is reused. */
  serial: Float64Array;
  private serials = 0;
  /** The point a person is walking to, by index, to face the way it says on arrival; SEAT for their seat; -1 for neither. */
  private aim: Int32Array;
  /** The cell a walker is stepping to, downhill on the field it follows; -1 for none chosen yet. */
  private toward: Int32Array;
  /** A point someone called to a server goes by on the way there: the mouth of a lane; NaN for none. */
  private viaX: Float32Array;
  private viaY: Float32Array;
  private script: Int32Array;
  private pc: Uint8Array;
  private length: Uint8Array;
  private readonly free: number[] = [];
  count = 0;

  private readonly grids: NavGrid[];
  private readonly floorHeight: ((floor: number, cell: number) => number);
  private readonly fields: Uint16Array[] = [];
  private readonly fieldFloor: number[] = [];
  private readonly fieldGoal: number[] = [];
  private readonly points: number[] = [];
  /** The way to face at each point, or NaN to keep facing the way one came. */
  private readonly pointFacing: number[] = [];
  /** Seats: x, y and the way the sitter faces, three numbers each. */
  private seats: ArrayLike<number> = [];
  private readonly queues: ServiceQueue[] = [];
  private readonly signals: Uint8Array;
  private readonly spot: LineSpot = { x: 0, y: 0, dx: 0, dy: 0 };
  events: PeopleEvents | null = null;

  constructor(capacity: number, grids: NavGrid[], floorHeight: (floor: number, cell: number) => number, signals = 4096) {
    this.capacity = capacity;
    this.grids = grids;
    this.floorHeight = floorHeight;
    this.alive = new Uint8Array(capacity);
    this.role = new Uint8Array(capacity);
    this.act = new Uint8Array(capacity);
    this.floor = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.h = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.ph = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.cell = new Int32Array(capacity).fill(-1);
    this.tx = new Float32Array(capacity);
    this.ty = new Float32Array(capacity);
    this.until = new Float64Array(capacity);
    this.queue = new Int32Array(capacity).fill(-1);
    this.ox = new Float32Array(capacity);
    this.oy = new Float32Array(capacity);
    this.colour = new Uint8Array(capacity);
    this.size = new Uint8Array(capacity);
    this.visit = new Int32Array(capacity).fill(-1);
    this.party = new Int32Array(capacity).fill(-1);
    this.flags = new Uint16Array(capacity);
    this.pose = new Uint8Array(capacity);
    this.facing = new Float32Array(capacity);
    this.seat = new Int32Array(capacity).fill(-1);
    this.luggage = new Uint8Array(capacity);
    this.serial = new Float64Array(capacity);
    this.aim = new Int32Array(capacity).fill(-1);
    this.toward = new Int32Array(capacity).fill(-1);
    this.viaX = new Float32Array(capacity).fill(NaN);
    this.viaY = new Float32Array(capacity).fill(NaN);
    this.script = new Int32Array(capacity * STEPS * 2);
    this.pc = new Uint8Array(capacity);
    this.length = new Uint8Array(capacity);
    this.signals = new Uint8Array(signals);
  }

  // ---- tables the scripts refer to ------------------------------------------------------

  /**
   * Register a distance field on a floor, with the point it leads to; returns the id scripts use.
   * Someone standing where the field cannot reach walks straight for the point instead.
   */
  addField(floor: number, field: Uint16Array, goalX: number, goalY: number): number {
    this.fields.push(field);
    this.fieldFloor.push(floor);
    this.fieldGoal.push(goalX, goalY);
    return this.fields.length - 1;
  }

  /** A point people can be sent to, and the way they face once there (NaN: the way they came). */
  addPoint(x: number, y: number, facing = NaN): number {
    this.points.push(x, y);
    this.pointFacing.push(facing);
    return this.points.length / 2 - 1;
  }

  /** The seat table: x, y and the way the sitter faces, three numbers per seat. */
  setSeats(seats: ArrayLike<number>): void {
    this.seats = seats;
  }

  /** The signal a person is standing or sitting waiting for, or -1 when that is not what they are doing. */
  waitingFor(id: number): number {
    if (this.act[id] !== ACT.wait) return -1;
    // While it waits, an `until` step leaves the count on the step before it (see `begin`).
    const pc = this.pc[id];
    const base = id * STEPS * 2;
    if (pc < this.length[id] && this.script[base + pc * 2] === STEP.wait) return -1;
    const next = (pc + 1) & 0xff;
    return next < this.length[id] && this.script[base + next * 2] === STEP.until ? this.script[base + next * 2 + 1] : -1;
  }

  addQueue(queue: ServiceQueue): number {
    this.queues.push(queue);
    return this.queues.length - 1;
  }

  queueAt(id: number): ServiceQueue {
    return this.queues[id];
  }

  setSignal(id: number, raised: boolean): void {
    this.signals[id] = raised ? 1 : 0;
  }

  // ---- people ---------------------------------------------------------------------------

  /** Add a person at a place on a floor. Returns -1 when the store is full. */
  add(role: number, floor: number, x: number, y: number, speed: number, colour: number, jitter: number, size = 1): number {
    const id = this.free.length ? this.free.pop()! : this.high < this.capacity ? this.high++ : -1;
    if (id < 0) return -1;
    this.alive[id] = 1;
    this.serial[id] = ++this.serials;
    this.role[id] = role;
    this.size[id] = size;
    this.act[id] = ACT.idle;
    this.floor[id] = floor;
    this.x[id] = this.px[id] = x;
    this.y[id] = this.py[id] = y;
    this.speed[id] = speed;
    this.colour[id] = colour;
    this.queue[id] = -1;
    this.visit[id] = -1;
    this.party[id] = -1;
    this.flags[id] = 0;
    this.pose[id] = POSE.standing;
    this.seat[id] = -1;
    this.luggage[id] = 0;
    this.aim[id] = -1;
    this.viaX[id] = NaN;
    this.pc[id] = 0;
    this.length[id] = 0;
    // A fixed offset from the low bits of `jitter`, up to about a metre each way.
    this.ox[id] = (((jitter >>> 0) % 200) / 100 - 1) * 0.9;
    this.oy[id] = ((((jitter >>> 8) >>> 0) % 200) / 100 - 1) * 0.9;
    this.facing[id] = ((((jitter >>> 16) >>> 0) % 628) / 100) - Math.PI;
    this.enterCell(id);
    this.h[id] = this.ph[id] = this.cell[id] >= 0 ? this.floorHeight(floor, this.cell[id]) : 0;
    this.count += 1;
    return id;
  }

  remove(id: number): void {
    if (!this.alive[id]) return;
    this.leaveCell(id);
    if (this.queue[id] >= 0) this.queues[this.queue[id]].leave(id);
    this.alive[id] = 0;
    this.queue[id] = -1;
    this.seat[id] = -1;
    this.pose[id] = POSE.standing;
    this.free.push(id);
    this.count -= 1;
  }

  /** Replace what is left of a person's script. Steps are [kind, arg] pairs. */
  setScript(id: number, steps: readonly number[]): void {
    const n = Math.min(STEPS, steps.length / 2);
    for (let i = 0; i < n * 2; i += 1) this.script[id * STEPS * 2 + i] = steps[i];
    this.length[id] = n;
    this.pc[id] = 0;
    this.act[id] = ACT.idle;
    if (this.queue[id] >= 0) {
      this.queues[this.queue[id]].leave(id);
      this.queue[id] = -1;
    }
  }

  private enterCell(id: number): void {
    const grid = this.grids[this.floor[id]];
    if (!grid) {
      this.cell[id] = -1;
      return;
    }
    const cell = grid.nearestCell(this.x[id], this.y[id], 30);
    this.cell[id] = cell;
    if (cell >= 0) grid.occupancy[cell] += 1;
  }

  private leaveCell(id: number): void {
    const grid = this.grids[this.floor[id]];
    const cell = this.cell[id];
    if (grid && cell >= 0 && grid.occupancy[cell] > 0) grid.occupancy[cell] -= 1;
    this.cell[id] = -1;
  }

  private next(id: number): void {
    this.pc[id] += 1;
    this.act[id] = ACT.idle;
  }

  /** Advance the people whose turn it is: those with `id % phases === phase`, by `dt` seconds. */
  step(now: number, dt: number, phase: number, phases: number): void {
    for (let id = phase; id < this.high; id += phases) {
      if (!this.alive[id]) continue;
      this.px[id] = this.x[id];
      this.py[id] = this.y[id];
      this.ph[id] = this.h[id];
      // Start steps until one takes time; a script may chain several instant ones.
      for (let guard = 0; guard < 6 && this.act[id] === ACT.idle; guard += 1) {
        if (this.pc[id] >= this.length[id]) break;
        if (!this.begin(id, now)) break;
      }
      if (!this.alive[id]) continue;
      switch (this.act[id]) {
        case ACT.walk:
          this.walk(id, dt);
          break;
        case ACT.toPoint:
          if (this.moveTowards(id, this.tx[id], this.ty[id], this.speed[id] * dt)) {
            this.arrive(id);
            this.next(id);
          }
          break;
        case ACT.exit:
          // Out through the lane or past the booth, then on with the script.
          if (this.moveTowards(id, this.tx[id], this.ty[id], this.speed[id] * dt)) this.act[id] = ACT.idle;
          break;
        case ACT.queued:
          // Where to stand is set for the whole line at once, in stepQueues.
          this.moveTowards(id, this.tx[id], this.ty[id], this.speed[id] * 1.2 * dt);
          break;
        case ACT.served:
          this.approachServer(id, this.speed[id] * dt);
          break;
        case ACT.wait:
          if (now >= this.until[id]) this.next(id);
          break;
        default:
          break;
      }
    }
  }

  /** Reached the point or seat being walked to: sit down, or face the way the point says. */
  private arrive(id: number): void {
    const aim = this.aim[id];
    const seat = this.seat[id];
    if (aim === SEAT && seat >= 0) {
      this.pose[id] = POSE.sitting;
      this.facing[id] = this.seats[seat * 3 + 2];
    } else if (aim >= 0 && !Number.isNaN(this.pointFacing[aim])) this.facing[id] = this.pointFacing[aim];
  }

  /** Start the current step. Returns false when the person is gone or the step is waiting. */
  private begin(id: number, now: number): boolean {
    const at = id * STEPS * 2 + this.pc[id] * 2;
    const kind = this.script[at];
    const arg = this.script[at + 1];
    // Anything that moves them gets them up out of their seat first, and gives it up.
    if (kind !== STEP.wait && kind !== STEP.until && kind !== STEP.notify) {
      if (this.pose[id] === POSE.sitting) {
        this.pose[id] = POSE.standing;
        this.seat[id] = -1;
      }
      this.aim[id] = -1;
    }
    switch (kind) {
      case STEP.walk:
        if (this.fieldFloor[arg] !== this.floor[id]) {
          this.next(id);
          return true;
        }
        this.tx[id] = arg;
        this.toward[id] = -1;
        this.act[id] = ACT.walk;
        return false;
      case STEP.point:
        this.tx[id] = this.points[arg * 2];
        this.ty[id] = this.points[arg * 2 + 1];
        this.aim[id] = arg;
        this.act[id] = ACT.toPoint;
        return false;
      case STEP.sit:
        this.tx[id] = this.seats[arg * 3];
        this.ty[id] = this.seats[arg * 3 + 1];
        this.seat[id] = arg;
        this.aim[id] = SEAT;
        this.act[id] = ACT.toPoint;
        return false;
      case STEP.queue: {
        const queue = this.queues[arg];
        // The tail: as much line ahead as everyone already in it takes up.
        let ahead = 0;
        for (const other of queue.line) ahead += this.room(other);
        this.queue[id] = arg;
        queue.join(id, now);
        this.act[id] = ACT.queued;
        this.standAt(id, queue, ahead);
        this.tx[id] = this.spot.x;
        this.ty[id] = this.spot.y;
        return false;
      }
      case STEP.wait:
        this.until[id] = now + arg;
        this.act[id] = ACT.wait;
        return false;
      case STEP.until:
        if (this.signals[arg]) {
          this.next(id);
          return true;
        }
        this.until[id] = now + 2;
        this.act[id] = ACT.wait;
        // Come back to this same step when the short wait ends.
        this.pc[id] -= 1;
        return false;
      case STEP.floor:
        this.leaveCell(id);
        this.floor[id] = arg;
        this.enterCell(id);
        if (this.cell[id] >= 0) this.h[id] = this.floorHeight(arg, this.cell[id]);
        this.next(id);
        return true;
      case STEP.notify:
        this.next(id);
        this.events?.notify(id, arg);
        return this.alive[id] === 1;
      case STEP.leave:
        this.events?.left(id);
        this.remove(id);
        return false;
      default:
        this.next(id);
        return true;
    }
  }

  private walk(id: number, dt: number): void {
    const grid = this.grids[this.floor[id]];
    const field = this.fields[this.tx[id] | 0];
    let cell = this.cell[id];
    if (!grid || cell < 0 || field[cell] <= ARRIVED) {
      this.next(id);
      return;
    }
    if (field[cell] === UNREACHABLE) {
      // Cut off from the goal on this floor: walk straight for it.
      const f = this.tx[id] | 0;
      this.tx[id] = this.fieldGoal[f * 2];
      this.ty[id] = this.fieldGoal[f * 2 + 1];
      this.act[id] = ACT.toPoint;
      return;
    }
    // Head for the next cell downhill, and keep on for it until there or somewhere as near the goal:
    // choosing afresh from each cell one crosses on the way could turn someone back and forth
    // between two cells for ever. Crowding ahead slows the pace.
    let target = this.toward[id];
    if (target < 0 || field[target] >= field[cell]) {
      target = grid.downhill(field, cell, ((id * 2654435761) >>> 0) / 4294967296);
      this.toward[id] = target;
    }
    const crowd = grid.occupancy[target];
    const pace = crowd > 9 ? 0.3 : crowd > 5 ? 0.6 : 1;
    const gx = grid.cx[target] + this.ox[id];
    const gy = grid.cy[target] + this.oy[id];
    this.moveTowards(id, gx, gy, this.speed[id] * pace * dt);
    const now = grid.cellAt(this.x[id], this.y[id]);
    if (now >= 0 && now !== cell) {
      if (grid.occupancy[cell] > 0) grid.occupancy[cell] -= 1;
      grid.occupancy[now] += 1;
      this.cell[id] = now;
      cell = now;
      this.h[id] = this.floorHeight(this.floor[id], now);
    }
  }

  /** Someone called from the side of a bank of lanes first gets behind their mouths, then
   * crosses the clear aisle to their own lane. A diagonal from the side cuts through its neighbours. */
  private approachServer(id: number, distance: number): void {
    const mx = this.viaX[id], my = this.viaY[id];
    if (Number.isNaN(mx)) {
      this.moveTowards(id, this.tx[id], this.ty[id], distance);
      return;
    }
    const dx = this.tx[id] - mx, dy = this.ty[id] - my;
    const length2 = dx * dx + dy * dy;
    const ahead = length2 ? ((this.x[id] - mx) * dx + (this.y[id] - my) * dy) / length2 : 0;
    if (ahead > 0.01) {
      this.moveTowards(id, this.x[id] - ahead * dx, this.y[id] - ahead * dy, distance);
      return;
    }
    if (this.moveTowards(id, mx, my, distance)) this.viaX[id] = NaN;
  }

  /** Step towards a point; true once there. */
  private moveTowards(id: number, x: number, y: number, distance: number): boolean {
    const dx = x - this.x[id];
    const dy = y - this.y[id];
    const d = Math.hypot(dx, dy);
    if (d <= distance || d < 0.05) {
      this.x[id] = x;
      this.y[id] = y;
      return true;
    }
    this.x[id] += (dx / d) * distance;
    this.y[id] += (dy / d) * distance;
    return false;
  }

  /**
   * Metres of line a party takes up: about SPACING a head, some standing closer to the one in
   * front and some further back, each in their own way.
   */
  private room(id: number): number {
    return (this.size[id] || 1) * SPACING * (1.05 + 0.28 * (this.oy[id] / 0.9));
  }

  /**
   * Where a person with `ahead` metres of line in front of them stands, into `this.spot`: on the
   * line, a little to one side as people stand, facing roughly the way it goes.
   */
  private standAt(id: number, queue: ServiceQueue, ahead: number): void {
    queue.spotAt(ahead, this.spot);
    const side = this.ox[id] * 0.3;
    this.spot.x += -this.spot.dy * side;
    this.spot.y += this.spot.dx * side;
    this.facing[id] = Math.atan2(this.spot.dy, this.spot.dx) + this.ox[id] * this.oy[id] * 0.5;
  }

  /** Run every queue: call people forward and finish those whose service is over. */
  stepQueues(now: number): void {
    for (let q = 0; q < this.queues.length; q += 1) {
      const queue = this.queues[q];
      if (!queue.size) continue;
      // Everyone in line has a place, which follows from how much line is ahead of them; but
      // people shuffle up only once the gap in front has opened a little, so a line moves on in
      // waves from the front rather than all at once.
      const line = queue.line;
      let ahead = 0;
      for (let place = 0; place < line.length; place += 1) {
        const id = line[place];
        this.standAt(id, queue, ahead);
        const gap = Math.hypot(this.spot.x - this.tx[id], this.spot.y - this.ty[id]);
        if (place === 0 || gap > 0.5 + 0.55 * Math.abs(this.ox[id] / 0.9)) {
          this.tx[id] = this.spot.x;
          this.ty[id] = this.spot.y;
        }
        ahead += this.room(id);
      }
      queue.step(
        now,
        (person) => this.events?.serviceTime(person, q) ?? 30,
        (person, server, waited) => {
          this.act[person] = ACT.served;
          this.tx[person] = queue.servers[server].x;
          this.ty[person] = queue.servers[server].y;
          this.viaX[person] = queue.servers[server].approachX;
          this.viaY[person] = queue.servers[server].approachY;
          this.events?.called(person, q, server, waited);
        },
        (person, server) => {
          // Someone whose script was rewritten while being served has already moved on.
          if (!this.alive[person] || this.queue[person] !== q) return;
          this.queue[person] = -1;
          this.next(person);
          const s = queue.servers[server];
          if (!Number.isNaN(s.exitX)) {
            this.act[person] = ACT.exit;
            this.tx[person] = s.exitX;
            this.ty[person] = s.exitY;
          }
          this.events?.served(person, q, server);
        },
      );
    }
  }
}
