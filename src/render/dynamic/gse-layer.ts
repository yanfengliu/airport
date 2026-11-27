// Draws the ground equipment round each parked aircraft, where gse-places.ts puts it as the
// turnaround goes. Placed from the aircraft and its visit; nothing here is simulated.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { buildGseGeometry, type GseKind } from '../models/gse.ts';
import { gseAround, type GsePlace } from './gse-places.ts';

const KINDS: GseKind[] = ['pushback', 'power', 'loader', 'carts', 'fuel', 'catering', 'stairs'];
const CAPACITY = 220;

export class GseLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<GseKind, THREE.InstancedMesh>();
  private readonly counts = new Map<GseKind, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly remote: ReadonlySet<string>;
  private readonly places: GsePlace[] = [];
  /** Equipment is skipped when the camera is too far for it to cover a pixel. */
  maxDistance = 2600;

  /** `remote` lists the stands with no jet bridge, where passengers use stairs. */
  constructor(remote: ReadonlySet<string>) {
    this.remote = remote;
    this.group.name = 'ground-equipment';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, envMapIntensity: 0.7 });
    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(buildGseGeometry(kind), material, CAPACITY);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = `gse-${kind}`;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  /** Place the equipment for every aircraft at `now`; `alpha` eases between simulation steps. */
  update(aircraft: readonly Aircraft[], now: number, alpha: number, cameraDistance: number): void {
    for (const kind of KINDS) this.counts.set(kind, 0);
    if (cameraDistance <= this.maxDistance) {
      for (const a of aircraft) {
        this.places.length = 0;
        gseAround(a, now, this.remote.has(a.visit.stand), this.places);
        if (!this.places.length) continue;
        const x = a.px + (a.x - a.px) * alpha;
        const y = a.py + (a.y - a.py) * alpha;
        const h = a.heading;
        // `along` from the middle of the aircraft towards the nose, `side` to its left; `turn` is
        // the equipment's heading from the aircraft's.
        for (const p of this.places) this.put(p.kind, x + Math.cos(h) * p.along - Math.sin(h) * p.side, y + Math.sin(h) * p.along + Math.cos(h) * p.side, h + p.turn);
      }
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private put(kind: GseKind, x: number, y: number, heading: number): void {
    const index = this.counts.get(kind)!;
    if (index >= CAPACITY) return;
    this.counts.set(kind, index + 1);
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    // Rotation about the vertical by `heading`, then translation, as for road vehicles.
    this.matrix.set(c, 0, s, x, 0, 1, 0, 0.05, -s, 0, c, -y, 0, 0, 0, 1);
    this.meshes.get(kind)!.setMatrixAt(index, this.matrix);
  }
}
