// Draws road vehicles: one instanced mesh per kind, tinted per vehicle.

import * as THREE from 'three';
import { VEHICLE_LENGTH, type Vehicle, type VehicleKind } from '../../sim/roads/traffic.ts';
import { buildVehicleGeometry } from '../models/vehicles.ts';

const CAPACITY: Record<VehicleKind, number> = { car: 3200, suv: 1800, van: 700, taxi: 500, shuttle: 260, bus: 160, truck: 500 };

export class VehicleLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<VehicleKind, THREE.InstancedMesh>();
  private readonly counts = new Map<VehicleKind, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();
  /** Vehicles are skipped when the camera is too far for them to cover a pixel. */
  maxDistance = 9000;

  constructor() {
    this.group.name = 'vehicles';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25, envMapIntensity: 0.8 });
    for (const kind of Object.keys(CAPACITY) as VehicleKind[]) {
      const mesh = new THREE.InstancedMesh(buildVehicleGeometry(kind, VEHICLE_LENGTH[kind]), material, CAPACITY[kind]);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.colour.set(0xffffff));
      mesh.name = `vehicles-${kind}`;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  update(vehicles: readonly Vehicle[], alpha: number, cameraDistance: number): void {
    for (const kind of this.meshes.keys()) this.counts.set(kind, 0);
    if (cameraDistance <= this.maxDistance) {
      const m = this.matrix.elements;
      for (const v of vehicles) {
        const mesh = this.meshes.get(v.kind)!;
        const index = this.counts.get(v.kind)!;
        if (index >= CAPACITY[v.kind]) continue;
        this.counts.set(v.kind, index + 1);
        const x = v.px + (v.x - v.px) * alpha;
        const y = v.py + (v.y - v.py) * alpha;
        const z = v.pz + (v.z - v.pz) * alpha;
        let turn = v.heading - v.pheading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        const heading = v.pheading + turn * alpha;
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        // Rotation about the vertical by `heading`, then translation: forward (+X) turns towards -Z.
        m[0] = c;
        m[1] = 0;
        m[2] = -s;
        m[3] = 0;
        m[4] = 0;
        m[5] = 1;
        m[6] = 0;
        m[7] = 0;
        m[8] = s;
        m[9] = 0;
        m[10] = c;
        m[11] = 0;
        m[12] = x;
        m[13] = z + 0.14;
        m[14] = -y;
        m[15] = 1;
        mesh.setMatrixAt(index, this.matrix);
        mesh.setColorAt(index, this.colour.set(v.colour));
      }
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
