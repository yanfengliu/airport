// Procedural airliners, one geometry pair per type at true size. The "body" mesh carries its own
// colours (white fuselage, grey wings, dark glass); the "livery" mesh is white and takes the
// airline's colour per aircraft: the fin, the rear fuselage and the engine cowls. Every size and
// place comes from the type's airframe (src/shared/airframe.ts), which the stands are judged by too.
//
// Body frame: x forward, y to the left wing, z up, origin on the ground under the middle of the
// fuselage. The builder turns that into three.js axes (forward +X, up +Y, right wing +Z).

import * as THREE from 'three';
import { airframe, section, type Surface } from '../../shared/airframe.ts';
import type { AircraftType } from '../../sim/fleet.ts';
import { MeshBuilder, rgb, type RGB } from '../builder.ts';

export { wingOver } from '../../shared/airframe.ts';

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

/** A lifting surface: a tapered slab from its root section to its tip section. */
function surface(b: MeshBuilder, s: Surface, c: RGB): void {
  const r = section(s.root, s.rootChord, s.rootThick, s.upright);
  const t = section(s.tip, s.tipChord, s.tipThick, s.upright);
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
  const f = airframe(type);
  const body = new MeshBuilder();
  const livery = new MeshBuilder();
  const { ry, rz, zc, stations } = f;

  // ---- fuselage: stations from the tail cone to the nose ----------------------------------
  const liveryFrom = 2;
  const fuselageColour = (station: number, angle: number): RGB => (Math.sin(angle) < -0.45 ? BELLY : FUSELAGE);
  tube(body, stations.slice(liveryFrom), 14, (station, angle) => fuselageColour(station, angle));
  tube(livery, stations.slice(0, liveryFrom + 1), 14, () => WHITE);

  // Cabin windows as a dark stripe each side, and the flight deck glazing.
  const { z: stripeZ, from: stripeFrom, to: stripeTo } = f.windows;
  for (const side of [1, -1]) {
    const y = side * f.windows.y;
    const p0: V3 = [stripeFrom, y, stripeZ - 0.2];
    const p1: V3 = [stripeTo, y, stripeZ - 0.2];
    const p2: V3 = [stripeTo, y, stripeZ + 0.2];
    const p3: V3 = [stripeFrom, y, stripeZ + 0.2];
    skin(body, p0, p1, p2, p3, GLASS, [0, 0, zc]);
    if (f.tall > 1.05) {
      const up = rz * 0.62;
      skin(body, [stripeFrom + 4, side * (ry * 0.86), zc + up - 0.2], [stripeTo - 6, side * (ry * 0.86), zc + up - 0.2], [stripeTo - 6, side * (ry * 0.86), zc + up + 0.2], [stripeFrom + 4, side * (ry * 0.86), zc + up + 0.2], GLASS, [0, 0, zc]);
    }
  }
  const deckX = f.deckX;
  skin(body, [deckX - 0.9, -ry * 0.62, zc + rz * 0.5], [deckX + 0.7, -ry * 0.42, zc + rz * 0.34], [deckX + 0.7, ry * 0.42, zc + rz * 0.34], [deckX - 0.9, ry * 0.62, zc + rz * 0.5], GLASS, [deckX - 2, 0, zc - rz]);

  // ---- wings ----------------------------------------------------------------------------
  const { rootChord, wingZ } = f;
  for (const s of f.sides) {
    surface(body, s.wing, WING);
    if (s.winglet) surface(livery, s.winglet, WHITE);
    // Engines hang ahead of and below the wing.
    for (const e of s.engines) {
      const { y, front, radius: r, z: ez, leX, leZ } = e;
      tubeAt(livery, e.stations, y, 10, () => WHITE);
      // The intake: a dark disc just inside the lip.
      disc(body, front - 0.05, y, ez, r * 0.8, METAL);
      // Pylon.
      skin(body, [front - e.length * 0.5, y - 0.12, ez + r * 0.8], [leX - rootChord * 0.2, y - 0.12, leZ], [leX - rootChord * 0.2, y + 0.12, leZ], [front - e.length * 0.5, y + 0.12, ez + r * 0.8], WING, [leX, y, ez - 3]);
    }
  }

  // ---- tail -----------------------------------------------------------------------------
  surface(livery, f.fin, WHITE);
  for (const s of f.sides) surface(body, s.stabiliser, WING);

  // ---- landing gear ---------------------------------------------------------------------
  const { wheelR, noseGearX, mainGearX, track, bogies } = f;
  strut(body, noseGearX, 0, wheelR, zc - rz * 0.9, 0.14);
  wheel(body, noseGearX, -0.3, wheelR * 0.85, 0.3);
  wheel(body, noseGearX, 0.3, wheelR * 0.85, 0.3);
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

  return { body: body.build(), livery: livery.build(), lights: lightsOf(type) };
}

/** Where a type's lights are, in three.js model space (+x the nose, -z the left): from its shape as drawn. */
export function lightsOf(type: AircraftType): AircraftGeometry['lights'] {
  const { half, zc, rz, tipX, tipZ, semi, noseGearX, wheelR } = airframe(type);
  return {
    nose: new THREE.Vector3(noseGearX, wheelR * 2.4, 0),
    tail: new THREE.Vector3(-half, zc + rz * 0.5, 0),
    left: new THREE.Vector3(tipX, tipZ, -semi),
    right: new THREE.Vector3(tipX, tipZ, semi),
    beacon: new THREE.Vector3(0, zc + rz + 0.15, 0),
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
