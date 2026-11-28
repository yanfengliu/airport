// Where the ground equipment stands round a parked aircraft, as its turnaround goes: power at the
// nose while it is on stand; a belt loader and a train of baggage carts at a narrow-body's aft
// hold, container loaders and dollies of containers at a wide-body's holds, until the doors
// close; the lavatory truck at the tail early in the stay; catering at the rear door before
// boarding; fuel at the wing; stairs and a bus at a stand with no jet bridge; and the tug that
// pushes it back. Each piece is one of Polyfork's vehicles (public/models), placed by the box its
// model is drawn in. All the pieces a type can have out are laid out once, clear of each other
// and of the aircraft as drawn, and each shows while its task goes on. Worked out from the
// aircraft and its visit; nothing here is simulated, and nothing here needs three.js, so the
// placement can be checked without drawing it (test/gse.test.ts).

import { airframe, wingOver } from '../../shared/airframe.ts';
import type { Aircraft } from '../../sim/airside/aircraft.ts';

export type GseKind =
  | 'pushback'
  | 'towbar'
  | 'towbarless'
  | 'power'
  | 'loader'
  | 'kloader'
  | 'bagtug'
  | 'cart'
  | 'dolly'
  | 'uld'
  | 'catering'
  | 'hydrant'
  | 'tanker'
  | 'stairs'
  | 'stairsLow'
  | 'bus'
  | 'lavatory'
  | 'handler'
  | 'fueller'
  | 'engineer'
  | 'marshaller';

/**
 * A kind's model, and the box it is drawn in, metres, from its origin: from `back` to `front`
 * along its length (its front faces the way it heads), from `right` to `left` across it, and up to
 * `top`. As converted into public/models/index.json, which test/gse.test.ts holds them to. The tow
 * bar has no model: it is drawn as a plain bar, stretched to its length.
 */
export interface GseModel {
  id: string | null;
  /** A person (one of Polyfork's characters): the box is where they stand, not their model's, which is made arms out. */
  person?: true;
  back: number;
  front: number;
  right: number;
  left: number;
  top: number;
}

export const GSE_MODELS: Record<GseKind, GseModel> = {
  pushback: { id: 'pushback-tug-8eab46', back: -2.98, front: 2.98, right: -1.37, left: 1.37, top: 2.56 },
  towbar: { id: null, back: -0.5, front: 0.5, right: -0.12, left: 0.12, top: 0.62 },
  towbarless: { id: 'towbarless-pushback-tug-989602', back: -4.25, front: 4.25, right: -2.12, left: 2.12, top: 1.91 },
  power: { id: 'ground-power-unit-326361', back: -2.23, front: 2.24, right: -1.17, left: 1.17, top: 2.59 },
  loader: { id: 'belt-loader-3d84fd', back: -3.94, front: 3.95, right: -1.15, left: 1.15, top: 2.6 },
  kloader: { id: 'container-loader-254a74', back: -4.51, front: 4.5, right: -1.5, left: 1.5, top: 3.02 },
  bagtug: { id: 'baggage-tug-fb69f7', back: -1.5, front: 1.61, right: -0.7, left: 0.7, top: 2.07 },
  cart: { id: 'baggage-cart-b1bb82', back: -1.28, front: 1.87, right: -0.8, left: 0.8, top: 2.12 },
  dolly: { id: 'container-dolly-0e4b32', back: -1.58, front: 1.58, right: -0.81, left: 0.81, top: 0.9 },
  uld: { id: 'uld-container-a055c6', back: -0.78, front: 0.78, right: -1, left: 1, top: 1.64 },
  catering: { id: 'catering-truck-496150', back: -3.97, front: 5.25, right: -1.5, left: 1.5, top: 5.55 },
  hydrant: { id: 'hydrant-fuel-dispenser-b87cdb', back: -3.73, front: 3.27, right: -1.37, left: 1.91, top: 4.53 },
  tanker: { id: 'aviation-fuel-tanker-truck-37ed29', back: -5.45, front: 5.47, right: -1.48, left: 1.48, top: 3.62 },
  stairs: { id: 'airstairs-truck-de0f4b', back: -4.07, front: 4.15, right: -1.34, left: 1.34, top: 6.95 },
  // The same stairs, their platform brought down to a narrow-body's door (see LOW_STAIRS).
  stairsLow: { id: 'airstairs-truck-de0f4b', back: -4.07, front: 4.15, right: -1.34, left: 1.34, top: 4.79 },
  bus: { id: 'apron-passenger-bus-c46aef', back: -7.1, front: 7.31, right: -1.66, left: 1.66, top: 3.4 },
  lavatory: { id: 'lavatory-service-truck-023f33', back: -2.81, front: 2.8, right: -1.28, left: 1.34, top: 3.25 },
  // The ramp staff.
  handler: { id: 'baggage-handler-0823f5', person: true, back: -0.3, front: 0.3, right: -0.35, left: 0.35, top: 1.8 },
  fueller: { id: 'fuel-technician-df4ce0', person: true, back: -0.3, front: 0.3, right: -0.35, left: 0.35, top: 1.8 },
  engineer: { id: 'aircraft-maintenance-engineer-8bd28d', person: true, back: -0.3, front: 0.3, right: -0.35, left: 0.35, top: 1.8 },
  marshaller: { id: 'ground-marshaller-8e8631', person: true, back: -0.3, front: 0.3, right: -0.35, left: 0.35, top: 1.8 },
};

/**
 * The stairs truck is made for a wide-body's door, its platform 4.8 m up. For a narrow-body's the
 * layer draws it with everything above `from` metres pressed down so that the platform comes to
 * `to`: the stairs less steep and the cab lower, the wheels and chassis as they are.
 */
export const LOW_STAIRS = { from: 1.2, platform: 4.8, to: 3.45 };

/** What a piece is out for: it shows while that goes on. */
export type GseTask = 'push' | 'power' | 'bags' | 'catering' | 'fuel' | 'inspection' | 'lavatory' | 'stairs' | 'bus' | 'arrival';

/**
 * One piece of equipment: `along` metres from the middle of the aircraft towards its nose, `side`
 * to its left, standing `h` up, `turn` its heading from the aircraft's; a tow bar's `length`.
 */
export interface GsePlace {
  kind: GseKind;
  task: GseTask;
  along: number;
  side: number;
  h: number;
  turn: number;
  length?: number;
}

type RampJob = Pick<NonNullable<Aircraft['visit']['service']>['jobs']['fuel'], 'status'>;

/** What the placement needs to know of an aircraft and its visit. */
export interface Served {
  phase: Aircraft['phase'];
  type: Aircraft['type'];
  visit: Pick<Aircraft['visit'], 'onBlockAt' | 'doorsClosed' | 'deplaned' | 'boardingOpen'> & {
    rotation: Pick<Aircraft['visit']['rotation'], 'paxIn'>;
    service: { jobs: Record<'fuel' | 'inspection', RampJob> } | null;
  };
}

/** Seconds after reaching the stand that the marshaller still stands before it. */
const MARSHALLING = 90;
/** Metres ahead of the nose the marshaller stands. */
const MARSHAL_AHEAD = 9;
/** Seconds after reaching the stand that the lavatory truck is there. */
const LAVATORY = [240, 1500];
/** Room left between a piece and the fuselage it serves, and between pieces, metres. */
const GAP = 0.15;
const CLEAR = 0.6;
/** Length of the tow bar from the tug to the nose gear, metres, at least: long enough for the tug to stand clear ahead of the nose. */
const TOWBAR = 3.6;
/** How far into the towbarless tug's cradle the nose wheel sits, metres. */
const CRADLE = 1.1;
/** Gap between the cars of a train of carts or dollies, metres. */
const HITCH = 0.12;

/**
 * Where a piece's box is in the aircraft's frame when it stands at (along, side) turned `turn`: x
 * from x0 to x1 along the aircraft, y from y0 to y1 across. Turns are multiples of a right angle.
 */
export function boxOf(p: { kind: GseKind; along: number; side: number; turn: number; length?: number }): { x0: number; x1: number; y0: number; y1: number } {
  const m = GSE_MODELS[p.kind];
  const back = p.length ? -p.length / 2 : m.back;
  const front = p.length ? p.length / 2 : m.front;
  const c = Math.round(Math.cos(p.turn));
  const s = Math.round(Math.sin(p.turn));
  // Forward along (c, s), left along (-s, c).
  const xs = [back, front].flatMap((u) => [m.right, m.left].map((v) => p.along + u * c - v * s));
  const ys = [back, front].flatMap((u) => [m.right, m.left].map((v) => p.side + u * s + v * c));
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** A train behind a tug, all heading `turn` (0 or a half turn), the tug's front at `head` along the aircraft, its middle line `side` across. */
function train(out: GsePlace[], task: GseTask, car: 'cart' | 'dolly', count: number, head: number, side: number, turn: number): void {
  const dir = Math.round(Math.cos(turn));
  const tug = GSE_MODELS.bagtug;
  const one = GSE_MODELS[car];
  let along = head - dir * tug.front;
  out.push({ kind: 'bagtug', task, along, side, h: 0, turn });
  let tail = along + dir * tug.back;
  for (let k = 0; k < count; k += 1) {
    along = tail - dir * (HITCH + one.front);
    out.push({ kind: car, task, along, side, h: 0, turn });
    if (car === 'dolly') {
      // Two containers to a dolly, one behind the other, on its deck.
      for (const u of [-0.8, 0.8]) out.push({ kind: 'uld', task, along: along + dir * u, side, h: 0.5, turn });
    }
    tail = along + dir * one.back;
  }
}

/** Length of a train of a tug and `count` cars, metres. */
function trainLength(car: 'cart' | 'dolly', count: number): number {
  const tug = GSE_MODELS.bagtug;
  const one = GSE_MODELS[car];
  return tug.front - tug.back + count * (HITCH + one.front - one.back);
}

const layouts = new Map<string, GsePlace[]>();

/**
 * Every piece an aircraft of a type can have out while parked, laid out once: on the right the
 * loaders and their trains, catering, fuel, power and the lavatory truck; on the left, at a stand
 * with no jet bridge, stairs and a bus.
 */
export function turnaroundLayout(type: Aircraft['type'], remote: boolean): readonly GsePlace[] {
  const key = `${type.id}:${remote ? 'remote' : 'bridge'}`;
  const known = layouts.get(key);
  if (known) return known;
  const f = airframe(type);
  const out: GsePlace[] = [];
  const L = type.length;
  const ry = f.ry;
  const wide = type.body === 'wide' || type.body === 'super';
  const put = (task: GseTask, kind: GseKind, along: number, side: number, turn: number, h = 0): void => {
    out.push({ kind, task, along, side, h, turn });
  };
  // Facing the fuselage from the right, front first or back first, an end GAP off its side.
  const frontIn = (task: GseTask, kind: GseKind, along: number): void => put(task, kind, along, -ry - GAP - GSE_MODELS[kind].front, Math.PI / 2);
  const backIn = (task: GseTask, kind: GseKind, along: number): void => put(task, kind, along, -ry - GAP + GSE_MODELS[kind].back, -Math.PI / 2);

  // Ground power ahead of the nose gear, on the right.
  put('power', 'power', f.noseGearX + 1.5, -(ry + 1.4 + GSE_MODELS.power.left), 0);
  // An engineer between the power unit and the fuselage, facing the aircraft; the marshaller ahead
  // of the nose, facing it, while the aircraft comes onto the stand.
  put('inspection', 'engineer', f.noseGearX + 1.5, -(ry + 0.7), Math.PI / 2);
  put('arrival', 'marshaller', f.half + MARSHAL_AHEAD, 0, Math.PI);

  // Catering at the right rear door: behind the wing, whose trailing edge sweeps back further the
  // further out it is, and ahead of the tail.
  const catering = GSE_MODELS.catering;
  const cateringHalf = (catering.left - catering.right) / 2;
  const wingOut = wingOver(type, ry + GAP + (catering.front - catering.back));
  const rear = Math.min(f.doors.rear.x, wingOut ? wingOut.trail - cateringHalf - CLEAR : Infinity);
  frontIn('catering', 'catering', rear);

  // Bags: a narrow-body's belt loader at the aft hold, ahead of the catering truck; a wide-body's
  // container loaders at both holds; each with its train out beyond the loader's end and the
  // catering truck's.
  const loader: GseKind = wide ? 'kloader' : 'loader';
  const loaderHalf = (GSE_MODELS[loader].left - GSE_MODELS[loader].right) / 2;
  const holds = wide ? [0.25 * L, -0.22 * L] : [Math.max(-0.21 * L, rear + cateringHalf + CLEAR + loaderHalf)];
  for (const hold of holds) {
    if (wide) backIn('bags', loader, hold);
    else frontIn('bags', loader, hold);
  }
  const reach = Math.max(GSE_MODELS[loader].front - GSE_MODELS[loader].back, catering.front - catering.back, GSE_MODELS.lavatory.front - GSE_MODELS.lavatory.back) + GAP;
  const car = wide ? 'dolly' : 'cart';
  // Half the train's width: the containers stand out over a dolly's sides.
  const width = wide ? Math.max(GSE_MODELS.dolly.left, GSE_MODELS.uld.left) : GSE_MODELS.cart.left;
  const line = -(ry + reach + CLEAR + width);
  const cars = 3;
  for (const hold of holds) {
    // A forward hold's train stands ahead of it, heading for the nose; an aft hold's behind it, heading for the tail.
    const ahead = hold > 0;
    const length = trainLength(car, cars);
    const head = ahead ? hold - 1.2 + length : hold + 1.2 - length;
    train(out, 'bags', car, cars, head, line, ahead ? 0 : Math.PI);
    // A baggage handler beside the loader's outer end, facing it.
    put('bags', 'handler', hold + loaderHalf + 0.6, -(ry + GAP + (GSE_MODELS[loader].front - GSE_MODELS[loader].back) - 1.2), Math.PI);
  }

  // The lavatory truck backs up to the tail cone, behind the catering truck.
  const lavatory = GSE_MODELS.lavatory;
  backIn('lavatory', 'lavatory', rear - cateringHalf - CLEAR - lavatory.left);

  // Fuel under the right wing, outboard of the engine, where the wing is high enough to clear the
  // truck; under a low wing, just ahead of its leading edge instead.
  const fuel: GseKind = remote ? 'tanker' : 'hydrant';
  const truck = GSE_MODELS[fuel];
  // Outboard of the inner engine (between the two of an A380's); at a wide-body, whose forward
  // hold's train stands out ahead of the wing, outboard of the trains as well.
  const engine = f.sides[1].engines.reduce((near, e) => Math.min(near, Math.abs(e.y) + e.radius), Infinity);
  const inner = Math.max(engine, wide ? -line + width : 0) + CLEAR;
  const side = -(inner + truck.left);
  const near = wingOver(type, inner);
  const far = wingOver(type, inner + truck.left - truck.right);
  const under = Math.min(near?.under ?? Infinity, far?.under ?? Infinity);
  if (under > truck.top + 0.3) put('fuel', fuel, Math.min(near?.lead ?? 0, far?.lead ?? 0) - 1 - truck.front, side, 0);
  else put('fuel', fuel, Math.max(near?.lead ?? -Infinity, far?.lead ?? -Infinity) + CLEAR - truck.back, side, 0);
  // The fuel technician at the back of the truck, where its hose is, facing it.
  const placed = out[out.length - 1];
  put('fuel', 'fueller', placed.along + truck.back - 0.7, side + (truck.left + truck.right) / 2, 0);

  if (remote) {
    // Stairs at the front left door, and for a narrow-body at the rear left door too; a bus out beyond them.
    const stairs: GseKind = wide ? 'stairs' : 'stairsLow';
    const s = GSE_MODELS[stairs];
    // At the doors of the aircraft as drawn (src/shared/airframe.ts).
    const door = f.doors.front.x;
    const onLeft = (along: number): void => put('stairs', stairs, along, ry + GAP + s.front, -Math.PI / 2);
    onLeft(door);
    if (!wide) onLeft(f.doors.rear.x);
    // The bus alongside, its front a little ahead of the door and its back clear ahead of the
    // wing's leading edge, which sweeps forward the nearer the fuselage it is.
    const bus = GSE_MODELS.bus;
    const busSide = ry + GAP + (s.front - s.back) + CLEAR + 1 - bus.right;
    const busLead = Math.max(wingOver(type, busSide + bus.right)?.lead ?? -Infinity, wingOver(type, busSide + bus.left)?.lead ?? -Infinity);
    put('bus', 'bus', Math.max(door + 3 - bus.front, busLead + CLEAR - bus.back), busSide, 0);
  }
  layouts.set(key, out);
  return out;
}

const pushes = new Map<string, GsePlace[]>();

/** The tug that pushes an aircraft of a type back: a wide-body's lifts its nose wheel in its cradle, a narrow-body's pushes on a tow bar. */
export function pushbackLayout(type: Aircraft['type']): readonly GsePlace[] {
  const known = pushes.get(type.id);
  if (known) return known;
  const f = airframe(type);
  const wide = type.body === 'wide' || type.body === 'super';
  const out: GsePlace[] = [];
  if (wide) {
    // Heading the way the aircraft heads, the nose wheel in the cradle at its back.
    out.push({ kind: 'towbarless', task: 'push', along: f.noseGearX - CRADLE - GSE_MODELS.towbarless.back, side: 0, h: 0, turn: 0 });
  } else {
    // Facing the aircraft, the bar from its front to the nose gear.
    const bar = Math.max(TOWBAR, f.half - f.noseGearX + CLEAR);
    out.push({ kind: 'towbar', task: 'push', along: f.noseGearX + bar / 2, side: 0, h: 0, turn: 0, length: bar });
    out.push({ kind: 'pushback', task: 'push', along: f.noseGearX + bar + GSE_MODELS.pushback.front, side: 0, h: 0, turn: Math.PI });
  }
  pushes.set(type.id, out);
  return out;
}

/** Is a piece's task going on at `now`? */
function busy(task: GseTask, a: Served, now: number, remote: boolean): boolean {
  const v = a.visit;
  const onStand = now - v.onBlockAt;
  switch (task) {
    case 'power':
    case 'stairs':
      return true;
    case 'bags':
      return !v.doorsClosed;
    case 'catering':
      return v.deplaned >= v.rotation.paxIn && !v.boardingOpen && !v.doorsClosed;
    case 'fuel':
    case 'inspection':
      return v.service?.jobs[task].status === 'working';
    case 'lavatory':
      return onStand > LAVATORY[0] && onStand < LAVATORY[1];
    case 'arrival':
      return onStand >= 0 && onStand < MARSHALLING;
    case 'bus':
      // Bringing the passengers off, and taking them out to board.
      return remote && (v.deplaned < v.rotation.paxIn || (v.boardingOpen && !v.doorsClosed));
    default:
      return false;
  }
}

/** The equipment round an aircraft at `now`, added to `out`; `remote` when its stand has no jet bridge. */
export function gseAround(a: Served, now: number, remote: boolean, out: GsePlace[] = []): GsePlace[] {
  if (a.phase === 'pushback' || a.phase === 'starting') {
    out.push(...pushbackLayout(a.type));
    return out;
  }
  if (a.phase !== 'parked') return out;
  for (const p of turnaroundLayout(a.type, remote)) if (busy(p.task, a, now, remote)) out.push(p);
  return out;
}
