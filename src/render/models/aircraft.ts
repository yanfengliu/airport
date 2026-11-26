// Procedural airliners, one geometry pair per type at true size. The "body" mesh carries its own
// colours (white fuselage, grey wings, dark glass); the "livery" mesh is white and takes the
// airline's colour per aircraft: the fin, the rear fuselage and the engine cowls.
//
// Body frame: x forward, y to the left wing, z up, origin on the ground under the middle of the
// fuselage. The builder turns that into three.js axes (forward +X, up +Y, right wing +Z).

import * as THREE from 'three';
import type { AircraftType } from '../../sim/fleet.ts';
import { MeshBuilder, rgb, type RGB } from '../builder.ts';

interface Shape {
  /** Where the wing's leading edge meets the fuselage, as a fraction of length behind the nose. */
  wingAt: number;
  /** Leading-edge sweep, radians; root chord as a fraction of span; tip chord as a fraction of root. */
  sweep: number;
  rootChord: number;
  taper: number;
  /** Engine nacelle radius and length, metres; where along the half-span each engine hangs. */
  engineRadius: number;
  engineLength: number;
  engineAt: number[];
  /** Height of the wing-tip device, metres; 0 for a raked tip. */
  winglet: number;
  /** Fuselage height over width, for a double deck. */
  tall: number;
}

const NARROW: Shape = { wingAt: 0.37, sweep: 0.47, rootChord: 0.185, taper: 0.24, engineRadius: 1.15, engineLength: 4.4, engineAt: [0.33], winglet: 2.4, tall: 1 };
const WIDE: Shape = { wingAt: 0.34, sweep: 0.58, rootChord: 0.2, taper: 0.16, engineRadius: 1.75, engineLength: 6.6, engineAt: [0.32], winglet: 0, tall: 1 };

const SHAPES: Record<string, Shape> = {
  E75L: { ...NARROW, wingAt: 0.39, engineRadius: 0.88, engineLength: 3.4, winglet: 1.9, rootChord: 0.17 },
  BCS3: { ...NARROW, engineRadius: 1.08, engineLength: 4, winglet: 2 },
  A320: NARROW,
  A21N: { ...NARROW, wingAt: 0.39, engineRadius: 1.2, engineLength: 4.7 },
  B738: { ...NARROW, wingAt: 0.38, engineRadius: 1.05, winglet: 2.5 },
  B39M: { ...NARROW, wingAt: 0.39, engineRadius: 1.15, winglet: 2.6 },
  B752: { ...NARROW, wingAt: 0.4, engineRadius: 1.25, engineLength: 4.8, winglet: 2.2, sweep: 0.46 },
  B789: { ...WIDE, engineRadius: 1.72, winglet: 0, sweep: 0.6 },
  A359: { ...WIDE, engineRadius: 1.8, winglet: 2.2 },
  B77W: { ...WIDE, wingAt: 0.36, engineRadius: 1.95, engineLength: 7.3 },
  A388: { ...WIDE, wingAt: 0.33, rootChord: 0.21, engineRadius: 1.6, engineLength: 6, engineAt: [0.3, 0.56], winglet: 2.2, tall: 1.19, sweep: 0.6 },
};

const WHITE: RGB = [1, 1, 1];
const FUSELAGE = rgb(0xf3f4f6);
const BELLY = rgb(0xc9cdd3);
const WING = rgb(0xb9bec6);
const GLASS = rgb(0x1c2630);
const TYRE = rgb(0x24262a);
const STRUT = rgb(0x8d939b);
const METAL = rgb(0x6f757d);

type V3 = [number, number, number];

/** A flat four-sided face with its own normal; corners counter-clockwise seen from outside. */
function face(b: MeshBuilder, p0: V3, p1: V3, p2: V3, p3: V3, c: RGB): void {
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const uz = p1[2] - p0[2];
  const vx = p3[0] - p0[0];
  const vy = p3[1] - p0[1];
  const vz = p3[2] - p0[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const a = b.vertex(p0[0], p0[1], p0[2], nx, ny, nz, c);
  const bb = b.vertex(p1[0], p1[1], p1[2], nx, ny, nz, c);
  const cc = b.vertex(p2[0], p2[1], p2[2], nx, ny, nz, c);
  const d = b.vertex(p3[0], p3[1], p3[2], nx, ny, nz, c);
  b.quad(a, bb, cc, d);
}

/**
 * A lifting surface: a tapered slab from a root section to a tip section. Each section is given
 * by its leading-edge point, chord (running back along -x) and thickness.
 */
function surface(b: MeshBuilder, rootLE: V3, rootChord: number, rootThick: number, tipLE: V3, tipChord: number, tipThick: number, c: RGB, vertical = false): void {
  const section = (le: V3, chord: number, thick: number): V3[] => {
    const up: V3 = vertical ? [0, thick / 2, 0] : [0, 0, thick / 2];
    const mid = chord * 0.32;
    return [
      [le[0], le[1], le[2]],
      [le[0] - mid + up[0], le[1] + up[1], le[2] + up[2]],
      [le[0] - chord, le[1], le[2]],
      [le[0] - mid - up[0], le[1] - up[1], le[2] - up[2]],
    ];
  };
  const r = section(rootLE, rootChord, rootThick);
  const t = section(tipLE, tipChord, tipThick);
  // Four skins round the diamond section, then the tip cap. Winding is fixed up by `skin`.
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    skin(b, r[i], r[j], t[j], t[i], c, [(r[0][0] + r[2][0] + t[0][0] + t[2][0]) / 4, (r[0][1] + t[0][1]) / 2, (r[0][2] + t[0][2]) / 2]);
  }
  skin(b, t[0], t[1], t[2], t[3], c, [(r[0][0] + r[2][0]) / 2, r[0][1], r[0][2]]);
}

/** A face wound so that it points away from `inside`. */
function skin(b: MeshBuilder, p0: V3, p1: V3, p2: V3, p3: V3, c: RGB, inside: V3): void {
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const uz = p1[2] - p0[2];
  const vx = p3[0] - p0[0];
  const vy = p3[1] - p0[1];
  const vz = p3[2] - p0[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4 - inside[0];
  const cy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4 - inside[1];
  const cz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4 - inside[2];
  if (nx * cx + ny * cy + nz * cz >= 0) face(b, p0, p1, p2, p3, c);
  else face(b, p0, p3, p2, p1, c);
}

/** A tube along x through a list of stations: x, centre height, half-width, half-height. */
function tube(b: MeshBuilder, stations: [number, number, number, number][], segments: number, colour: (station: number, angle: number) => RGB): void {
  let previous: number[] | null = null;
  for (let s = 0; s < stations.length; s += 1) {
    const [x, zc, ry, rz] = stations[s];
    const ring: number[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const angle = (k / segments) * Math.PI * 2;
      const cy = Math.cos(angle);
      const sz = Math.sin(angle);
      // Outward normal of an ellipse, leaning along x where the tube narrows.
      let nx = 0;
      if (s > 0 && s < stations.length - 1) nx = -(stations[s + 1][2] - stations[s - 1][2]) / Math.max(0.01, stations[s + 1][0] - stations[s - 1][0]);
      else nx = s === 0 ? -1 : 1;
      const ny = cy / Math.max(0.05, ry);
      const nz = sz / Math.max(0.05, rz);
      const len = Math.hypot(nx * 0.5, ny, nz) || 1;
      ring.push(b.vertex(x, cy * ry, zc + sz * rz, (nx * 0.5) / len, ny / len, nz / len, colour(s, angle)));
    }
    if (previous) {
      for (let k = 0; k < segments; k += 1) {
        // Stations run from tail to nose (x increasing) and the angle from y round to z, so this
        // order is counter-clockwise seen from outside.
        b.quad(previous[k], previous[k + 1], ring[k + 1], ring[k]);
      }
    }
    previous = ring;
  }
}

function wheel(b: MeshBuilder, x: number, y: number, radius: number, width: number): void {
  const stations: [number, number, number, number][] = [];
  for (let i = 0; i <= 1; i += 1) stations.push([x - radius + i * 2 * radius, radius, width / 2, radius]);
  // A wheel is a short fat tube across y; build it as a box for cheapness.
  const x0 = x - radius * 0.9;
  const x1 = x + radius * 0.9;
  const y0 = y - width / 2;
  const y1 = y + width / 2;
  const z1 = radius * 2;
  const inside: V3 = [x, y, radius];
  skin(b, [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], TYRE, inside);
  skin(b, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], TYRE, inside);
  skin(b, [x0, y0, 0], [x1, y0, 0], [x1, y0, z1], [x0, y0, z1], TYRE, inside);
  skin(b, [x0, y1, 0], [x1, y1, 0], [x1, y1, z1], [x0, y1, z1], TYRE, inside);
  skin(b, [x0, y0, 0], [x0, y1, 0], [x0, y1, z1], [x0, y0, z1], TYRE, inside);
  skin(b, [x1, y0, 0], [x1, y1, 0], [x1, y1, z1], [x1, y0, z1], TYRE, inside);
  void stations;
}

function strut(b: MeshBuilder, x: number, y: number, z0: number, z1: number, half: number): void {
  const inside: V3 = [x, y, (z0 + z1) / 2];
  skin(b, [x - half, y - half, z0], [x + half, y - half, z0], [x + half, y - half, z1], [x - half, y - half, z1], STRUT, inside);
  skin(b, [x - half, y + half, z0], [x + half, y + half, z0], [x + half, y + half, z1], [x - half, y + half, z1], STRUT, inside);
  skin(b, [x - half, y - half, z0], [x - half, y + half, z0], [x - half, y + half, z1], [x - half, y - half, z1], STRUT, inside);
  skin(b, [x + half, y - half, z0], [x + half, y + half, z0], [x + half, y + half, z1], [x + half, y - half, z1], STRUT, inside);
}

export interface AircraftGeometry {
  body: THREE.BufferGeometry;
  livery: THREE.BufferGeometry;
  /** Lights in three.js model space: nose, tail, left tip, right tip, beacon. */
  lights: { nose: THREE.Vector3; tail: THREE.Vector3; left: THREE.Vector3; right: THREE.Vector3; beacon: THREE.Vector3 };
}

export function buildAircraftGeometry(type: AircraftType): AircraftGeometry {
  const shape = SHAPES[type.id] ?? (type.body === 'wide' || type.body === 'super' ? WIDE : NARROW);
  const body = new MeshBuilder();
  const livery = new MeshBuilder();
  const L = type.length;
  const half = L / 2;
  const ry = type.fuselage / 2;
  const rz = ry * shape.tall;
  // The fuselage rides on its gear: belly clear of the ground by roughly half its width.
  const zc = rz + Math.max(1.35, ry * 0.92);
  const noseLength = type.fuselage * 1.55;
  const tailLength = type.fuselage * 2.9;

  // ---- fuselage: stations from the tail cone to the nose ----------------------------------
  const stations: [number, number, number, number][] = [];
  const tailSteps = 6;
  for (let i = 0; i <= tailSteps; i += 1) {
    const t = i / tailSteps;
    const fat = Math.pow(t, 0.72);
    // The tail cone tapers and sweeps up so the aircraft can rotate without scraping.
    stations.push([-half + tailLength * t, zc + rz * 0.62 * (1 - fat), Math.max(0.18, ry * fat), Math.max(0.24, rz * (0.3 + 0.7 * fat))]);
  }
  const noseSteps = 6;
  const noseStart = half - noseLength;
  stations.push([(-half + tailLength + noseStart) / 2, zc, ry, rz]);
  for (let i = 0; i <= noseSteps; i += 1) {
    const t = i / noseSteps;
    const r = Math.sqrt(Math.max(0, 1 - t * t));
    stations.push([noseStart + noseLength * t, zc - rz * 0.16 * t * t, Math.max(0.12, ry * r), Math.max(0.12, rz * r)]);
  }
  const liveryFrom = 2;
  const fuselageColour = (station: number, angle: number): RGB => (Math.sin(angle) < -0.45 ? BELLY : FUSELAGE);
  tube(body, stations.slice(liveryFrom), 14, (station, angle) => fuselageColour(station, angle));
  tube(livery, stations.slice(0, liveryFrom + 1), 14, () => WHITE);

  // Cabin windows as a dark stripe each side, and the flight deck glazing.
  const stripeZ = zc + rz * 0.22;
  const stripeFrom = -half + tailLength * 0.95;
  const stripeTo = noseStart + noseLength * 0.18;
  for (const side of [1, -1]) {
    const y = side * (ry * 0.985 + 0.02);
    const p0: V3 = [stripeFrom, y, stripeZ - 0.2];
    const p1: V3 = [stripeTo, y, stripeZ - 0.2];
    const p2: V3 = [stripeTo, y, stripeZ + 0.2];
    const p3: V3 = [stripeFrom, y, stripeZ + 0.2];
    skin(body, p0, p1, p2, p3, GLASS, [0, 0, zc]);
    if (shape.tall > 1.05) {
      const up = rz * 0.62;
      skin(body, [stripeFrom + 4, side * (ry * 0.86), zc + up - 0.2], [stripeTo - 6, side * (ry * 0.86), zc + up - 0.2], [stripeTo - 6, side * (ry * 0.86), zc + up + 0.2], [stripeFrom + 4, side * (ry * 0.86), zc + up + 0.2], GLASS, [0, 0, zc]);
    }
  }
  const deckX = noseStart + noseLength * 0.52;
  skin(body, [deckX - 0.9, -ry * 0.62, zc + rz * 0.5], [deckX + 0.7, -ry * 0.42, zc + rz * 0.34], [deckX + 0.7, ry * 0.42, zc + rz * 0.34], [deckX - 0.9, ry * 0.62, zc + rz * 0.5], GLASS, [deckX - 2, 0, zc - rz]);

  // ---- wings ----------------------------------------------------------------------------
  const semi = type.span / 2;
  const rootChord = type.span * shape.rootChord;
  const tipChord = rootChord * shape.taper;
  const wingX = half - L * shape.wingAt;
  const wingZ = zc - rz * 0.62;
  const dihedral = 0.1;
  const tipX = wingX - Math.tan(shape.sweep) * (semi - ry * 0.6);
  const tipZ = wingZ + Math.tan(dihedral) * (semi - ry * 0.6);
  for (const side of [1, -1]) {
    const root: V3 = [wingX, side * ry * 0.6, wingZ];
    const tip: V3 = [tipX, side * semi, tipZ];
    surface(body, root, rootChord, rootChord * 0.13, tip, tipChord, tipChord * 0.1, WING);
    if (shape.winglet > 0) {
      surface(livery, [tipX, side * semi, tipZ], tipChord, 0.14, [tipX - shape.winglet * 0.7, side * (semi + shape.winglet * 0.18), tipZ + shape.winglet], tipChord * 0.45, 0.08, WHITE, true);
    }
    // Engines hang ahead of and below the wing.
    for (const at of shape.engineAt) {
      const y = side * semi * at;
      const along = (Math.abs(y) - ry * 0.6) / (semi - ry * 0.6);
      const leX = wingX + (tipX - wingX) * along;
      const leZ = wingZ + (tipZ - wingZ) * along;
      const r = shape.engineRadius;
      const front = leX + shape.engineLength * 0.62;
      const back = front - shape.engineLength;
      const ez = Math.max(r + 0.55, leZ - r * 0.95);
      const nacelle: [number, number, number, number][] = [
        [back, ez, r * 0.5, r * 0.5],
        [back + shape.engineLength * 0.35, ez, r * 0.86, r * 0.86],
        [front - shape.engineLength * 0.18, ez, r, r],
        [front, ez, r * 0.92, r * 0.92],
      ];
      const shifted = nacelle.map(([x, z, a, c]): [number, number, number, number] => [x, z, a, c]);
      const engine = new MeshBuilder();
      void engine;
      tubeAt(livery, shifted, y, 10, () => WHITE);
      // The intake: a dark disc just inside the lip.
      disc(body, front - 0.05, y, ez, r * 0.8, METAL);
      // Pylon.
      skin(body, [front - shape.engineLength * 0.5, y - 0.12, ez + r * 0.8], [leX - rootChord * 0.2, y - 0.12, leZ], [leX - rootChord * 0.2, y + 0.12, leZ], [front - shape.engineLength * 0.5, y + 0.12, ez + r * 0.8], WING, [leX, y, ez - 3]);
    }
  }

  // ---- tail -----------------------------------------------------------------------------
  const finHeight = Math.max(3, type.height - (zc + rz * 0.75));
  const finRoot = L * 0.155;
  const finX = -half + finRoot * 1.18;
  surface(livery, [finX, 0, zc + rz * 0.72], finRoot, finRoot * 0.11, [finX - Math.tan(0.72) * finHeight, 0, zc + rz * 0.72 + finHeight], finRoot * 0.36, finRoot * 0.04, WHITE, true);
  const stabSpan = type.span * 0.19;
  const stabRoot = rootChord * 0.56;
  const stabX = -half + stabRoot * 1.32;
  for (const side of [1, -1]) {
    surface(body, [stabX, side * ry * 0.35, zc + rz * 0.3], stabRoot, stabRoot * 0.1, [stabX - Math.tan(0.6) * stabSpan, side * stabSpan, zc + rz * 0.3 + stabSpan * 0.12], stabRoot * 0.38, stabRoot * 0.05, WING);
  }

  // ---- landing gear ---------------------------------------------------------------------
  const wheelR = Math.max(0.42, type.fuselage * 0.14);
  const noseGearX = half - L * 0.12;
  const mainGearX = half - L * 0.55;
  const track = Math.min(semi * 0.36, Math.max(2.6, type.fuselage * 0.95));
  strut(body, noseGearX, 0, wheelR, zc - rz * 0.9, 0.14);
  wheel(body, noseGearX, -0.3, wheelR * 0.85, 0.3);
  wheel(body, noseGearX, 0.3, wheelR * 0.85, 0.3);
  const bogies = type.body === 'wide' || type.body === 'super' ? [-wheelR * 1.25, wheelR * 1.25] : [0];
  for (const side of [1, -1]) {
    strut(body, mainGearX, side * track, wheelR, wingZ, 0.18);
    for (const dx of bogies) {
      wheel(body, mainGearX + dx, side * track - 0.42, wheelR, 0.42);
      wheel(body, mainGearX + dx, side * track + 0.42, wheelR, 0.42);
    }
  }
  if (type.body === 'super') {
    for (const side of [1, -1]) {
      strut(body, mainGearX - 3.2, side * ry * 0.45, wheelR, zc - rz * 0.9, 0.18);
      for (const dx of bogies) wheel(body, mainGearX - 3.2 + dx, side * ry * 0.45, wheelR, 0.5);
    }
  }

  return {
    body: body.build(),
    livery: livery.build(),
    lights: {
      nose: new THREE.Vector3(noseGearX, wheelR * 2.4, 0),
      tail: new THREE.Vector3(-half, zc + rz * 0.5, 0),
      left: new THREE.Vector3(tipX, tipZ, -semi),
      right: new THREE.Vector3(tipX, tipZ, semi),
      beacon: new THREE.Vector3(0, zc + rz + 0.15, 0),
    },
  };
}

/** A tube like `tube`, displaced sideways to hang at y. */
function tubeAt(b: MeshBuilder, stations: [number, number, number, number][], y: number, segments: number, colour: () => RGB): void {
  let previous: number[] | null = null;
  for (let s = 0; s < stations.length; s += 1) {
    const [x, zc, ry, rz] = stations[s];
    const ring: number[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const angle = (k / segments) * Math.PI * 2;
      const cy = Math.cos(angle);
      const sz = Math.sin(angle);
      ring.push(b.vertex(x, y + cy * ry, zc + sz * rz, 0, cy, sz, colour()));
    }
    if (previous) for (let k = 0; k < segments; k += 1) b.quad(previous[k], previous[k + 1], ring[k + 1], ring[k]);
    previous = ring;
  }
}

/** A disc facing forward (+x). */
function disc(b: MeshBuilder, x: number, y: number, z: number, radius: number, c: RGB): void {
  const centre = b.vertex(x, y, z, 1, 0, 0, c);
  const segments = 10;
  let first = -1;
  let previous = -1;
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2;
    const v = b.vertex(x, y + Math.cos(angle) * radius, z + Math.sin(angle) * radius, 1, 0, 0, c);
    if (k === 0) first = v;
    else b.tri(centre, previous, v);
    previous = v;
  }
  b.tri(centre, previous, first);
}
