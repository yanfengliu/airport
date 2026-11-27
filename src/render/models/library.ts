// The models drawn from public/models: Polyfork's low-poly furniture, equipment, luggage and
// people (CC BY 4.0, credited in public/models/CREDITS.md, converted by tools/models/polyfork.ts).
// Each is a mesh of flat faces coloured by slot. Props are drawn many at a time as instances.
// People are posed on the GPU from the bone matrices of their poses, a walk cycle, standing and
// sitting, and dressed from a table of colours in which each row is an outfit, so that one model
// gives a crowd of people dressed differently: the customizable part of the library.

import * as THREE from 'three';

export interface ModelInfo {
  id: string;
  name: string;
  role: 'prop' | 'character';
  credit: string;
  page: string;
  changed: string;
  /** Real size, metres: across its front, height, depth. */
  size: [number, number, number];
  file: string;
  vertices: number;
  triangles: number;
  box: number[];
  palette: number[];
  /** For characters, the part each colour slot is on: body, hair, top, coat, bottom, feet... */
  parts?: string[];
  bones?: number;
  poses?: Record<string, [number, number]>;
}

export interface Model {
  info: ModelInfo;
  /** Positions in metres in the model's own frame (y up, front +z), a slot per vertex, for characters a bone. */
  geometry: THREE.BufferGeometry;
  /** For characters: 12 numbers per bone per pose, the rows of each bone's 3x4 matrix. */
  poses: Float32Array | null;
  /** Vertices on each colour slot. */
  slotCounts: number[];
}

export type Models = ReadonlyMap<string, Model>;

export async function loadModels(base = `${import.meta.env.BASE_URL}models/`): Promise<Models> {
  const response = await fetch(`${base}index.json`);
  if (!response.ok) throw new Error(`Could not load the models (${response.status})`);
  const index = (await response.json()) as { models: ModelInfo[] };
  const entries = await Promise.all(
    index.models.map(async (info) => {
      const file = await fetch(`${base}${info.file}`);
      if (!file.ok) throw new Error(`Could not load ${info.file} (${file.status})`);
      return [info.id, decode(info, await file.arrayBuffer())] as const;
    }),
  );
  return new Map(entries);
}

/** The credits for every model, one line each, as CC BY asks. */
export function credits(models: Models): string[] {
  return [...models.values()].map((m) => m.info.credit);
}

function decode(info: ModelInfo, data: ArrayBuffer): Model {
  const n = info.vertices;
  const q = new Int16Array(data, 0, n * 3);
  const position = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 3; k += 1) position[i * 3 + k] = info.box[k] + ((q[i * 3 + k] + 32768) / 65535) * info.box[3 + k];
  }
  let at = n * 6;
  const slots = new Uint8Array(data, at, n);
  at += n;
  let bones: Uint8Array | null = null;
  if (info.role === 'character') {
    bones = new Uint8Array(data, at, n);
    at += n;
  }
  at = Math.ceil(at / 4) * 4;
  const wide = n > 65535;
  const count = info.triangles * 3;
  const index = wide ? new Uint32Array(data.slice(at, at + count * 4)) : new Uint16Array(data.slice(at, at + count * 2));
  at += count * (wide ? 4 : 2);
  at = Math.ceil(at / 4) * 4;
  const poses = info.role === 'character' ? new Float32Array(data.slice(at)) : null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('slot', new THREE.BufferAttribute(Float32Array.from(slots), 1));
  if (bones) geometry.setAttribute('bone', new THREE.BufferAttribute(Float32Array.from(bones), 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const slotCounts = new Array<number>(info.palette.length / 3).fill(0);
  for (const s of slots) slotCounts[s] += 1;
  if (info.role === 'prop') {
    const colour = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) colour[i * 3 + k] = info.palette[slots[i] * 3 + k];
    geometry.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  }
  geometry.computeBoundingSphere();
  return { info, geometry, poses, slotCounts };
}

/** The look every model is drawn with: flat faces, lit, coloured per vertex, as they were made. */
export function flatMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

const matrix = new THREE.Matrix4();
const rotation = new THREE.Quaternion();
const turn = new THREE.Quaternion();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);
const xAxis = new THREE.Vector3(1, 0, 0);

/**
 * A model's instance matrix: standing at map point (x, y) at height h, its front (+z) facing map
 * direction `facing`, scaled by sx, sy, sz, and tipped `tilt` radians forward about its own x axis.
 */
export function placement(out: THREE.Matrix4, x: number, y: number, h: number, facing: number, sx = 1, sy = 1, sz = 1, tilt = 0): THREE.Matrix4 {
  rotation.setFromAxisAngle(yAxis, facing + Math.PI / 2);
  if (tilt) rotation.multiply(turn.setFromAxisAngle(xAxis, tilt));
  position.set(x, h, -y);
  scale.set(sx, sy, sz);
  return out.compose(position, rotation, scale);
}

/** Many copies of one prop, placed once: one draw call. */
export function propInstances(model: Model, material: THREE.Material, places: readonly { x: number; y: number; h: number; facing: number; sx?: number; sy?: number; sz?: number; tilt?: number }[], name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(model.geometry, material, Math.max(1, places.length));
  mesh.name = name;
  places.forEach((p, i) => mesh.setMatrixAt(i, placement(matrix, p.x, p.y, p.h, p.facing, p.sx, p.sy, p.sz, p.tilt)));
  mesh.count = places.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- people ------------------------------------------------------------------------------

/** Outfits drawn for each character model: row 0 as it was made, the rest dressed afresh. */
export const OUTFITS = 32;

const SKIN = [0xf1c9a5, 0xe8b98e, 0xd49e74, 0xb07a52, 0x8d5a3b, 0x6b4430, 0xf6d7bd, 0xc58f6a];
const HAIR = [0x2b2018, 0x4a3022, 0x6b4a2e, 0x8a6a45, 0xb9935c, 0xd8c08a, 0x1d1d1f, 0x7d7f84, 0xa04a2a, 0xc9c4bc];
const CLOTHES = [0x3a4d6b, 0x586f84, 0x282f3f, 0x696568, 0x948f8f, 0xb94c34, 0xae6051, 0xcbc852, 0x8baa52, 0x658049, 0x497aa2, 0x3e6495, 0x836047, 0x9b855d, 0x4c3a43, 0xc19a95, 0xdddbdc, 0x47592d, 0x728d9e, 0x575451];
const TROUSERS = [0x2f3d58, 0x3b4a6b, 0x282f3f, 0x575451, 0x7b787c, 0x9b855d, 0x47592d, 0x1f2328];
const SHOES = [0x282f3f, 0x1f2328, 0x575451, 0x836047, 0xdddbdc, 0x4c3a43];
const GARMENT_PARTS = new Set(['top', 'coat', 'bottom', 'feet', 'back', 'hat', 'neck', 'belt', 'hands']);

/** A small fixed sequence of numbers in [0, 1) from a seed, for dressing people the same every time. */
function sequence(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The outfit table of a character model: OUTFITS rows of linear RGBA, one texel a colour slot.
 * Row 0 is the model as made. In the others, skin and hair take a new tone and, unless the model
 * wears a uniform, each garment a new colour; every colour on a part keeps its brightness against
 * the part's main colour, so stitching, trim and soles still show.
 */
export function outfitTable(model: Model, uniform: boolean, seed: number): Float32Array {
  const info = model.info;
  const slots = info.palette.length / 3;
  const parts = info.parts ?? [];
  const table = new Float32Array(OUTFITS * slots * 4);
  // The main colour of each part: the one on most vertices.
  const main = new Map<string, number>();
  for (let s = 0; s < slots; s += 1) {
    const p = parts[s] ?? 'body';
    const m = main.get(p);
    if (m === undefined || model.slotCounts[s] > model.slotCounts[m]) main.set(p, s);
  }
  const colour = new THREE.Color();
  for (let row = 0; row < OUTFITS; row += 1) {
    const next = sequence(seed * 7919 + row * 104729 + 17);
    const pick = (list: number[]): [number, number, number] => {
      colour.setHex(list[Math.floor(next() * list.length)]);
      return [colour.r, colour.g, colour.b];
    };
    const targets = new Map<string, [number, number, number]>();
    if (row > 0) {
      targets.set('body', pick(SKIN));
      targets.set('hair', pick(HAIR));
      if (!uniform) {
        for (const p of new Set(parts)) {
          if (!GARMENT_PARTS.has(p)) continue;
          targets.set(p, pick(p === 'bottom' ? TROUSERS : p === 'feet' ? SHOES : CLOTHES));
        }
      }
    }
    for (let s = 0; s < slots; s += 1) {
      const o = (row * slots + s) * 4;
      const r = info.palette[s * 3];
      const g = info.palette[s * 3 + 1];
      const b = info.palette[s * 3 + 2];
      const p = parts[s] ?? 'body';
      const target = targets.get(p);
      if (!target) {
        table[o] = r;
        table[o + 1] = g;
        table[o + 2] = b;
      } else {
        const m = main.get(p)!;
        const ratio = luminance(r, g, b) / Math.max(1e-4, luminance(info.palette[m * 3], info.palette[m * 3 + 1], info.palette[m * 3 + 2]));
        table[o] = Math.min(1, target[0] * ratio);
        table[o + 1] = Math.min(1, target[1] * ratio);
        table[o + 2] = Math.min(1, target[2] * ratio);
      }
      table[o + 3] = 1;
    }
  }
  return table;
}

/**
 * A character model drawn for many people at once: each instance carries a pose frame and an
 * outfit row; the vertex shader moves every vertex by its bone's matrix in that frame and colours
 * it from that row.
 */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  readonly model: Model;
  readonly capacity: number;
  /** Per instance: the pose frame, and the outfit row. */
  readonly look: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(model: Model, capacity: number, outfits: Float32Array) {
    this.model = model;
    this.capacity = capacity;
    const info = model.info;
    const bones = info.bones ?? 1;
    const frames = model.poses!.length / (bones * 12);
    const poses = new THREE.DataTexture(model.poses!, bones * 3, frames, THREE.RGBAFormat, THREE.FloatType);
    poses.needsUpdate = true;
    const table = new THREE.DataTexture(outfits, info.palette.length / 3, OUTFITS, THREE.RGBAFormat, THREE.FloatType);
    table.needsUpdate = true;
    const geometry = model.geometry.clone();
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.look.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('look', this.look);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPoses = { value: poses };
      shader.uniforms.uOutfits = { value: table };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float slot;\nattribute float bone;\nattribute vec2 look;\nuniform highp sampler2D uPoses;\nuniform highp sampler2D uOutfits;',
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed;
          {
            int b = int(bone + 0.5);
            int f = int(look.x + 0.5);
            vec4 p = vec4(position, 1.0);
            transformed = vec3(dot(texelFetch(uPoses, ivec2(b * 3, f), 0), p), dot(texelFetch(uPoses, ivec2(b * 3 + 1, f), 0), p), dot(texelFetch(uPoses, ivec2(b * 3 + 2, f), 0), p));
          }`,
        )
        .replace('#include <color_vertex>', 'vColor = vec4(texelFetch(uOutfits, ivec2(int(slot + 0.5), int(look.y + 0.5)), 0).rgb, 1.0);');
    };
    material.customProgramCacheKey = () => `crowd-${info.id}`;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = `crowd-${info.id}`;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** First frame and number of frames of a pose: 'walk', 'stand' or 'sit'. */
  pose(name: string): [number, number] {
    return this.model.info.poses?.[name] ?? [0, 1];
  }

  begin(): void {
    this.count = 0;
  }

  /** Add one person; false when this model's crowd is full. */
  add(x: number, y: number, h: number, facing: number, frame: number, outfit: number, size = 1): boolean {
    if (this.count >= this.capacity) return false;
    this.mesh.setMatrixAt(this.count, placement(matrix, x, y, h, facing, size, size, size));
    this.look.setXY(this.count, frame, outfit);
    this.count += 1;
    return true;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.look.needsUpdate = true;
  }
}
