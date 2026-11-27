// Draws the ground equipment round each parked aircraft, as its turnaround goes: power at the
// nose while it is on stand, belt loaders and baggage carts at the holds until the doors close,
// catering at the rear door before boarding, fuel under the wing, stairs at a remote stand, and
// the tug that pushes it back. Placed from the aircraft and its visit; nothing here is simulated.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { wingOver } from '../models/aircraft.ts';
import { buildGseGeometry, type GseKind } from '../models/gse.ts';

const KINDS: GseKind[] = ['pushback', 'power', 'loader', 'carts', 'fuel', 'catering', 'stairs'];
const CAPACITY = 220;
/** Seconds after reaching the stand that the fuel truck arrives, and before departure that it leaves. */
const FUEL_FROM = 600;
const FUEL_UNTIL = 900;
/** Sizes of the trucks as src/render/models/gse.ts builds them, metres: how far out the catering truck reaches from the fuselage, its half width; the fuel truck's half width, half length and height. */
const CATERING_REACH = 7;
const CATERING_HALF_WIDTH = 1.25;
const FUEL_HALF_WIDTH = 1.2;
const FUEL_HALF_LENGTH = 4.6;
const FUEL_TOP = 3.05;

export class GseLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<GseKind, THREE.InstancedMesh>();
  private readonly counts = new Map<GseKind, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly remote: ReadonlySet<string>;
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
        if (a.phase !== 'parked' && a.phase !== 'pushback' && a.phase !== 'starting') continue;
        const x = a.px + (a.x - a.px) * alpha;
        const y = a.py + (a.y - a.py) * alpha;
        const h = a.heading;
        const length = a.type.length;
        const half = a.type.fuselage / 2;
        const wide = a.type.body === 'wide' || a.type.body === 'super';
        // `along` from the middle of the aircraft towards the nose, `side` to its left; `turn` is
        // the equipment's heading from the aircraft's.
        const put = (kind: GseKind, along: number, side: number, turn: number): void => this.put(kind, x + Math.cos(h) * along - Math.sin(h) * side, y + Math.sin(h) * along + Math.cos(h) * side, h + turn);
        if (a.phase !== 'parked') {
          // The tug at the nose gear, facing the way the aircraft faces, its tow bar reaching back.
          put('pushback', length / 2 - 0.12 * length + 4.8, 0, 0);
          continue;
        }
        const v = a.visit;
        const onStand = now - v.onBlockAt;
        // Ground power at the nose, on the right.
        put('power', length / 2 - 3, -(half + 2.5), 0);
        if (!v.doorsClosed) {
          // Bags out of the holds and back in, on the right: a belt loader square to the fuselage
          // with its high end at the door, and a train of carts beside it.
          put('loader', -0.27 * length, -(half + 4.3), Math.PI / 2);
          put('carts', -0.27 * length - 2, -(half + 10.5), 0);
          if (wide) {
            put('loader', 0.22 * length, -(half + 4.3), Math.PI / 2);
            put('carts', 0.22 * length + 2, -(half + 10.5), 0);
          }
        }
        // Catering after the passengers are off and before boarding, at the right rear door: behind
        // the wing, whose trailing edge sweeps back further the further out it is.
        if (v.deplaned >= v.rotation.paxIn && !v.boardingOpen && !v.doorsClosed) {
          const wing = wingOver(a.type, half + CATERING_REACH);
          const along = Math.min(-0.36 * length, wing ? wing.trail - CATERING_HALF_WIDTH - 0.8 : Infinity);
          put('catering', along, -(half + 4.3), -Math.PI / 2);
        }
        // Fuel under the right wing for most of the stay, where the wing is high enough to clear the
        // truck; under a low wing, beside its trailing edge instead.
        if (onStand > FUEL_FROM && v.etd - now > FUEL_UNTIL) {
          const side = a.type.span * 0.26 + 1;
          const wing = wingOver(a.type, side + FUEL_HALF_WIDTH) ?? wingOver(a.type, side);
          const under = Math.min(wingOver(a.type, side - FUEL_HALF_WIDTH)?.under ?? Infinity, wing?.under ?? Infinity);
          if (under > FUEL_TOP + 0.3) put('fuel', -0.04 * length, -side, 0);
          else put('fuel', (wing ? wing.trail : -0.04 * length) - FUEL_HALF_LENGTH - 1, -side, 0);
        }
        // At a remote stand people come and go by stairs at the front left door.
        if (this.remote.has(v.stand)) put('stairs', length / 2 - 0.16 * length, half + 5.2, -Math.PI / 2);
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
