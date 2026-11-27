// Draws the moving ends of the jet bridges: pulled back from the stand while no aircraft is there,
// out to the door once one has parked, and back again when its doors close, so that no aircraft
// taxis in or pushes back through its bridge.

import * as THREE from 'three';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { MeshBuilder, box } from '../builder.ts';
import { BRIDGE_FLOOR, BRIDGE_ROOF, BRIDGE_STEEL, BRIDGE_TUNNEL, type BridgeEnd } from '../static/terminals.ts';

/** Metres the end of a bridge pulls back from the door, and the shortest it gets. */
const RETRACT = 6;
const SHORTEST = 1.5;
/** Simulated seconds to reach out to the door or to pull back. */
const TRAVEL = 40;

export class BridgeLayer {
  readonly group = new THREE.Group();
  private readonly ends: readonly BridgeEnd[];
  private readonly tunnel: THREE.InstancedMesh;
  private readonly post: THREE.InstancedMesh;
  /** How far out each end is, 0 pulled back to 1 at the door. */
  private readonly out: Float32Array;
  private readonly matrix = new THREE.Matrix4();
  private last = Number.NaN;

  constructor(ends: readonly BridgeEnd[]) {
    this.ends = ends;
    this.out = new Float32Array(ends.length);
    this.group.name = 'jet-bridge-ends';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
    // A walkway one metre long, stretched to length per bridge; the post at the outer end.
    const walkway = new MeshBuilder();
    box(walkway, 0, 0, BRIDGE_FLOOR, BRIDGE_ROOF, 0.5, 1.55, 0, BRIDGE_TUNNEL, BRIDGE_TUNNEL);
    const post = new MeshBuilder();
    box(post, 0, 0, 0, BRIDGE_FLOOR, 0.45, 0.45, 0, BRIDGE_STEEL, BRIDGE_STEEL);
    this.tunnel = new THREE.InstancedMesh(walkway.build(), material, Math.max(1, ends.length));
    this.post = new THREE.InstancedMesh(post.build(), material, Math.max(1, ends.length));
    for (const mesh of [this.tunnel, this.post]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = ends.length;
      this.group.add(mesh);
    }
  }

  /** Move each end towards where its stand's aircraft needs it, at simulated time `now`. */
  update(aircraft: readonly Aircraft[], now: number): void {
    const docked = new Set<string>();
    for (const a of aircraft) if (a.phase === 'parked' && !a.visit.doorsClosed) docked.add(a.visit.stand);
    // The first time, and after a jump in time, the bridges are where they should be at once.
    const dt = now - this.last;
    const jump = !(dt >= 0 && dt < 600);
    this.last = now;
    const step = jump ? 1 : dt / TRAVEL;
    this.ends.forEach((end, i) => {
      const target = docked.has(end.stand) ? 1 : 0;
      this.out[i] = target > this.out[i] ? Math.min(target, this.out[i] + step) : Math.max(target, this.out[i] - step);
      const dx = end.x1 - end.x0;
      const dy = end.y1 - end.y0;
      const full = Math.hypot(dx, dy);
      const shortest = Math.min(full, Math.max(SHORTEST, full - RETRACT));
      const length = shortest + (full - shortest) * this.out[i];
      const ux = dx / full;
      const uy = dy / full;
      const c = ux;
      const s = uy;
      const tipX = end.x0 + ux * length;
      const tipY = end.y0 + uy * length;
      // Stretched along its length, overlapping the fixed part behind and reaching just past its post.
      const stretch = length + 1.6;
      this.matrix.set(c * stretch, 0, s, (end.x0 + tipX) / 2, 0, 1, 0, 0, -s * stretch, 0, c, -(end.y0 + tipY) / 2, 0, 0, 0, 1);
      this.tunnel.setMatrixAt(i, this.matrix);
      this.matrix.set(c, 0, s, tipX, 0, 1, 0, 0, -s, 0, c, -tipY, 0, 0, 0, 1);
      this.post.setMatrixAt(i, this.matrix);
    });
    this.tunnel.instanceMatrix.needsUpdate = true;
    this.post.instanceMatrix.needsUpdate = true;
  }
}
