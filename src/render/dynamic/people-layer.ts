// Draws everyone on foot. Near the camera each person is one of the library's characters, walking,
// standing or sitting as the simulation has them, dressed from its outfits, a travel party as its
// members side by side, one behind another in a line, or in the seats they took, with the
// suitcases they pull beside them. From further off people are small figures, a body and a head,
// so that a whole terminal's crowd stays cheap to draw.

import * as THREE from 'three';
import { CONFIG } from '../../sim/config.ts';
import type { Fittings } from '../../sim/terminal/fittings.ts';
import { ACT, POSE, ROLE, type People } from '../../sim/terminal/people.ts';
import { MeshBuilder, box, type RGB } from '../builder.ts';
import { Crowd, OUTFITS, flatMaterial, outfitTable, placement, type Models } from '../models/library.ts';

/** Clothing colours by palette index, for the far figures. The first entries are uniforms, by staff role. */
export const CLOTHING: number[] = [
  0x3b4a5e, 0x2b5fb3, 0x1f2f55, 0x7a1f2b, 0x3f7d4a, 0x8a8f96, 0xf2b01e, 0x20242b, 0x0f2f4f,
  0x4a5568, 0x6b7280, 0x374151, 0x7c2d12, 0x92400e, 0x166534, 0x1e3a8a, 0x5b21b6, 0x9d174d,
  0xb45309, 0x0f766e, 0xd1d5db, 0xe5e7eb, 0x111827, 0x57534e, 0xa8a29e, 0xbe123c, 0x0369a1,
];

const SKIN = [0xf1c9a5, 0xe0ac84, 0xc68658, 0x8d5a3b, 0x5c3a25, 0xf6d7bd];
const WHITE: RGB = [1, 1, 1];
/** Nearer than this, metres of camera distance, people round what the camera looks at are drawn as characters. */
const NEAR = 420;
/** How far from what the camera looks at people are drawn as characters, as a share of the camera's distance, and at most. */
const NEAR_REACH = 1.4;
const NEAR_REACH_MOST = 260;
/** Characters drawn at most in all; beyond that, people are figures. */
const NEAR_MOST = 3000;
/** Characters drawn at most, of each model. */
const PER_MODEL = 2500;
/** Metres one cycle of the walk carries a character, where the model does not say. */
const STRIDE = 1.55;
/** Seconds of one cycle of Polyfork's built-in Idle clip, which every character has. */
const IDLE_SECONDS = 2.5;
/** Faster than this, metres a second, a person runs. */
const RUNNING = 2.2;

/** Travellers' characters, and how often each is chosen. */
const TRAVELLERS: [string, number][] = [
  ['traveller-92f20c', 3],
  ['family-traveller-9af47e', 2],
  ['passenger-ac425a', 3],
  ['backpacker-f56207', 1],
  ['cafe-customer-ca7e8e', 2],
  ['salaryman-commuter-4170c1', 2],
  ['city-commuter-52a53f', 2],
  ['commuter-381e7f', 2],
  ['student-with-backpack-65d2b4', 1],
  ['student-in-a-hoodie-7c8223', 1],
  ['visitor-with-badge-1005a3', 1],
  ['spectator-d086fe', 1],
];
const CHILD = 'neighborhood-child-8cc5ac';
/** Staff by role; the crew are pilots and cabin crew in turn. */
const STAFF: Partial<Record<number, string[]>> = {
  [ROLE.security]: ['airport-security-officer-8fd38a'],
  [ROLE.agent]: ['check-in-agent-229fce'],
  [ROLE.gate]: ['check-in-agent-229fce'],
  [ROLE.shop]: ['barista-505240', 'shopkeeper-be5547'],
  [ROLE.cleaner]: ['baggage-handler-0823f5'],
  [ROLE.ramp]: ['baggage-handler-0823f5'],
  [ROLE.crew]: ['airline-pilot-63226a', 'flight-attendant-befaf4'],
  [ROLE.officer]: ['police-officer-1cc379'],
};
/** Models that are a uniform: their people differ in skin and hair, not in clothes. */
const UNIFORMS = new Set(['airport-security-officer-8fd38a', 'check-in-agent-229fce', 'airline-pilot-63226a', 'flight-attendant-befaf4', 'baggage-handler-0823f5', 'police-officer-1cc379', 'barista-505240', 'shopkeeper-be5547']);
const SUITCASE = 'spinner-suitcase-1a55f1';

function bodyGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Legs and torso as two boxes; about 1.5 m to the shoulders.
  box(b, 0, 0, 0, 0.82, 0.13, 0.19, 0, WHITE, WHITE);
  box(b, 0, 0, 0.82, 1.48, 0.15, 0.24, 0, WHITE, WHITE);
  return b.build();
}

function headGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  box(b, 0, 0, 1.5, 1.74, 0.11, 0.1, 0, WHITE, WHITE);
  return b.build();
}

/** A well-mixed number from a person's serial and a salt, for choosing what they look like. */
function mix(serial: number, salt: number): number {
  let h = (Math.imul(serial >>> 0, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export class PeopleLayer {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly colour = new THREE.Color();
  private readonly palette: THREE.Color[];
  private readonly skin: THREE.Color[];
  /** Beyond this camera distance nobody is drawn. */
  maxDistance = 3200;
  /** Which floors to draw: a person is shown when `floors[person's floor]` is true. */
  floors: boolean[] = [true, true, true];
  /** The seats the simulation sits people in, for drawing a party seated in a row. */
  fittings: Fittings | null = null;
  private readonly crowds = new Map<string, Crowd>();
  private readonly travellers: { crowd: Crowd; weight: number }[] = [];
  private travellerWeight = 0;
  private readonly bags: THREE.InstancedMesh | null;
  private bagCount = 0;
  /**
   * Per person, drawn: metres walked (which times the walk and run cycles to the ground covered),
   * where last drawn, and whose that was.
   */
  private readonly walked: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastY: Float32Array;
  private readonly lastSerial: Float64Array;
  private readonly matrix = new THREE.Matrix4();
  /** Seconds of real time, for the idle clip. */
  private time = 0;
  /** What the camera looks at, and the square of how far round it people are characters (negative: nobody). */
  private nearX = 0;
  private nearY = 0;
  private reach2 = -1;
  /** Per person, this frame: drawn as characters already. */
  private drawnNear: Uint8Array;

  constructor(capacity: number, models: Models | null = null) {
    this.capacity = capacity;
    this.group.name = 'people';
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.bodies = new THREE.InstancedMesh(bodyGeometry(), material, capacity);
    this.heads = new THREE.InstancedMesh(headGeometry(), material, capacity);
    // One set of matrices for both meshes.
    this.heads.instanceMatrix = this.bodies.instanceMatrix;
    for (const mesh of [this.bodies, this.heads]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.setColorAt(0, this.colour.set(0xffffff));
      this.group.add(mesh);
    }
    this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.palette = CLOTHING.map((c) => new THREE.Color(c));
    this.skin = SKIN.map((c) => new THREE.Color(c));
    this.walked = new Float32Array(capacity);
    this.lastX = new Float32Array(capacity);
    this.lastY = new Float32Array(capacity);
    this.lastSerial = new Float64Array(capacity).fill(-1);
    this.drawnNear = new Uint8Array(capacity);
    // The characters, each dressed in its own table of outfits.
    let seed = 1;
    const wanted = [...TRAVELLERS.map(([t]) => t), CHILD, ...Object.values(STAFF).flatMap((list) => list ?? [])];
    for (const id of new Set(wanted)) {
      const model = models?.get(id);
      if (!model || !model.poses) continue;
      const crowd = new Crowd(model, PER_MODEL, outfitTable(model, UNIFORMS.has(id), (seed += 1)));
      this.crowds.set(id, crowd);
      this.group.add(crowd.mesh);
    }
    for (const [id, weight] of TRAVELLERS) {
      const crowd = this.crowds.get(id);
      if (!crowd) continue;
      this.travellers.push({ crowd, weight });
      this.travellerWeight += weight;
    }
    const suitcase = models?.get(SUITCASE);
    this.bags = suitcase ? new THREE.InstancedMesh(suitcase.geometry, flatMaterial(), PER_MODEL * 2) : null;
    if (this.bags) {
      this.bags.name = 'luggage';
      this.bags.count = 0;
      this.bags.frustumCulled = false;
      this.bags.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colours = [0x1f2937, 0x7f1d1d, 0x1e3a8a, 0x14532d, 0x6b7280, 0x92400e, 0x312e81, 0xcbc852, 0xb94c34, 0x497aa2];
      for (let i = 0; i < PER_MODEL * 2; i += 1) this.bags.setColorAt(i, this.colour.set(colours[(i * 7) % colours.length]));
      this.group.add(this.bags);
    }
  }

  /** The character a member of a party is drawn as. */
  private crowdOf(people: People, id: number, member: number): Crowd | null {
    const serial = people.serial[id];
    const role = people.role[id];
    if (role !== ROLE.passenger) {
      const list = STAFF[role];
      return list ? (this.crowds.get(list[mix(serial, 3) % list.length]) ?? null) : null;
    }
    // In a party of three or four, the third and fourth are children.
    if (member >= 2 && people.size[id] >= 3) return this.crowds.get(CHILD) ?? null;
    let pick = (mix(serial, 11 + member) % 1000) / 1000 * this.travellerWeight;
    for (const t of this.travellers) {
      if ((pick -= t.weight) < 0) return t.crowd;
    }
    return this.travellers[0]?.crowd ?? null;
  }

  /**
   * `alpha` is how far the frame is between the last two simulation steps; (`focusX`, `focusY`)
   * is the point on the map the camera looks at. People near it are drawn as characters, the rest
   * as figures.
   */
  update(people: People, alpha: number, cameraDistance: number, focusX = 0, focusY = 0, time = 0): void {
    this.time = time;
    const visible = this.group.visible && cameraDistance <= this.maxDistance;
    const near = visible && this.crowds.size > 0 && cameraDistance <= NEAR;
    const reach = near ? Math.min(NEAR_REACH_MOST, cameraDistance * NEAR_REACH) : -1;
    this.nearX = focusX;
    this.nearY = focusY;
    this.reach2 = reach * Math.abs(reach);
    for (const crowd of this.crowds.values()) crowd.begin();
    this.bagCount = 0;
    if (near) this.drawNear(people, alpha);
    else this.drawnNear.fill(0, 0, people.high);
    this.drawFar(people, alpha, visible);
    for (const crowd of this.crowds.values()) crowd.end();
    if (this.bags) {
      this.bags.count = this.bagCount;
      this.bags.instanceMatrix.needsUpdate = true;
    }
  }

  private drawNear(people: People, alpha: number): void {
    const seats = this.fittings?.seats;
    let drawn = 0;
    this.drawnNear.fill(0, 0, people.high);
    for (let id = 0; id < people.high && drawn < NEAR_MOST; id += 1) {
      if (!people.alive[id] || !this.floors[people.floor[id]]) continue;
      const x = people.px[id] + (people.x[id] - people.px[id]) * alpha;
      const y = people.py[id] + (people.y[id] - people.py[id]) * alpha;
      const fx = x - this.nearX;
      const fy = y - this.nearY;
      if (fx * fx + fy * fy > this.reach2) continue;
      this.drawnNear[id] = 1;
      drawn += Math.max(1, people.size[id]);
      const h = people.ph[id] + (people.h[id] - people.ph[id]) * alpha;
      const serial = people.serial[id];
      // How far through the walk: by the distance walked since last drawn.
      if (this.lastSerial[id] !== serial) {
        this.lastSerial[id] = serial;
        this.lastX[id] = x;
        this.lastY[id] = y;
        this.walked[id] = (mix(serial, 7) % 1000) / 100;
      }
      const moved = Math.hypot(x - this.lastX[id], y - this.lastY[id]);
      if (moved < 5) this.walked[id] = (this.walked[id] + moved) % 10000;
      this.lastX[id] = x;
      this.lastY[id] = y;
      const dx = people.x[id] - people.px[id];
      const dy = people.y[id] - people.py[id];
      const walking = dx * dx + dy * dy > 0.0004;
      const facing = walking ? Math.atan2(dy, dx) : people.facing[id];
      const c = Math.cos(facing);
      const s = Math.sin(facing);
      const size = Math.max(1, people.size[id]);
      const sitting = people.pose[id] === POSE.sitting && people.seat[id] >= 0 && seats;
      const queued = people.act[id] === ACT.queued || people.act[id] === ACT.served;
      // Metres a second over the last step: on the move faster than anyone walks, not stepping up
      // in a line, is a run (a jump of more than a few metres is a change of floor, not a pace).
      const pace = Math.sqrt(dx * dx + dy * dy) / CONFIG.dt;
      const running = walking && !queued && pace > RUNNING && pace < 8;
      const luggage = people.luggage[id];
      for (let member = 0; member < size; member += 1) {
        const crowd = this.crowdOf(people, id, member);
        if (!crowd) continue;
        const outfit = mix(serial, 23 + member) % OUTFITS;
        const tall = 0.94 + (mix(serial, 31 + member) % 120) / 1000;
        let mx = x;
        let my = y;
        let face = facing;
        let frame: number;
        if (sitting) {
          const seat = people.seat[id] + member;
          mx = seats[seat * 3];
          my = seats[seat * 3 + 1];
          face = seats[seat * 3 + 2];
          frame = crowd.pose('sit')[0];
        } else {
          // Forward and to the left of the party's point: side by side walking, one behind
          // another in a line, a loose knot standing about.
          let ahead = 0;
          let left = 0;
          if (walking) {
            left = (member - (Math.min(size, 2) - 1) / 2) * 0.62 * (member < 2 ? 1 : 0);
            ahead = member < 2 ? 0 : -0.75;
            if (member >= 2) left = (member - 2.5) * 0.55;
          } else if (queued) {
            ahead = -member * 0.62;
            left = member % 2 ? 0.18 : -0.08;
          } else {
            const knot = [[0, 0], [-0.15, 0.6], [-0.65, -0.3], [-0.7, 0.45]][member] ?? [-member * 0.4, 0];
            [ahead, left] = knot;
            face += (((mix(serial, 41 + member) % 100) / 100) - 0.5) * 0.9;
          }
          mx = x + c * ahead - s * left;
          my = y + s * ahead + c * left;
          if (walking) {
            // The built-in walk, or run when faster than walking, timed to the ground covered so
            // that a planted foot stays planted: one cycle for every stride the model takes.
            const run = running && crowd.pose('run')[1] > 1;
            const [first, count] = crowd.pose(run ? 'run' : 'walk');
            const stride = ((run ? crowd.model.info.runStride : crowd.model.info.stride) ?? STRIDE) * tall;
            frame = first + (Math.floor((((this.walked[id] / stride + member * 0.37) % 1) + 1) % 1 * count) % count);
          } else {
            // The built-in idle, each person at their own point in it: breathing, shifting their weight.
            const [first, count] = crowd.pose('idle');
            frame = first + (Math.floor((((this.time / IDLE_SECONDS + (mix(serial, 53 + member) % 1000) / 1000) % 1) + 1) % 1 * count) % count);
          }
        }
        crowd.add(mx, my, h, face, frame, outfit, member >= 2 && size >= 3 ? 1 : tall);
        // A suitcase each, for as many members as the party has bags, pulled behind or stood beside.
        if (this.bags && member < luggage && !sitting && this.bagCount < this.bags.instanceMatrix.count) {
          const fc = Math.cos(face);
          const fs = Math.sin(face);
          const back = walking ? 0.5 : -0.05;
          const right = walking ? 0.3 : 0.42;
          const bx = mx - fc * back + fs * right;
          const by = my - fs * back - fc * right;
          this.bags.setMatrixAt(this.bagCount, placement(this.matrix, bx, by, h, face, 0.85, 0.85, 0.85, walking ? 0.5 : 0));
          this.bagCount += 1;
        }
      }
    }
  }

  private drawFar(people: People, alpha: number, show: boolean): void {
    let count = 0;
    if (show) {
      const matrices = this.bodies.instanceMatrix.array as Float32Array;
      for (let id = 0; id < people.high && count < this.capacity; id += 1) {
        if (!people.alive[id] || !this.floors[people.floor[id]] || this.drawnNear[id]) continue;
        const x = people.px[id] + (people.x[id] - people.px[id]) * alpha;
        const y = people.py[id] + (people.y[id] - people.py[id]) * alpha;
        const h = people.ph[id] + (people.h[id] - people.ph[id]) * alpha;
        // Face the way they are moving; standing people face the way the simulation turns them.
        const dx = people.x[id] - people.px[id];
        const dy = people.y[id] - people.py[id];
        const heading = dx * dx + dy * dy > 0.0004 ? Math.atan2(dy, dx) : people.facing[id];
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        const size = Math.max(1, people.size[id]);
        for (let member = 0; member < size && count < this.capacity; member += 1) {
          // Members walk abreast, a little staggered, about half a metre apart.
          const across = (member - (size - 1) / 2) * 0.55;
          const back = (member % 2) * 0.35;
          const mx = x - s * across - c * back;
          const my = y + c * across - s * back;
          const o = count * 16;
          matrices[o] = c;
          matrices[o + 1] = 0;
          matrices[o + 2] = -s;
          matrices[o + 3] = 0;
          matrices[o + 4] = 0;
          matrices[o + 5] = member > 1 && size > 2 ? 0.72 : 1;
          matrices[o + 6] = 0;
          matrices[o + 7] = 0;
          matrices[o + 8] = s;
          matrices[o + 9] = 0;
          matrices[o + 10] = c;
          matrices[o + 11] = 0;
          matrices[o + 12] = mx;
          matrices[o + 13] = h;
          matrices[o + 14] = -my;
          matrices[o + 15] = 1;
          // Members of a party dress differently; staff all wear the uniform.
          const tint = people.role[id] === 0 ? (people.colour[id] + member * 3) % this.palette.length : people.colour[id];
          this.bodies.setColorAt(count, this.palette[tint]);
          this.heads.setColorAt(count, this.skin[(id * 7 + member) % this.skin.length]);
          count += 1;
        }
      }
    }
    this.bodies.count = count;
    this.heads.count = count;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
  }
}
