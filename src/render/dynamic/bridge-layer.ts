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
/** Where the forward door is: this share of the length behind the nose, at least this far. */
const DOOR_BACK = 0.12;
const DOOR_BACK_LEAST = 4.2;
/** How far off the fuselage's side the bridge stops, metres. */
const DOOR_GAP = 0.4;

/**
 * Where a parked aircraft's forward door is for a bridge whose pivot is at (px, py): on the side
 * of the fuselage facing the pivot, a little behind the nose, just off the skin.
 */
export function doorFor(a: Pick<Aircraft, 'x' | 'y' | 'heading' | 'type'>, px: number, py: number): { x: number; y: number } {
  const fx = Math.cos(a.heading);
  const fy = Math.sin(a.heading);
  // Left of the way the nose points; the right if the bridge comes from that side.
  let sx = -fy;
  let sy = fx;
  if ((px - a.x) * sx + (py - a.y) * sy < 0) {
    sx = -sx;
    sy = -sy;
  }
  const along = a.type.length / 2 - Math.max(DOOR_BACK_LEAST, DOOR_BACK * a.type.length);
  const out = a.type.fuselage / 2 + DOOR_GAP;
  return { x: a.x + fx * along + sx * out, y: a.y + fy * along + sy * out };
}

export class BridgeLayer {
  readonly group = new THREE.Group();
  private readonly ends: readonly BridgeEnd[];
  private readonly tunnel: THREE.InstancedMesh;
  private readonly post: THREE.InstancedMesh;
  /** How far out each end is, 0 pulled back to 1 at the door. */
  private readonly out: Float32Array;
  /** Where each end reaches to at the door: the last aircraft's door, or as mapped before any. */
  private readonly doorX: Float64Array;
  private readonly doorY: Float64Array;
  private readonly matrix = new THREE.Matrix4();
  private last = Number.NaN;

  constructor(ends: readonly BridgeEnd[]) {
    this.ends = ends;
    this.out = new Float32Array(ends.length);
    this.doorX = Float64Array.from(ends, (e) => e.x1);
    this.doorY = Float64Array.from(ends, (e) => e.y1);
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
    const docked = new Map<string, Aircraft>();
    for (const a of aircraft) if (a.phase === 'parked' && !a.visit.doorsClosed) docked.set(a.visit.stand, a);
    // The first time, and after a jump in time, the bridges are where they should be at once.
    const dt = now - this.last;
    const jump = !(dt >= 0 && dt < 600);
    this.last = now;
    const step = jump ? 1 : dt / TRAVEL;
    this.ends.forEach((end, i) => {
      const at = docked.get(end.stand);
      if (at) {
        const door = doorFor(at, end.x0, end.y0);
        this.doorX[i] = door.x;
        this.doorY[i] = door.y;
      }
      const target = at ? 1 : 0;
      this.out[i] = target > this.out[i] ? Math.min(target, this.out[i] + step) : Math.max(target, this.out[i] - step);
      // Pulled back, the end lies along the mapped line, short of where it reaches; out, it swings
      // round on its pivot to the door of the aircraft at the stand.
      const mx = end.x1 - end.x0;
      const my = end.y1 - end.y0;
      const mapped = Math.hypot(mx, my);
      const back = Math.min(mapped, Math.max(SHORTEST, mapped - RETRACT));
      const restX = end.x0 + (mx / mapped) * back;
      const restY = end.y0 + (my / mapped) * back;
      const tipX = restX + (this.doorX[i] - restX) * this.out[i];
      const tipY = restY + (this.doorY[i] - restY) * this.out[i];
      const length = Math.max(0.5, Math.hypot(tipX - end.x0, tipY - end.y0));
      const c = (tipX - end.x0) / length;
      const s = (tipY - end.y0) / length;
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
