// Draws everyone on foot as small instanced figures: a body tinted by what they wear and a head.
// A travel party is drawn as its members walking side by side. People are drawn only on the
// floors the view shows, and only when the camera is near enough to see them.

import * as THREE from 'three';
import type { People } from '../../sim/terminal/people.ts';
import { MeshBuilder, box, type RGB } from '../builder.ts';

/** Clothing colours by palette index. The first entries are uniforms, by staff role. */
export const CLOTHING: number[] = [
  0x3b4a5e, 0x2b5fb3, 0x1f2f55, 0x7a1f2b, 0x3f7d4a, 0x8a8f96, 0xf2b01e, 0x20242b, 0x0f2f4f,
  0x4a5568, 0x6b7280, 0x374151, 0x7c2d12, 0x92400e, 0x166534, 0x1e3a8a, 0x5b21b6, 0x9d174d,
  0xb45309, 0x0f766e, 0xd1d5db, 0xe5e7eb, 0x111827, 0x57534e, 0xa8a29e, 0xbe123c, 0x0369a1,
];

const SKIN = [0xf1c9a5, 0xe0ac84, 0xc68658, 0x8d5a3b, 0x5c3a25, 0xf6d7bd];
const WHITE: RGB = [1, 1, 1];

function bodyGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Legs and torso as two boxes; about 1.5 m to the shoulders.
  box(b, 0, 0, 0, 0.82, 0.13, 0.19, 0, WHITE, WHITE);
  box(b, 0, 0, 0.82, 1.48, 0.15, 0.24, 0, WHITE, WHITE);
  return b.build();
}

function headGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  box(b, 0, 0, 1.5, 1.74, 0.11, 0.1, 0, WHITE, WHITE);
  return b.build();
}

export class PeopleLayer {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly colour = new THREE.Color();
  private readonly palette: THREE.Color[];
  private readonly skin: THREE.Color[];
  /** Beyond this camera distance nobody is drawn. */
  maxDistance = 3200;
  /** Which floors to draw: a person is shown when `floors[person's floor]` is true. */
  floors: boolean[] = [true, true, true];

  constructor(capacity: number) {
    this.capacity = capacity;
    this.group.name = 'people';
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.bodies = new THREE.InstancedMesh(bodyGeometry(), material, capacity);
    this.heads = new THREE.InstancedMesh(headGeometry(), material, capacity);
    // One set of matrices for both meshes.
    this.heads.instanceMatrix = this.bodies.instanceMatrix;
    for (const mesh of [this.bodies, this.heads]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.setColorAt(0, this.colour.set(0xffffff));
      this.group.add(mesh);
    }
    this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.palette = CLOTHING.map((c) => new THREE.Color(c));
    this.skin = SKIN.map((c) => new THREE.Color(c));
  }

  /** `alpha` is how far the frame is between the last two simulation steps. */
  update(people: People, alpha: number, cameraDistance: number): void {
    let count = 0;
    if (this.group.visible && cameraDistance <= this.maxDistance) {
      const matrices = this.bodies.instanceMatrix.array as Float32Array;
      for (let id = 0; id < people.high && count < this.capacity; id += 1) {
        if (!people.alive[id] || !this.floors[people.floor[id]]) continue;
        const x = people.px[id] + (people.x[id] - people.px[id]) * alpha;
        const y = people.py[id] + (people.y[id] - people.py[id]) * alpha;
        const h = people.ph[id] + (people.h[id] - people.ph[id]) * alpha;
        // Face the way they are moving; standing people keep a fixed bearing of their own.
        const dx = people.x[id] - people.px[id];
        const dy = people.y[id] - people.py[id];
        const heading = dx * dx + dy * dy > 0.0004 ? Math.atan2(dy, dx) : (id * 2.399) % 6.283;
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        const size = Math.max(1, people.size[id]);
        for (let member = 0; member < size && count < this.capacity; member += 1) {
          // Members walk abreast, a little staggered, about half a metre apart.
          const across = (member - (size - 1) / 2) * 0.55;
          const back = (member % 2) * 0.35;
          const mx = x - s * across - c * back;
          const my = y + c * across - s * back;
          const o = count * 16;
          matrices[o] = c;
          matrices[o + 1] = 0;
          matrices[o + 2] = -s;
          matrices[o + 3] = 0;
          matrices[o + 4] = 0;
          matrices[o + 5] = member > 1 && size > 2 ? 0.72 : 1;
          matrices[o + 6] = 0;
          matrices[o + 7] = 0;
          matrices[o + 8] = s;
          matrices[o + 9] = 0;
          matrices[o + 10] = c;
          matrices[o + 11] = 0;
          matrices[o + 12] = mx;
          matrices[o + 13] = h;
          matrices[o + 14] = -my;
          matrices[o + 15] = 1;
          // Members of a party dress differently; staff all wear the uniform.
          const tint = people.role[id] === 0 ? (people.colour[id] + member * 3) % this.palette.length : people.colour[id];
          this.bodies.setColorAt(count, this.palette[tint]);
          this.heads.setColorAt(count, this.skin[(id * 7 + member) % this.skin.length]);
          count += 1;
        }
      }
    }
    this.bodies.count = count;
    this.heads.count = count;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
  }
}
