// Draws every aircraft, placed from simulation state and eased between simulation steps: most types
// with one of Polyfork's airliners fitted to their size (src/shared/airframe.ts), the A380, which
// Polyfork has no model of, with our own (tools/models/original/airliner.ts); each with its accent
// colour the airline's. One instanced mesh per type. Without the models, each type is drawn from
// its proportions, with a tail in the airline's colour.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { AIRCRAFT } from '../../sim/fleet.ts';
import { LIGHT_COLOURS, type Lights } from '../lights.ts';
import { OWN_MODEL, modelFit } from '../../shared/airframe.ts';
import { buildAircraftGeometry, lightsOf, type AircraftGeometry } from '../models/aircraft.ts';
import { paintedMaterial, type Models } from '../models/library.ts';

/** Phases in which an aircraft has its engines running, and so its beacon flashing. */
const RUNNING = new Set(['pushback', 'starting', 'taxiOut', 'lineUp', 'takeoff', 'climb', 'approach', 'landing', 'taxiIn', 'goAround']);
/** Phases on or over a runway, when the strobes and landing lights are on. */
const ON_RUNWAY = new Set(['lineUp', 'takeoff', 'climb', 'approach', 'landing', 'goAround']);
const TAXIING = new Set(['taxiOut', 'taxiIn']);

const CAPACITY = 64;

/**
 * The colour slots of each of Polyfork's airliners that take the airline's colour: the narrow-body's
 * blue accent (tail, winglets, engine cowls and cheatline), the wide-body's tail and engine cowls.
 * test/outline.test.ts checks that they colour the fin and not the cabin.
 */
export const LIVERY_SLOTS: Record<string, number[]> = {
  'narrow-body-airliner-619183': [1],
  'widebody-airliner-ae0a5a': [4, 18],
};

interface TypeMeshes {
  /** The model, coloured as made but for its livery slots, which take the airline's colour. */
  body: THREE.InstancedMesh;
  /** For a type drawn from its proportions: the tail, in the airline's colour. */
  livery: THREE.InstancedMesh | null;
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

  constructor(models: Models = new Map()) {
    this.group.name = 'aircraft';
    const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12, envMapIntensity: 0.9 });
    const liveryMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.9 });
    const painted = new Map<string, THREE.Material>();
    for (const type of Object.values(AIRCRAFT)) {
      // Our own model is made at the type's size, centred on its point.
      const fit = modelFit(type) ?? (OWN_MODEL[type.id] ? { id: OWN_MODEL[type.id], along: 1, across: 1, up: 1, mid: 0 } : null);
      const model = fit ? models.get(fit.id) : undefined;
      if (fit && model) {
        // The model's frame (+z its nose, +x its left) turned to this layer's (+x the nose, -z the
        // left), its middle on the aircraft's point, and scaled to the type's length, span and height.
        const geometry = model.geometry.clone();
        geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(new THREE.Matrix4().makeScale(fit.across, fit.up, fit.along)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -fit.mid)));
        geometry.computeBoundingSphere();
        // The livery slots: listed for Polyfork's, named 'livery' in our own.
        const livery = LIVERY_SLOTS[fit.id] ?? (model.info.parts ?? []).flatMap((name, slot) => (name === 'livery' ? [slot] : []));
        if (!painted.has(fit.id)) painted.set(fit.id, paintedMaterial(livery));
        const body = new THREE.InstancedMesh(geometry, painted.get(fit.id)!, CAPACITY);
        body.count = 0;
        body.castShadow = true;
        body.receiveShadow = true;
        body.frustumCulled = false;
        body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        body.name = `aircraft-${type.id}`;
        body.setColorAt(0, this.colour.set(0xffffff));
        this.group.add(body);
        this.meshes.set(type.id, { body, livery: null, ids: [], lights: lightsOf(type) });
        continue;
      }
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
      this.colour.set(a.airline.colour);
      if (entry.livery) {
        entry.livery.setMatrixAt(index, this.matrix);
        entry.livery.setColorAt(index, this.colour);
      } else entry.body.setColorAt(index, this.colour);
      if (lights) this.addLights(lights, entry.lights, a);
    }
    for (const entry of this.meshes.values()) {
      for (const mesh of entry.livery ? [entry.body, entry.livery] : [entry.body]) {
        mesh.count = entry.ids.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
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
      for (const mesh of entry.livery ? [entry.body, entry.livery] : [entry.body]) {
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
