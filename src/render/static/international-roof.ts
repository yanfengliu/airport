// The ticket hall over the International Terminal's podium. Its mapped building part gives
// the position, bearing and eave line. SOM's public description and the airport's curbside
// photograph show three linked bow-shaped spans, five trusses and pointed central skylights.
// The spans and depth are a visual approximation of that exterior, in metres.

import * as THREE from 'three';
import type { Building } from '../../shared/layout.ts';
import { MeshBuilder, rgb, type RGB } from '../builder.ts';
import { textTexture } from '../textures.ts';
import { solidMesh } from './common.ts';
import { footprintBox } from './kit-buildings.ts';

const METAL = rgb(0xc9cdd0);
const FASCIA = rgb(0x879399);
const CLADDING = [rgb(0xe5e6e1), rgb(0xdadfdc)];
const JOINT_TONE = rgb(0xacb5b4);
const SKYLIGHT = rgb(0x699099);
const GLASS = rgb(0xffffff);
const HALF_LENGTH = 131; // 860 ft tip to tip, over the 705 ft ticket hall.
const JOINT = 32;
const TRUSS_COUNT = 5;
const PANELS = 12;

/** Heights of the two chords. They meet at the cantilever tips and the joints of the middle span. */
function profile(at: number, peak: number): { top: number; bottom: number } {
  const x = Math.abs(at);
  const t = x <= JOINT ? (at + JOINT) / (2 * JOINT) : (x - JOINT) / (HALF_LENGTH - JOINT);
  const bow = 4 * t * (1 - t);
  const top = peak - 5.8 + bow * 5.8;
  return { top, bottom: top - (0.75 + 7.4 * bow) };
}

function sheet(b: MeshBuilder, x0: number, x1: number, left0: number, left1: number, right0: number, right1: number, h0: number, h1: number, c: RGB): void {
  if (right0 <= left0 && right1 <= left1) return;
  const dx = x1 - x0;
  const dh = h1 - h0;
  const len = Math.hypot(dx, dh);
  const point = (x: number, y: number, h: number): number => b.vertex(x, y, h, -dh / len, 0, dx / len, c);
  const a = point(x0, left0, h0);
  const d = point(x0, right0, h0);
  const bb = point(x1, left1, h1);
  const cc = point(x1, right1, h1);
  if (right1 > left1) b.tri(a, bb, cc);
  if (right0 > left0) b.tri(a, cc, d);
}

type Beam = [THREE.Vector3, THREE.Vector3, number];

/** The identical section of steel is instanced along both chords, their diagonals and the columns. */
function steel(beams: Beam[]): THREE.InstancedMesh {
  const bars = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), new THREE.MeshStandardMaterial({ color: 0xd7dde0, roughness: 0.56, metalness: 0.22 }), beams.length);
  bars.name = 'international-roof-steel';
  const shape = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  beams.forEach(([a, b, r], i) => {
    direction.subVectors(b, a);
    const length = direction.length();
    shape.position.addVectors(a, b).multiplyScalar(0.5);
    shape.quaternion.setFromUnitVectors(up, direction.normalize());
    shape.scale.set(r, length, r);
    shape.updateMatrix();
    bars.setMatrixAt(i, shape.matrix);
  });
  bars.castShadow = true;
  bars.receiveShadow = true;
  return bars;
}

export function buildInternationalRoof(hall: Building, glazing: THREE.MeshStandardMaterial): { group: THREE.Group; skylights: THREE.MeshStandardMaterial } {
  const fit = footprintBox(hall.poly.outer);
  // Local x goes towards the north shoulder, local -z towards the curb.
  const angle = Math.sin(fit.angle) >= 0 ? fit.angle : fit.angle + Math.PI;
  const result = new THREE.Group();
  result.name = 'international-departures-hall';
  result.position.set(fit.x, 0, -fit.y);
  result.rotation.y = angle;
  const halfWidth = fit.width / 2 + 6;
  const spacing = 2 * halfWidth / (TRUSS_COUNT - 1);
  const peak = hall.height;
  const base = hall.minHeight ?? 0;
  const beams: Beam[] = [];
  const beam = (x0: number, y0: number, h0: number, x1: number, y1: number, h1: number, radius: number): void => {
    beams.push([new THREE.Vector3(x0, h0, -y0), new THREE.Vector3(x1, h1, -y1), radius]);
  };
  const skin = new MeshBuilder();
  const lights = new MeshBuilder();
  const limits = [-HALF_LENGTH, -JOINT, JOINT, HALF_LENGTH];
  for (let span = 0; span < 3; span++) {
    const x = (i: number): number => limits[span] + (limits[span + 1] - limits[span]) * i / PANELS;
    const lightWidth = (i: number): number => span === 1 ? 4.3 * 4 * i * (PANELS - i) / (PANELS * PANELS) : 0;
    for (let i = 0; i < PANELS; i++) {
      const x0 = x(i);
      const x1 = x(i + 1);
      const a = profile(x0, peak);
      const b = profile(x1, peak);
      for (let k = 0; k < TRUSS_COUNT; k++) {
        const y = -halfWidth + k * spacing;
        beam(x0, y, a.top - 0.35, x1, y, b.top - 0.35, 0.31);
        beam(x0, y, a.bottom, x1, y, b.bottom, 0.24);
        beam(x0, y, i % 2 ? a.top - 0.35 : a.bottom, x1, y, i % 2 ? b.bottom : b.top - 0.35, 0.21);
        if (k === 0 || k === TRUSS_COUNT - 1) {
          // Close the thin edge of the metal canopy; its diagonal web stays exposed below.
          const outward = k === 0 ? -1 : 1;
          const edge = (u: number, h: number): number => skin.vertex(u, y, h, 0, outward, 0, FASCIA);
          skin.quad(edge(x0, a.top), edge(x1, b.top), edge(x1, b.top - 0.5), edge(x0, a.top - 0.5));
        }
        if (k === TRUSS_COUNT - 1) continue;
        const mid = y + spacing / 2;
        const w0 = lightWidth(i);
        const w1 = lightWidth(i + 1);
        sheet(skin, x0, x1, y, y, mid - w0, mid - w1, a.top, b.top, METAL);
        if (w0 > 0) beam(x0, mid - w0, a.top + 0.08, x0, mid + w0, a.top + 0.08, 0.10);
        sheet(lights, x0, x1, mid - w0, mid - w1, mid + w0, mid + w1, a.top, b.top, SKYLIGHT);
        sheet(skin, x0, x1, mid + w0, mid + w1, y + spacing, y + spacing, a.top, b.top, METAL);
      }
    }
  }
  for (let k = 0; k < TRUSS_COUNT; k++) {
    const y = -halfWidth + k * spacing;
    for (const x of [-81, -53, 53, 81]) beam(x, y, base, x, y, profile(x, peak).top - 0.35, 0.72);
  }
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0.16 });
  result.add(solidMesh(skin, metal, 'international-wing-roof'));
  const skylights = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.21, metalness: 0.38, emissive: 0xd8ddcf, emissiveIntensity: 0 });
  result.add(solidMesh(lights, skylights, 'international-skylights'));
  result.add(steel(beams));

  // Curtain wall follows the roof behind the exposed truss. Use the same emissive glazing as
  // the other buildings, with panel texture coordinates measured along each face.
  const glass = new MeshBuilder();
  const half = fit.length / 2;
  const width = fit.width / 2;
  const vertex = (u: number, v: number, h: number, nx: number, ny: number, run: number): number =>
    glass.vertex(u, v, h, nx, ny, 0, GLASS, run, h);
  for (const side of [-1, 1]) {
    const y = side * width;
    for (let i = 0; i < 44; i++) {
      const u0 = side * half * (1 - 2 * i / 44);
      const u1 = side * half * (1 - 2 * (i + 1) / 44);
      glass.quad(vertex(u0, y, base, 0, side, u0), vertex(u1, y, base, 0, side, u1), vertex(u1, y, profile(u1, peak).top - 0.2, 0, side, u1), vertex(u0, y, profile(u0, peak).top - 0.2, 0, side, u0));
    }
    const end = side * half;
    const h = profile(end, peak).top - 0.2;
    glass.quad(vertex(end, -y, base, side, 0, -y), vertex(end, y, base, side, 0, y), vertex(end, y, h, side, 0, y), vertex(end, -y, h, side, 0, -y));
  }
  result.add(solidMesh(glass, glazing, 'international-curtain-wall'));
  // The upper west face has light metal panels following the bottom chords above the entrances.
  const cladding = new MeshBuilder();
  const curb = width + 0.12;
  const face = (u0: number, u1: number, h0: number, h1: number, top0: number, top1: number, colour: RGB): void => {
    const p = (u: number, h: number): number => cladding.vertex(u, curb, h, 0, 1, 0, colour);
    cladding.quad(p(u1, h1), p(u0, h0), p(u0, top0), p(u1, top1));
  };
  const bottom = base + 3.7;
  for (let i = 0; i < 54; i++) {
    const x0 = -half + 2 * half * i / 54;
    const x1 = -half + 2 * half * (i + 1) / 54;
    const cap0 = profile(x0, peak).bottom - 0.25;
    const cap1 = profile(x1, peak).bottom - 0.25;
    for (let h = bottom; h < Math.max(cap0, cap1); h += 2.1) {
      face(x0, x1, Math.min(cap0, h), Math.min(cap1, h), Math.min(cap0, h + 0.07), Math.min(cap1, h + 0.07), JOINT_TONE);
      face(x0, x1, Math.min(cap0, h + 0.07), Math.min(cap1, h + 0.07), Math.min(cap0, h + 2.1), Math.min(cap1, h + 2.1), CLADDING[i % 7 ? 0 : 1]);
    }
  }
  result.add(solidMesh(cladding, metal, 'international-curb-panels'));
  const sign = textTexture('SAN FRANCISCO INTERNATIONAL', { colour: '#283439', font: '600 100px Arial, sans-serif' });
  const letters = new THREE.Mesh(new THREE.PlaneGeometry(58, 4.5), new THREE.MeshStandardMaterial({ map: sign.texture, alphaTest: 0.4 }));
  letters.rotation.y = Math.PI;
  letters.name = 'international-curb-lettering';
  letters.position.set(0, peak - 11.8, -curb - 0.08);
  result.add(letters);
  return { group: result, skylights };
}
