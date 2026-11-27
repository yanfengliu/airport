// Draws the moving ends of the jet bridges: pulled back from the stand while no aircraft is there,
// out to the door once one has parked, and back again when its doors close, so that no aircraft
// taxis in or pushes back through its bridge. Each is the moving half of Polyfork's jet bridge
// (its fixed half is drawn with the static world, src/render/static/bridges.ts): the telescoping
// tunnel, turning on the rotunda and drawn out or in to reach the aircraft, sloping from the
// rotunda's floor to the sill of the aircraft's door; the cab, turning on its drum at the tunnel's
// end square to the door as it reaches it, so that a bridge coming from ahead of the aircraft does
// not run over its nose; and the lift under the tunnel's end, its wheels on the ground, its legs
// drawn out and its columns rising with the tunnel. Without the models, plain boxes.

import * as THREE from 'three';
import { airframe } from '../../shared/airframe.ts';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import { MeshBuilder, box } from '../builder.ts';
import { flatMaterial, type Model, type Models } from '../models/library.ts';
import { BRIDGE_FLOOR, BRIDGE_PARTS, BRIDGE_RETRACT, BRIDGE_ROOF, BRIDGE_SHORTEST, BRIDGE_STEEL, BRIDGE_TUNNEL, JET_BRIDGE, type BridgeEnd } from '../static/bridges.ts';

/** Metres the end of a bridge pulls back, and the shortest it gets without the models (with them, BRIDGE_SHORTEST). */
const RETRACT = BRIDGE_RETRACT;
const SHORTEST = 1.5;
const SHORTEST_DRAWN = BRIDGE_SHORTEST;
/** Simulated seconds to reach out to the door or to pull back. */
const TRAVEL = 40;
/** How far off the fuselage's side the bridge stops, metres. */
const DOOR_GAP = 0.4;
/** Length of the cab at the end of the tunnel, which turns to meet the door square on, metres, without the models. */
const CAB = 2.8;
/** The shortest the tunnel is drawn in, as a share of its length as made. */
const SQUEEZE = 0.1;
/** The legs of the lift are never drawn shorter than this share of their length as made. */
const LEGS_LEAST = 0.1;

/**
 * Where a parked aircraft's forward door is for a bridge whose pivot is at (px, py): on the side
 * of the fuselage facing the pivot, at the door of the aircraft as drawn, just off its skin.
 */
export function doorFor(a: Pick<Aircraft, 'x' | 'y' | 'heading' | 'type'>, px: number, py: number): { x: number; y: number; nx: number; ny: number } {
  const fx = Math.cos(a.heading);
  const fy = Math.sin(a.heading);
  // Left of the way the nose points; the right if the bridge comes from that side.
  let sx = -fy;
  let sy = fx;
  if ((px - a.x) * sx + (py - a.y) * sy < 0) {
    sx = -sx;
    sy = -sy;
  }
  // The front left door of the aircraft as drawn, and the side of its fuselage.
  const f = airframe(a.type);
  const along = f.doors.front.x;
  const out = f.ry + DOOR_GAP;
  return { x: a.x + fx * along + sx * out, y: a.y + fy * along + sy * out, nx: sx, ny: sy };
}

/** The moving parts of Polyfork's bridge, each drawn once per bridge end. */
interface Parts {
  tunnel: THREE.InstancedMesh;
  cab: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
  legs: THREE.InstancedMesh;
  lift: THREE.InstancedMesh;
}

/** Without the models: a walkway, the cab, and a post under the walkway's end. */
interface Boxes {
  tunnel: THREE.InstancedMesh;
  cab: THREE.InstancedMesh;
  post: THREE.InstancedMesh;
}

export class BridgeLayer {
  readonly group = new THREE.Group();
  private readonly ends: readonly BridgeEnd[];
  /** Polyfork's bridge's moving parts, when the models loaded; else the boxes. */
  private readonly parts: Parts | null;
  private readonly boxes: Boxes | null;
  /** How far out each end is, 0 pulled back to 1 at the door. */
  private readonly out: Float32Array;
  /** Where each end reaches to at the door: the last aircraft's door, or as mapped before any. */
  private readonly doorX: Float64Array;
  private readonly doorY: Float64Array;
  /** The way out from the fuselage's side at that door, and the height of its sill. */
  private readonly sideX: Float64Array;
  private readonly sideY: Float64Array;
  private readonly sill: Float32Array;
  private readonly matrix = new THREE.Matrix4();
  private last = Number.NaN;

  constructor(ends: readonly BridgeEnd[], models: Models = new Map()) {
    this.ends = ends;
    this.out = new Float32Array(ends.length);
    this.doorX = Float64Array.from(ends, (e) => e.x1);
    this.doorY = Float64Array.from(ends, (e) => e.y1);
    // Before any aircraft has parked, the cab carries straight on along the mapped line.
    this.sideX = Float64Array.from(ends, (e) => -(e.x1 - e.x0) / (Math.hypot(e.x1 - e.x0, e.y1 - e.y0) || 1));
    this.sideY = Float64Array.from(ends, (e) => -(e.y1 - e.y0) / (Math.hypot(e.x1 - e.x0, e.y1 - e.y0) || 1));
    this.sill = new Float32Array(ends.length).fill(JET_BRIDGE.cabFloor);
    this.group.name = 'jet-bridge-ends';
    const capacity = Math.max(1, ends.length);
    const got = Object.fromEntries(Object.entries(BRIDGE_PARTS).map(([part, id]) => [part, models.get(id)])) as Record<keyof typeof BRIDGE_PARTS, Model | undefined>;
    let meshes: THREE.InstancedMesh[];
    if (got.tunnel && got.cab && got.wheels && got.legs && got.lift) {
      const material = flatMaterial();
      const mesh = (model: Model, name: string): THREE.InstancedMesh => {
        const m = new THREE.InstancedMesh(model.geometry, material, capacity);
        m.name = name;
        return m;
      };
      this.parts = { tunnel: mesh(got.tunnel, 'jet-bridge-tunnels'), cab: mesh(got.cab, 'jet-bridge-cabs'), wheels: mesh(got.wheels, 'jet-bridge-wheels'), legs: mesh(got.legs, 'jet-bridge-legs'), lift: mesh(got.lift, 'jet-bridge-lifts') };
      this.boxes = null;
      meshes = Object.values(this.parts);
    } else {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
      // A walkway one metre long, stretched to length per bridge; the post at the outer end.
      const walkway = new MeshBuilder();
      box(walkway, 0, 0, BRIDGE_FLOOR, BRIDGE_ROOF, 0.5, 1.55, 0, BRIDGE_TUNNEL, BRIDGE_TUNNEL);
      const post = new MeshBuilder();
      box(post, 0, 0, 0, BRIDGE_FLOOR, 0.45, 0.45, 0, BRIDGE_STEEL, BRIDGE_STEEL);
      const cab = new MeshBuilder();
      box(cab, 0, 0, BRIDGE_FLOOR - 0.1, BRIDGE_ROOF + 0.15, CAB / 2, 1.75, 0, BRIDGE_STEEL, BRIDGE_TUNNEL);
      this.parts = null;
      this.boxes = { tunnel: new THREE.InstancedMesh(walkway.build(), material, capacity), cab: new THREE.InstancedMesh(cab.build(), material, capacity), post: new THREE.InstancedMesh(post.build(), material, capacity) };
      meshes = Object.values(this.boxes);
    }
    for (const mesh of meshes) {
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
    // From the middle of the cab's drum to its face at the door.
    const cabLength = this.parts ? JET_BRIDGE.door - JET_BRIDGE.drum : CAB;
    const shortest = this.parts ? SHORTEST_DRAWN : SHORTEST;
    this.ends.forEach((end, i) => {
      const at = docked.get(end.stand);
      if (at) {
        const door = doorFor(at, end.x0, end.y0);
        this.doorX[i] = door.x;
        this.doorY[i] = door.y;
        this.sideX[i] = door.nx;
        this.sideY[i] = door.ny;
        this.sill[i] = airframe(at.type).doors.front.sill;
      }
      const target = at ? 1 : 0;
      this.out[i] = target > this.out[i] ? Math.min(target, this.out[i] + step) : Math.max(target, this.out[i] - step);
      // Pulled back, the end lies along the mapped line, short of where it reaches; out, it swings
      // round on its pivot to the door of the aircraft at the stand.
      const mx = end.x1 - end.x0;
      const my = end.y1 - end.y0;
      const mapped = Math.hypot(mx, my);
      const back = Math.min(mapped, Math.max(shortest, mapped - RETRACT));
      const restX = end.x0 + (mx / mapped) * back;
      const restY = end.y0 + (my / mapped) * back;
      // Out, the tunnel's tip (with the models, the middle of the cab's drum) is a cab's length off
      // the side of the fuselage at the door.
      const reachX = this.doorX[i] + this.sideX[i] * cabLength;
      const reachY = this.doorY[i] + this.sideY[i] * cabLength;
      const tipX = restX + (reachX - restX) * this.out[i];
      const tipY = restY + (reachY - restY) * this.out[i];
      const length = Math.max(0.5, Math.hypot(tipX - end.x0, tipY - end.y0));
      const c = (tipX - end.x0) / length;
      const s = (tipY - end.y0) / length;
      // The cab: along the tunnel while pulled back, turning square to the door as it reaches it.
      let kx = c + (-this.sideX[i] - c) * this.out[i];
      let ky = s + (-this.sideY[i] - s) * this.out[i];
      const k = Math.hypot(kx, ky) || 1;
      kx /= k;
      ky /= k;
      if (this.parts) this.place(this.parts, i, end, tipX, tipY, length, c, s, kx, ky);
      else if (this.boxes) this.placeBoxes(this.boxes, i, end, tipX, tipY, length, c, s, kx, ky);
    });
    for (const mesh of this.group.children) (mesh as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }

  /**
   * Polyfork's parts for end `i`, the tunnel from the rotunda at the pivot to its tip at the middle
   * of the cab's drum, `length` away along (c, s); the cab facing (kx, ky). The model's x runs along
   * the bridge, its y up and its z across to the right.
   */
  private place(parts: Parts, i: number, end: BridgeEnd, tipX: number, tipY: number, length: number, c: number, s: number, kx: number, ky: number): void {
    const J = JET_BRIDGE;
    const [back, front] = J.tunnel;
    const made = front - back;
    // The tunnel is drawn out or in between the rotunda and the drum: the model's x goes to
    // `b + x * sx` metres along from the pivot.
    const sx = Math.max(SQUEEZE, (length - (back - J.rotunda) - (J.drum - front)) / made);
    const b = back - J.rotunda - back * sx;
    // Its floor stays at the rotunda's at the back and comes to the door's sill at the front, as it
    // reaches out: raised by `rise` at the front and in proportion along it.
    const rise = (this.sill[i] - J.cabFloor) * this.out[i];
    const slope = rise / made;
    const m = this.matrix;
    m.set(c * sx, 0, s, end.x0 + c * b, slope, 1, 0, -slope * back, -s * sx, 0, c, -(end.y0 + s * b), 0, 0, 0, 1);
    parts.tunnel.setMatrixAt(i, m);
    // The cab turns on the middle of its drum, at the tip, its floor raised with the tunnel's front.
    m.set(kx, 0, ky, tipX - kx * J.drum, 0, 1, 0, rise, -ky, 0, kx, -(tipY - ky * J.drum), 0, 0, 0, 1);
    parts.cab.setMatrixAt(i, m);
    // The lift where the model has it along the tunnel, not drawn out: its wheels on the ground,
    // its columns raised with the tunnel above them, and its legs reaching up to the columns.
    const a = b + (sx - 1) * J.lift;
    const [legsFrom, legsTo] = J.legs;
    const up = Math.max(-(1 - LEGS_LEAST) * (legsTo - legsFrom), slope * (J.lift - back));
    const ox = end.x0 + c * a;
    const oy = end.y0 + s * a;
    m.set(c, 0, s, ox, 0, 1, 0, 0, -s, 0, c, -oy, 0, 0, 0, 1);
    parts.wheels.setMatrixAt(i, m);
    m.set(c, 0, s, ox, 0, 1, 0, up, -s, 0, c, -oy, 0, 0, 0, 1);
    parts.lift.setMatrixAt(i, m);
    const tall = (legsTo - legsFrom + up) / (legsTo - legsFrom);
    m.set(c, 0, s, ox, 0, tall, 0, legsFrom * (1 - tall), -s, 0, c, -oy, 0, 0, 0, 1);
    parts.legs.setMatrixAt(i, m);
  }

  /** The plain boxes for end `i`: a walkway stretched from the pivot to the tip, a post there, the cab beyond. */
  private placeBoxes(boxes: Boxes, i: number, end: BridgeEnd, tipX: number, tipY: number, length: number, c: number, s: number, kx: number, ky: number): void {
    const m = this.matrix;
    // Stretched along its length, overlapping the fixed part behind and reaching just past its post.
    const stretch = length + 1.6;
    m.set(c * stretch, 0, s, (end.x0 + tipX) / 2, 0, 1, 0, 0, -s * stretch, 0, c, -(end.y0 + tipY) / 2, 0, 0, 0, 1);
    boxes.tunnel.setMatrixAt(i, m);
    m.set(c, 0, s, tipX, 0, 1, 0, 0, -s, 0, c, -tipY, 0, 0, 0, 1);
    boxes.post.setMatrixAt(i, m);
    const cx = tipX + (kx * CAB) / 2;
    const cy = tipY + (ky * CAB) / 2;
    m.set(kx, 0, ky, cx, 0, 1, 0, 0, -ky, 0, kx, -cy, 0, 0, 0, 1);
    boxes.cab.setMatrixAt(i, m);
  }
}
