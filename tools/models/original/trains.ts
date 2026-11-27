// Our own models of the BART and Caltrain cars, which Polyfork has none of: made with the kit in
// Polyfork's manner, flat-coloured low-poly solids with colour slots the app can change and doors
// that open as an animation. Each car is as long and wide as the simulation's (CONFIG.transit.cars),
// less the gap between cars, so that what is drawn is what keeps trains on tracks side by side
// apart. A cab car has a driving cab at its front (+z); the others end in gangways.

import { CONFIG } from '../../../src/sim/config.ts';
import { ModelKit, type V3 } from './kit.ts';

/** Gap between two cars coupled, metres: half at each end. */
const GAP = 0.7;
/**
 * How far the doors stand out from the shell at most, open, metres: the bands a hair proud, the leaves
 * 3 cm beyond them, their windows 1 cm more, and 6 cm more as they ease out to slide.
 */
const PROUD = 0.12;
/** Frames of a door opening, closed to open. */
const DOOR_FRAMES = 6;

interface CarDesign {
  length: number;
  width: number;
  /** Height of the floor and of the roof's edge and crown above the rail. */
  floor: number;
  eave: number;
  crown: number;
  /** Where the doors are along the car (their middles), how wide each leaf is, and how far it slides. */
  doors: number[];
  leaf: number;
  /** Rows of windows: their sill and head heights. */
  windows: [number, number][];
  /** The stripe under the windows: from and to heights. */
  stripe: [number, number];
  colours: { body: number; stripe: number; glass: number; door: number; roof: number; chassis: number; bogie: number; light: number };
  /** A pantograph on the roof at this point along the car. */
  pantograph?: number;
}

/** The car's section, from the right side's bottom round over the roof: (x, y) counter-clockwise seen from the front. */
function section(d: CarDesign, inset = 0): [number, number][] {
  const w = d.width / 2 - inset;
  const bottom = d.floor - 0.35;
  return [
    [-w + 0.12, bottom],
    [w - 0.12, bottom],
    [w, bottom + 0.3],
    [w, d.eave - 0.2],
    [w - 0.25, d.eave + 0.08],
    [w * 0.45, d.crown],
    [-w * 0.45, d.crown],
    [-w + 0.25, d.eave + 0.08],
    [-w, d.eave - 0.2],
    [-w, bottom + 0.3],
  ];
}

function car(kit: ModelKit, d: CarDesign, cab: boolean): void {
  const s = {
    body: kit.colour('body', d.colours.body),
    stripe: kit.colour('stripe', d.colours.stripe),
    glass: kit.colour('glass', d.colours.glass),
    door: kit.colour('door', d.colours.door),
    roof: kit.colour('roof', d.colours.roof),
    chassis: kit.colour('chassis', d.colours.chassis),
    bogie: kit.colour('bogie', d.colours.bogie),
    light: kit.colour('light', d.colours.light),
  };
  const half = (d.length - GAP) / 2;
  // The shell stands in from the car's width by as much as the doors stand proud of it, open: the
  // car as drawn, doors and all, is no wider than the simulation keeps trains apart by.
  const outline = section(d, PROUD);
  // The shell: a gangway end at the back; at the front a gangway end, or a cab sloping in to its windscreen.
  const back = -half;
  const front = cab ? half - 1.6 : half;
  const ring = (z: number, scale = 1, lift = 0): V3[] => outline.map(([x, y]): V3 => [x * scale, (y - d.floor) * scale + d.floor + lift, z]);
  // Faces of the shell by the side they are on: 0, 1 the underside; 2..4 and 8, 9 the sides; 5..7 the roof.
  const shellSlot = (band: number, side: number): number => (side >= 4 && side <= 7 ? s.roof : side <= 1 ? s.chassis : s.body);
  const rings = [ring(back), ring(front)];
  if (cab) {
    rings.push(ring(half - 0.6, 0.94, -0.05), ring(half, 0.8, -0.2));
  }
  kit.loft(0, rings, (band, side) => (cab && band === 2 && side >= 3 && side <= 8 ? s.glass : shellSlot(band, side)), [s.body, cab ? s.body : s.body]);
  // The stripe and the window bands, standing a hair proud of each side.
  const w = d.width / 2 - PROUD + 0.01;
  const bandFront = cab ? half - 1.7 : half - 0.4;
  for (const side of [1, -1]) {
    const x = side * w;
    const face = (y0: number, y1: number, z0: number, z1: number, slot: number): void => {
      const a: V3 = [x, y0, z0];
      const b: V3 = [x, y0, z1];
      const c: V3 = [x, y1, z1];
      const e: V3 = [x, y1, z0];
      if (side > 0) kit.quad(0, slot, b, a, e, c);
      else kit.quad(0, slot, a, b, c, e);
    };
    face(d.stripe[0], d.stripe[1], back + 0.4, bandFront, s.stripe);
    // Windows between the doors.
    const edges = [back + 0.6, ...d.doors.flatMap((z) => [z - d.leaf - 0.25, z + d.leaf + 0.25]), bandFront - 0.2];
    for (let k = 0; k + 1 < edges.length; k += 2) {
      for (const [sill, head] of d.windows) if (edges[k + 1] - edges[k] > 0.8) face(sill, head, edges[k], edges[k + 1], s.glass);
    }
    // The doors: each a pair of leaves, each its own part, sliding apart along the car.
    for (const [n, z] of d.doors.entries()) {
      for (const dir of [-1, 1]) {
        const name = `door-${side > 0 ? 'l' : 'r'}${n + 1}-${dir < 0 ? 'b' : 'f'}`;
        const bone = kit.part(name, [x, d.floor, z]);
        const z0 = dir < 0 ? z - d.leaf : z;
        const z1 = dir < 0 ? z : z + d.leaf;
        const y0 = d.floor;
        const y1 = d.eave - 0.15;
        const x1 = x + side * 0.03;
        const quad = (slot: number, ya: number, yb: number): void => {
          const a: V3 = [x1, ya, z0];
          const b: V3 = [x1, ya, z1];
          const c: V3 = [x1, yb, z1];
          const e: V3 = [x1, yb, z0];
          if (side > 0) kit.quad(bone, slot, b, a, e, c);
          else kit.quad(bone, slot, a, b, c, e);
        };
        quad(s.door, y0, y1);
        // A window in each leaf.
        const xg = x1 + side * 0.01;
        const g0 = d.windows[0][0];
        const g1 = Math.min(d.windows[0][1], y1 - 0.2);
        const ga: V3 = [xg, g0, z0 + 0.15];
        const gb: V3 = [xg, g0, z1 - 0.15];
        const gc: V3 = [xg, g1, z1 - 0.15];
        const ge: V3 = [xg, g1, z0 + 0.15];
        if (side > 0) kit.quad(bone, s.glass, gb, ga, ge, gc);
        else kit.quad(bone, s.glass, ga, gb, gc, ge);
      }
    }
  }
  // Bogies and the underframe between them.
  for (const z of [back + 3.2, half - 3.2]) {
    kit.box(0, s.bogie, [-d.width / 2 + 0.35, 0.15, z - 1.4], [d.width / 2 - 0.35, d.floor - 0.4, z + 1.4]);
    for (const wz of [z - 1.05, z + 1.05]) for (const x of [-0.78, 0.78]) kit.cylinder(0, s.chassis, [x - 0.12, 0.45, wz], [x + 0.12, 0.45, wz], 0.45, 8);
  }
  kit.box(0, s.chassis, [-d.width / 2 + 0.5, d.floor - 0.6, back + 4.8], [d.width / 2 - 0.5, d.floor - 0.35, half - 4.8]);
  // A cab's headlights; the gangway ends' doors.
  if (cab) {
    for (const x of [-0.9, 0.9]) kit.box(0, s.light, [x - 0.18, d.floor + 0.25, half - 0.05], [x + 0.18, d.floor + 0.45, half + 0.02]);
  }
  for (const z of cab ? [back] : [back, half]) {
    const dir = z > 0 ? 1 : -1;
    kit.box(0, s.door, [-0.45, d.floor, z - dir * 0.02], [0.45, d.eave - 0.25, z + dir * 0.03]);
  }
  if (d.pantograph !== undefined) {
    // A pantograph folded down on its base, and the roof equipment beside it.
    const z = d.pantograph;
    kit.box(0, s.chassis, [-0.7, d.crown, z - 1.2], [0.7, d.crown + 0.25, z + 1.2]);
    kit.cylinder(0, s.chassis, [-0.6, d.crown + 0.45, z - 0.9], [-0.6, d.crown + 0.45, z + 0.9], 0.05, 6);
    kit.cylinder(0, s.chassis, [0.6, d.crown + 0.45, z - 0.9], [0.6, d.crown + 0.45, z + 0.9], 0.05, 6);
    kit.box(0, s.chassis, [-0.85, d.crown + 0.5, z + 0.8], [0.85, d.crown + 0.56, z + 1.0]);
  }
  // The doors open: each leaf eases out from the side and slides away from the door's middle.
  for (let f = 1; f <= DOOR_FRAMES; f += 1) {
    const t = f / DOOR_FRAMES;
    const moves: Record<string, { slide: V3 }> = {};
    for (const side of ['l', 'r']) {
      for (const [n] of d.doors.entries()) {
        for (const leaf of ['b', 'f']) {
          const out = Math.min(1, t * 3) * 0.06 * (side === 'l' ? 1 : -1);
          const along = Math.max(0, (t - 0.2) / 0.8) * (d.leaf - 0.1) * (leaf === 'b' ? -1 : 1);
          moves[`door-${side}${n + 1}-${leaf}`] = { slide: [out, 0, along] };
        }
      }
    }
    kit.pose('doors', moves);
  }
}

const bartSize = CONFIG.transit.cars.bart;
const caltrainSize = CONFIG.transit.cars.caltrain;

const BART: CarDesign = {
  length: bartSize.length,
  width: bartSize.width,
  floor: 1.05,
  eave: 3.55,
  crown: 3.85,
  doors: [-6.2, 0, 6.2],
  leaf: 0.65,
  windows: [[2.0, 3.0]],
  stripe: [1.55, 1.85],
  colours: { body: 0xd9dde0, stripe: 0x1d5fa8, glass: 0x1e2a33, door: 0x2a73c2, roof: 0xb7bec4, chassis: 0x2b2f33, bogie: 0x3a3e42, light: 0xfff2c8 },
};

const CALTRAIN: CarDesign = {
  length: caltrainSize.length,
  width: caltrainSize.width,
  floor: 0.6,
  eave: 4.35,
  crown: 4.7,
  doors: [-8.2, 8.2],
  leaf: 0.7,
  windows: [[1.25, 2.05], [2.95, 3.85]],
  stripe: [0.85, 1.1],
  colours: { body: 0xe3e5e7, stripe: 0xb3262d, glass: 0x1c2730, door: 0xb3262d, roof: 0x9aa1a7, chassis: 0x2b2f33, bogie: 0x3a3e42, light: 0xfff2c8 },
};

export interface OriginalSpec {
  id: string;
  name: string;
  category: string;
  build: () => ModelKit;
}

export const TRAIN_MODELS: OriginalSpec[] = [
  { id: 'rapid-transit-car', name: 'Rapid Transit Car', category: 'vehicle', build: () => { const k = new ModelKit(); car(k, BART, false); return k; } },
  { id: 'rapid-transit-cab-car', name: 'Rapid Transit Cab Car', category: 'vehicle', build: () => { const k = new ModelKit(); car(k, BART, true); return k; } },
  { id: 'bilevel-commuter-car', name: 'Bilevel Commuter Car', category: 'vehicle', build: () => { const k = new ModelKit(); car(k, { ...CALTRAIN, pantograph: 4 }, false); return k; } },
  { id: 'bilevel-commuter-cab-car', name: 'Bilevel Commuter Cab Car', category: 'vehicle', build: () => { const k = new ModelKit(); car(k, CALTRAIN, true); return k; } },
];
