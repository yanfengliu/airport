// Draws every aircraft: one instanced mesh pair per type, placed from simulation state and eased
// between simulation steps.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { AIRCRAFT } from '../../sim/fleet.ts';
import { buildAircraftGeometry } from '../models/aircraft.ts';

const CAPACITY = 64;

interface TypeMeshes {
  body: THREE.InstancedMesh;
  livery: THREE.InstancedMesh;
  /** Aircraft id shown by each instance, for picking. */
  ids: number[];
}

export class AircraftLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<string, TypeMeshes>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler(0, 0, 0, 'YZX');
  private readonly colour = new THREE.Color();

  constructor() {
    this.group.name = 'aircraft';
    const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12, envMapIntensity: 0.9 });
    const liveryMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.9 });
    for (const type of Object.values(AIRCRAFT)) {
      const geometry = buildAircraftGeometry(type);
      const body = new THREE.InstancedMesh(geometry.body, bodyMaterial, CAPACITY);
      const livery = new THREE.InstancedMesh(geometry.livery, liveryMaterial, CAPACITY);
      for (const mesh of [body, livery]) {
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.name = `aircraft-${type.id}`;
        this.group.add(mesh);
      }
      livery.setColorAt(0, this.colour.set(0xffffff));
      this.meshes.set(type.id, { body, livery, ids: [] });
    }
  }

  /** Place every aircraft; `alpha` is how far the frame is between the last two simulation steps. */
  update(aircraft: readonly Aircraft[], alpha: number): void {
    for (const entry of this.meshes.values()) entry.ids.length = 0;
    for (const a of aircraft) {
      if (a.phase === 'gone') continue;
      const entry = this.meshes.get(a.type.id);
      if (!entry || entry.ids.length >= CAPACITY) continue;
      const index = entry.ids.length;
      entry.ids.push(a.id);
      const x = a.px + (a.x - a.px) * alpha;
      const y = a.py + (a.y - a.py) * alpha;
      const alt = a.palt + (a.alt - a.palt) * alpha;
      let turn = a.heading - a.pheading;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const heading = a.pheading + turn * alpha;
      const pitch = a.ppitch + (a.pitch - a.ppitch) * alpha;
      this.position.set(x, alt, -y);
      this.euler.set(a.bank, heading, pitch, 'YZX');
      this.quaternion.setFromEuler(this.euler);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      entry.body.setMatrixAt(index, this.matrix);
      entry.livery.setMatrixAt(index, this.matrix);
      entry.livery.setColorAt(index, this.colour.set(a.airline.colour));
    }
    for (const entry of this.meshes.values()) {
      entry.body.count = entry.ids.length;
      entry.livery.count = entry.ids.length;
      entry.body.instanceMatrix.needsUpdate = true;
      entry.livery.instanceMatrix.needsUpdate = true;
      if (entry.livery.instanceColor) entry.livery.instanceColor.needsUpdate = true;
    }
  }

  /** The aircraft under a ray, if any: its id and how far along the ray it was hit. */
  pick(raycaster: THREE.Raycaster): { id: number; distance: number } | null {
    let best: { id: number; distance: number } | null = null;
    for (const entry of this.meshes.values()) {
      if (!entry.ids.length) continue;
      for (const hit of raycaster.intersectObject(entry.body, false)) {
        if (hit.instanceId === undefined || hit.instanceId >= entry.ids.length) continue;
        if (!best || hit.distance < best.distance) best = { id: entry.ids[hit.instanceId], distance: hit.distance };
        break;
      }
    }
    return best;
  }
}
