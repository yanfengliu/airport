// Low-polygon road vehicles. Each is one geometry whose paint is white, so the instance colour
// tints it, with dark glass and tyres that stay dark under any tint.
//
// Body frame as for aircraft: x forward, y left, z up, origin on the road under the middle.

import * as THREE from 'three';
import type { VehicleKind } from '../../sim/roads/traffic.ts';
import { MeshBuilder, box, type RGB } from '../builder.ts';

const PAINT: RGB = [1, 1, 1];
const GLASS: RGB = [0.1, 0.12, 0.15];
const TYRE: RGB = [0.07, 0.07, 0.08];
const TRIM: RGB = [0.5, 0.5, 0.52];

function wheels(b: MeshBuilder, length: number, width: number, radius: number, axles: number[]): void {
  for (const x of axles) {
    for (const side of [1, -1]) box(b, x * length, side * (width / 2 - 0.12), 0, radius * 2, radius, 0.14, 0, TYRE, TYRE);
  }
}

function car(length: number, width: number, body: number, cabin: number, cabinFrom: number, cabinTo: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  box(b, 0, 0, 0.28, body, length / 2, width / 2, 0, PAINT, PAINT);
  const mid = ((cabinFrom + cabinTo) / 2) * length;
  const half = ((cabinFrom - cabinTo) / 2) * length;
  box(b, mid, 0, body, cabin - 0.06, half, width / 2 - 0.08, 0, GLASS, GLASS);
  box(b, mid, 0, cabin - 0.06, cabin, half - 0.12, width / 2 - 0.12, 0, PAINT, PAINT);
  wheels(b, length, width, 0.33, [0.31, -0.3]);
  return b.build();
}

function van(length: number, width: number, height: number, glassTo: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  box(b, 0, 0, 0.32, height, length / 2, width / 2, 0, PAINT, PAINT);
  // Windscreen and side glass as a dark band round the front part.
  box(b, length * (0.5 - glassTo / 2), 0, height * 0.52, height * 0.86, (length * glassTo) / 2 + 0.02, width / 2 + 0.02, 0, GLASS, PAINT);
  wheels(b, length, width, 0.38, [0.33, -0.3]);
  return b.build();
}

function bus(length: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const width = 2.55;
  box(b, 0, 0, 0.36, 3.1, length / 2, width / 2, 0, PAINT, PAINT);
  box(b, 0, 0, 1.45, 2.5, length / 2 + 0.02, width / 2 + 0.02, 0, GLASS, PAINT);
  box(b, 0, 0, 3.1, 3.3, length * 0.3, width * 0.3, 0, TRIM, TRIM);
  wheels(b, length, width, 0.5, [0.34, -0.26]);
  return b.build();
}

function truck(length: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const width = 2.5;
  const cab = 2.4;
  box(b, length / 2 - cab / 2, 0, 0.5, 2.9, cab / 2, width / 2, 0, PAINT, PAINT);
  box(b, length / 2 - 0.5, 0, 1.7, 2.6, 0.52, width / 2 + 0.02, 0, GLASS, PAINT);
  box(b, -cab / 2 - 0.15, 0, 1.05, 4, (length - cab) / 2 - 0.15, width / 2, 0, TRIM, TRIM);
  wheels(b, length, width, 0.52, [0.38, -0.2, -0.32, -0.42]);
  return b.build();
}

export function buildVehicleGeometry(kind: VehicleKind, length: number): THREE.BufferGeometry {
  switch (kind) {
    case 'suv':
      return car(length, 1.95, 1.05, 1.75, 0.2, -0.47);
    case 'van':
      return van(length, 2, 2.05, 0.3);
    case 'taxi': {
      const g = car(length, 1.85, 0.95, 1.48, 0.14, -0.3);
      return g;
    }
    case 'shuttle':
      return van(length, 2.3, 2.75, 0.86);
    case 'bus':
      return bus(length);
    case 'truck':
      return truck(length);
    default:
      return car(length, 1.82, 0.92, 1.45, 0.12, -0.32);
  }
}
