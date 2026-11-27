// Draws every aircraft: one instanced mesh pair per type, placed from simulation state and eased
// between simulation steps.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { AIRCRAFT } from '../../sim/fleet.ts';
import { LIGHT_COLOURS, type Lights } from '../lights.ts';
import { buildAircraftGeometry, type AircraftGeometry } from '../models/aircraft.ts';

/** Phases in which an aircraft has its engines running, and so its beacon flashing. */
const RUNNING = new Set(['pushback', 'starting', 'taxiOut', 'lineUp', 'takeoff', 'climb', 'approach', 'landing', 'taxiIn', 'goAround']);
/** Phases on or over a runway, when the strobes and landing lights are on. */
const ON_RUNWAY = new Set(['lineUp', 'takeoff', 'climb', 'approach', 'landing', 'goAround']);
const TAXIING = new Set(['taxiOut', 'taxiIn']);

const CAPACITY = 64;

interface TypeMeshes {
  body: THREE.InstancedMesh;
  livery: THREE.InstancedMesh;
  /** Aircraft id shown by each instance, for picking. */
  ids: number[];
  lights: AircraftGeometry['lights'];
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
  private readonly lamp = new THREE.Vector3();

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
      this.meshes.set(type.id, { body, livery, ids: [], lights: geometry.lights });
    }
  }

  /**
   * Place every aircraft; `alpha` is how far the frame is between the last two simulation steps.
   * With `lights`, each aircraft also shows its navigation lights, beacon, strobes and landing light.
   */
  update(aircraft: readonly Aircraft[], alpha: number, lights: Lights | null = null): void {
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
      if (lights) this.addLights(lights, entry.lights, a);
    }
    for (const entry of this.meshes.values()) {
      entry.body.count = entry.ids.length;
      entry.livery.count = entry.ids.length;
      entry.body.instanceMatrix.needsUpdate = true;
      entry.livery.instanceMatrix.needsUpdate = true;
      if (entry.livery.instanceColor) entry.livery.instanceColor.needsUpdate = true;
    }
  }

  /** Lights of one aircraft, placed with the pose just set in `position` and `quaternion`. */
  private addLights(lights: Lights, at: AircraftGeometry['lights'], a: Aircraft): void {
    const { WHITE, RED, GREEN } = LIGHT_COLOURS;
    const put = (local: THREE.Vector3, colour: readonly [number, number, number], size: number, period = 0, duty = 0, offset = 0): void => {
      this.lamp.copy(local).applyQuaternion(this.quaternion).add(this.position);
      lights.add(this.lamp.x, -this.lamp.z, this.lamp.y, colour, size, period, duty, offset);
    };
    // Each aircraft flashes on its own beat, so a row of them does not blink together.
    const beat = (a.id * 0.37) % 1;
    put(at.left, RED, 1.3);
    put(at.right, GREEN, 1.3);
    put(at.tail, WHITE, 1.1);
    if (RUNNING.has(a.phase)) put(at.beacon, RED, 1.8, 1.3, 0.12, beat);
    if (ON_RUNWAY.has(a.phase)) {
      put(at.left, WHITE, 3.2, 1.1, 0.06, beat);
      put(at.right, WHITE, 3.2, 1.1, 0.06, beat + 0.05);
      put(at.nose, WHITE, 6);
    } else if (TAXIING.has(a.phase)) {
      put(at.nose, WHITE, 3.5);
    }
  }

  /** The aircraft drawn under a ray, if any: its id and how far along the ray it was hit. */
  pick(raycaster: THREE.Raycaster): { id: number; distance: number } | null {
    let best: { id: number; distance: number } | null = null;
    for (const entry of this.meshes.values()) {
      if (!entry.ids.length) continue;
      for (const mesh of [entry.body, entry.livery]) {
        // The bounds three.js tests the ray against first are kept from the last time they were
        // worked out; the aircraft have moved since.
        mesh.computeBoundingSphere();
        for (const hit of raycaster.intersectObject(mesh, false)) {
          if (hit.instanceId === undefined || hit.instanceId >= entry.ids.length) continue;
          if (!best || hit.distance < best.distance) best = { id: entry.ids[hit.instanceId], distance: hit.distance };
          break;
        }
      }
    }
    return best;
  }
}
