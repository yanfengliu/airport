// Draws the ground equipment round each parked aircraft, where gse-places.ts puts it as the
// turnaround goes: each piece one of Polyfork's vehicles, flat-shaded and coloured as it was made.
// Placed from the aircraft and its visit; nothing here is simulated. Without the models (they did
// not load) no equipment is drawn.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { MeshBuilder, box, rgb } from '../builder.ts';
import { flatMaterial, placement, type Models } from '../models/library.ts';
import { GSE_MODELS, LOW_STAIRS, gseAround, type GseKind, type GsePlace } from './gse-places.ts';

const KINDS = Object.keys(GSE_MODELS) as GseKind[];
/** Pieces of each kind drawn at most: the trains have several cars, and two containers to a dolly. */
const CAPACITY: Partial<Record<GseKind, number>> = { cart: 500, dolly: 500, uld: 1000, bagtug: 300 };
const CAPACITY_REST = 220;

/** A copy of the stairs truck with its platform at a narrow-body's door (LOW_STAIRS). */
function lowStairs(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const low = geometry.clone();
  const position = low.getAttribute('position') as THREE.BufferAttribute;
  const k = (LOW_STAIRS.to - LOW_STAIRS.from) / (LOW_STAIRS.platform - LOW_STAIRS.from);
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    if (y > LOW_STAIRS.from) position.setY(i, LOW_STAIRS.from + (y - LOW_STAIRS.from) * k);
  }
  position.needsUpdate = true;
  low.computeVertexNormals();
  low.computeBoundingSphere();
  return low;
}

/** A tow bar a metre long along +z, its middle at the origin, to be stretched to its length. */
function towbar(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Along map -y, which is the model's +z; 0.42 to 0.62 m up.
  box(b, 0, 0, 0.42, 0.62, 0.5, 0.11, -Math.PI / 2, rgb(0x3a3d42), rgb(0x8b9097));
  return b.build();
}

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
  constructor(remote: ReadonlySet<string>, models: Models) {
    this.remote = remote;
    this.group.name = 'ground-equipment';
    const material = flatMaterial();
    for (const kind of KINDS) {
      const id = GSE_MODELS[kind].id;
      const model = id ? models.get(id) : null;
      if (id && !model) continue;
      const geometry = kind === 'towbar' ? towbar() : kind === 'stairsLow' ? lowStairs(model!.geometry) : model!.geometry;
      const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY[kind] ?? CAPACITY_REST);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = `gse-${kind}`;
      this.meshes.set(kind, mesh);
      this.counts.set(kind, 0);
      this.group.add(mesh);
    }
  }

  /** Place the equipment for every aircraft at `now`; `alpha` eases between simulation steps. */
  update(aircraft: readonly Aircraft[], now: number, alpha: number, cameraDistance: number): void {
    for (const kind of this.meshes.keys()) this.counts.set(kind, 0);
    if (cameraDistance <= this.maxDistance && this.meshes.size) {
      for (const a of aircraft) {
        this.places.length = 0;
        gseAround(a, now, this.remote.has(a.visit.stand), this.places);
        if (!this.places.length) continue;
        const x = a.px + (a.x - a.px) * alpha;
        const y = a.py + (a.y - a.py) * alpha;
        const h = a.heading;
        const c = Math.cos(h);
        const s = Math.sin(h);
        // `along` from the middle of the aircraft towards the nose, `side` to its left; `turn` is
        // the equipment's heading from the aircraft's.
        for (const p of this.places) this.put(p, x + c * p.along - s * p.side, y + s * p.along + c * p.side, h + p.turn);
      }
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private put(p: GsePlace, x: number, y: number, heading: number): void {
    const mesh = this.meshes.get(p.kind);
    if (!mesh) return;
    const index = this.counts.get(p.kind)!;
    if (index >= mesh.instanceMatrix.count) return;
    this.counts.set(p.kind, index + 1);
    mesh.setMatrixAt(index, placement(this.matrix, x, y, p.h, heading, 1, 1, p.length ?? 1));
  }
}
