// Ground service equipment: the small vehicles that work round a parked aircraft.
// Body frame: x forward, y left, z up, origin on the ground under the middle.

import * as THREE from 'three';
import { MeshBuilder, box, rgb, type RGB } from '../builder.ts';

export type GseKind = 'tug' | 'pushback' | 'loader' | 'carts' | 'fuel' | 'catering' | 'power' | 'stairs';

const TYRE: RGB = [0.07, 0.07, 0.08];
const WHITE = rgb(0xe9ebed);
const YELLOW = rgb(0xe7b416);
const ORANGE = rgb(0xdb6a1d);
const BLUE = rgb(0x2f5d94);
const GREY = rgb(0x8b9097);
const DARK = rgb(0x3a3d42);
const BELT = rgb(0x26282c);
const SILVER = rgb(0xc8ccd1);

function wheels(b: MeshBuilder, xs: number[], halfWidth: number, radius: number): void {
  for (const x of xs) for (const side of [1, -1]) box(b, x, side * (halfWidth - 0.1), 0, radius * 2, radius, 0.13, 0, TYRE, TYRE);
}

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
  switch (kind) {
    case 'tug':
      box(b, 0, 0, 0.3, 1.05, 1.5, 0.75, 0, WHITE, WHITE);
      box(b, -0.5, 0, 1.05, 1.8, 0.55, 0.7, 0, DARK, WHITE);
      wheels(b, [0.9, -0.9], 0.75, 0.3);
      break;
    case 'pushback':
      box(b, 0, 0, 0.35, 1.25, 3.4, 1.35, 0, YELLOW, YELLOW);
      box(b, 1.6, 0, 1.25, 2.05, 0.9, 1.1, 0, DARK, YELLOW);
      // The tow bar that reaches to the nose gear.
      box(b, -4.6, 0, 0.35, 0.55, 1.4, 0.12, 0, GREY, GREY);
      wheels(b, [2.1, -2.1], 1.35, 0.55);
      break;
    case 'loader':
      box(b, -0.6, 0, 0.35, 1, 2.6, 0.95, 0, BLUE, BLUE);
      ramp(b, -3.6, 0.9, 4.2, 2.9, 0.5, 0.25, BELT);
      wheels(b, [1.1, -2.2], 0.95, 0.32);
      break;
    case 'carts':
      for (const x of [3.6, 0, -3.6]) {
        box(b, x, 0, 0.45, 0.62, 1.55, 0.85, 0, GREY, GREY);
        box(b, x, 0, 0.62, 1.7, 1.45, 0.78, 0, SILVER, SILVER);
        wheels(b, [x + 1, x - 1], 0.85, 0.22);
      }
      break;
    case 'fuel':
      box(b, 3.1, 0, 0.5, 2.5, 1.1, 1.2, 0, WHITE, WHITE);
      box(b, 3.75, 0, 1.5, 2.3, 0.5, 1.22, 0, DARK, WHITE);
      box(b, -1.2, 0, 0.9, 2.9, 3.1, 1.2, 0, SILVER, SILVER);
      box(b, -1.2, 0, 2.9, 3.05, 2.9, 0.4, 0, ORANGE, ORANGE);
      wheels(b, [3.2, -1.4, -3], 1.2, 0.5);
      break;
    case 'catering':
      box(b, 3, 0, 0.5, 2.4, 1.1, 1.2, 0, WHITE, WHITE);
      box(b, 3.65, 0, 1.4, 2.2, 0.5, 1.22, 0, DARK, WHITE);
      // The box body, raised on its scissor lift to door height.
      box(b, -1, 0, 3.4, 5.9, 3, 1.25, 0, SILVER, WHITE);
      box(b, -1, 0, 0.9, 3.4, 0.25, 0.9, 0, GREY, GREY);
      box(b, -1, 0, 0.6, 0.9, 3, 1.2, 0, GREY, GREY);
      wheels(b, [3.1, -1.6, -2.8], 1.2, 0.45);
      break;
    case 'power':
      box(b, 0, 0, 0.3, 1.5, 1.4, 0.8, 0, ORANGE, ORANGE);
      wheels(b, [0.8, -0.8], 0.8, 0.25);
      break;
    case 'stairs':
      box(b, -2.6, 0, 0.35, 1.3, 2, 1, 0, WHITE, WHITE);
      ramp(b, -4.2, 0.4, 2.8, 4.1, 0.75, 0.3, GREY);
      box(b, 3.2, 0, 3.9, 4.2, 0.7, 0.9, 0, GREY, GREY);
      wheels(b, [-1.2, -3.8], 1, 0.3);
      break;
    default:
      break;
  }
  return b.build();
}
