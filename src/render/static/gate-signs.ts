import * as THREE from 'three';
import { InnerWalls, withinAny } from '../../sim/terminal/fittings.ts';
import type { Fitting } from '../../sim/terminal/fittings.ts';
import { FLOOR, FLOOR_HEIGHT } from '../../sim/terminal/plan.ts';
import type { Terminals } from '../../sim/terminal/terminals.ts';
import { MeshBuilder, rgb } from '../builder.ts';

export const GATE_SIGN_MODEL = 'overhead-wayfinding-sign-64d4e8';
// The existing sign's printed face runs from 2.73 to 3.07 m high, 0.148 m out from its centre.
const FACE_HEIGHT = 2.90;
const HALF_WIDTH = 1.16;
const HALF_HEIGHT = 0.167;
const FACE_DEPTH = 0.152;

export interface GateSign {
  label: string;
  x: number;
  y: number;
  h: number;
  facing: number;
  podium?: Fitting;
}

/** Each room uses its assigned boarding queue. Both ends and the middle of the overhead board
 * stay inside the building and clear of its interior walls. */
export function gateSigns(t: Terminals): GateSign[] {
  const signs: GateSign[] = [];
  const indoors = withinAny(t.map.terminals.buildings.map((b) => b.poly));
  const walls = new InnerWalls(t.map.terminals.walls ?? [], t.plan.closed);
  for (const [label, gate] of t.plan.holdroom) {
    const queue = t.queues.get(gate.id);
    if (!queue) continue;
    const q = queue.shape;
    const ux = Math.cos(q.heading);
    const uy = Math.sin(q.heading);
    for (const part of [0.25, 0, -0.25]) {
      const x = q.x + ux * q.length * part;
      const y = q.y + uy * q.length * part;
      if (walls.across(FLOOR.airside, x, y, q.heading + Math.PI / 2, 1.21, 0.17)) continue;
      if (![-1.21, 0, 1.21].every((w) => indoors(x - uy * w, y + ux * w))) continue;
      if (signs.some((s) => Math.hypot(s.x - x, s.y - y) < 2.5)) continue;
      signs.push({ label, x, y, h: FLOOR_HEIGHT[FLOOR.airside], facing: q.heading + Math.PI });
      break;
    }
  }
  // A podium faces into the hall beside its gate. Some shared boarding doors have one desk.
  for (const podium of t.fittings.items) {
    if (podium.kind !== 'podium') continue;
    const facing = podium.heading - Math.PI / 2;
    let nearest = Infinity;
    let assigned: GateSign | undefined;
    for (const sign of signs) {
      const gate = t.plan.holdroom.get(sign.label)!;
      const distance = Math.hypot(podium.x - gate.x, podium.y - gate.y);
      if (distance >= nearest || distance > 8 || Math.cos(facing - gate.heading - Math.PI) < 0.9999) continue;
      assigned = sign;
      nearest = distance;
    }
    if (assigned) assigned.podium = podium;
  }
  return signs;
}

/** All gate identifiers share one printed face atlas and a single draw call for both sides. */
export function gateSignFaces(signs: readonly GateSign[]): THREE.Mesh | null {
  if (!signs.length) return null;
  const width = 256;
  const height = 40;
  const columns = 8;
  const rows = Math.ceil(signs.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = width * columns;
  canvas.height = height * rows;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#193351';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const b = new MeshBuilder();
  const white = rgb(0xffffff);
  signs.forEach((sign, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    const cx = (column + 0.5) * width;
    const cy = (row + 0.5) * height;
    ctx.font = '500 24px Helvetica, Arial, sans-serif';
    ctx.fillText('Gate', cx - 42, cy + 1);
    ctx.font = 'bold 36px Helvetica, Arial, sans-serif';
    ctx.fillText(sign.label, cx + 34, cy + 1);
    const face = (x: number, y: number, h: number, facing: number, depth: number, halfW: number, halfH: number, crop: number): void => {
      const nx = Math.cos(facing);
      const ny = Math.sin(facing);
      const vertex = (side: number, up: number) => b.vertex(
        x + nx * depth - side * ny * halfW,
        y + ny * depth + side * nx * halfW,
        h + up * halfH, nx, ny, 0, white,
        (column + 0.5 + side * crop / 2) / columns, 1 - (row + (1 - up) / 2) / rows,
      );
      b.quad(vertex(-1, -1), vertex(1, -1), vertex(1, 1), vertex(-1, 1));
    };
    // The back has its own outward winding and reads the same way as the front.
    for (const facing of [sign.facing, sign.facing + Math.PI]) face(sign.x, sign.y, sign.h + FACE_HEIGHT, facing, FACE_DEPTH, HALF_WIDTH, HALF_HEIGHT, 1);
    // The gate desk model carries a demonstration destination. Print the actual gate on its
    // passenger-facing display, in front of the moulded lettering inside the screen's bezel.
    if (sign.podium) face(sign.podium.x, sign.podium.y, sign.h + 2.12, sign.podium.heading - Math.PI / 2, -0.355, 0.614, 0.211, 0.72);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const mesh = new THREE.Mesh(b.build(), new THREE.MeshBasicMaterial({ map: texture }));
  mesh.name = 'interior-gate-identifiers';
  mesh.matrixAutoUpdate = false;
  return mesh;
}
