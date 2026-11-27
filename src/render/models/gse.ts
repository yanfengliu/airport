// Ground service equipment: the small vehicles that work round a parked aircraft, built from the
// parts in gse-parts.ts.
// Body frame: x forward, y left, z up, origin on the ground under the middle.

import * as THREE from 'three';
import { MeshBuilder, box, rgb, type RGB } from '../builder.ts';
import { gseParts, type GseColour, type GseKind } from './gse-parts.ts';

export type { GseKind } from './gse-parts.ts';

const COLOURS: Record<GseColour, RGB> = {
  tyre: [0.07, 0.07, 0.08],
  white: rgb(0xe9ebed),
  yellow: rgb(0xe7b416),
  orange: rgb(0xdb6a1d),
  blue: rgb(0x2f5d94),
  grey: rgb(0x8b9097),
  dark: rgb(0x3a3d42),
  belt: rgb(0x26282c),
  silver: rgb(0xc8ccd1),
};

/** A sloping slab from (x0, z0) up to (x1, z1), for conveyor belts and stairs. */
function ramp(b: MeshBuilder, x0: number, z0: number, x1: number, z1: number, halfWidth: number, thick: number, c: RGB): void {
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  const nx = -(z1 - z0) / len;
  const nz = (x1 - x0) / len;
  const top = [
    b.vertex(x0, halfWidth, z0, nx, 0, nz, c),
    b.vertex(x0, -halfWidth, z0, nx, 0, nz, c),
    b.vertex(x1, -halfWidth, z1, nx, 0, nz, c),
    b.vertex(x1, halfWidth, z1, nx, 0, nz, c),
  ];
  b.quad(top[0], top[1], top[2], top[3]);
  for (const side of [1, -1]) {
    const y = side * halfWidth;
    const a = b.vertex(x0, y, z0 - thick, 0, side, 0, c);
    const bb = b.vertex(x1, y, z1 - thick, 0, side, 0, c);
    const cc = b.vertex(x1, y, z1, 0, side, 0, c);
    const d = b.vertex(x0, y, z0, 0, side, 0, c);
    if (side === 1) b.quad(bb, a, d, cc);
    else b.quad(a, bb, cc, d);
  }
}

export function buildGseGeometry(kind: GseKind): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (const p of gseParts(kind)) {
    if (p.kind === 'block') box(b, p.x, p.y, p.h0, p.h1, p.halfLength, p.halfWidth, 0, COLOURS[p.side], COLOURS[p.top]);
    else ramp(b, p.x0, p.z0, p.x1, p.z1, p.halfWidth, p.thick, COLOURS[p.colour]);
  }
  return b.build();
}
