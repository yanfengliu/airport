#!/usr/bin/env node
// Convert the Polyfork models the app draws to the compact form it loads.
//
//   node tools/models/polyfork.ts [--dataset <dir>] [--refetch]
//
// Polyfork (https://polyfork.dev) publishes free low-poly models whose mesh files are under
// CC BY 4.0: free to share and change with a credit line, which public/models/CREDITS.md carries
// for every model here, with what was changed. Only the GLB mesh files are used; the source
// modules are under Polyfork's own licence and are not fetched.
//
// What each model is (its title, page and real size) comes from the owner's local Polyfork
// dataset, an index of the catalogue (`--dataset`, by default ../3d-maker/dataset/polyfork, its
// free-assets.json). A GLB the dataset holds is used from there; any other is fetched once from
// the link the index gives into artifacts/models/polyfork/ (not tracked). Each is converted into
// public/models/: per model a binary of quantized positions, a colour slot per vertex and the
// triangles, and for characters the bone each vertex follows and the bone matrices of each pose
// the app draws: frames of the built-in Walk, Idle and Run clips, and sitting, made from the
// standing pose. public/models/index.json lists them all with their palettes, sizes, credits and,
// for characters, how far a walk or a run cycle carries them. Vertices are welded, as the app
// shades every face flat.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'artifacts', 'models', 'polyfork');
const out = join(root, 'public', 'models');
const refetch = process.argv.includes('--refetch');
const dataset = process.argv.includes('--dataset') ? resolve(process.argv[process.argv.indexOf('--dataset') + 1]) : resolve(root, '..', '3d-maker', 'dataset', 'polyfork');
const AGENT = 'sfo-airport-sim/0.1 (open-source airport simulation; fetches each model once)';

type Role = 'prop' | 'character';
interface Wanted {
  id: string;
  role: Role;
  /** Names of parts left out, and why, for the credits. */
  drop?: RegExp;
  dropped?: string;
}

/** What a character holds in one hand: the app gives people their own luggage. */
const HELD = /^attach-(left|right)hand$/i;

/** The models the app draws: the terminal's furniture and equipment, luggage, and people. */
const MODELS: Wanted[] = [
  { id: 'check-in-desk-run-b96c12', role: 'prop' },
  { id: 'self-check-in-kiosk-3fe1c1', role: 'prop' },
  { id: 'x-ray-baggage-conveyor-b3d1cc', role: 'prop' },
  { id: 'security-body-scanner-ef6fcd', role: 'prop' },
  { id: 'walk-through-security-arch-5c2a43', role: 'prop' },
  { id: 'passport-control-booth-7724c6', role: 'prop' },
  { id: 'gate-boarding-desk-8e0555', role: 'prop' },
  { id: 'gate-seating-row-cc0ff3', role: 'prop' },
  { id: 'baggage-reclaim-carousel-7ceef0', role: 'prop', drop: /^bags?(-\d+)?$/i, dropped: 'the bags lying on it removed' },
  { id: 'queue-barrier-stanchion-run-1836c8', role: 'prop' },
  { id: 'departures-board-7b85c8', role: 'prop' },
  { id: 'overhead-wayfinding-sign-64d4e8', role: 'prop' },
  { id: 'passenger-luggage-trolley-2e11d7', role: 'prop' },
  { id: 'spinner-suitcase-1a55f1', role: 'prop' },
  { id: 'cafe-counter-d8b226', role: 'prop' },
  { id: 'cafe-table-set-1868d1', role: 'prop' },
  { id: 'bar-counter-run-ab3b08', role: 'prop' },
  { id: 'back-bar-shelf-unit-11ab89', role: 'prop' },
  { id: 'toy-shelf-3b4390', role: 'prop' },
  { id: 'newsstand-6dfd65', role: 'prop' },
  { id: 'velvet-tub-chair-b0b5f8', role: 'prop' },
  { id: 'lounge-drum-table-13d029', role: 'prop' },
  { id: 'floor-houseplant-8fad17', role: 'prop' },
  { id: 'vending-machine-471c29', role: 'prop' },
  { id: 'street-bin-770173', role: 'prop' },
  { id: 'atm-terminal-3b84f5', role: 'prop' },
  { id: 'traveller-92f20c', role: 'character', drop: HELD, dropped: 'the suitcase held in the hand removed' },
  { id: 'family-traveller-9af47e', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'passenger-ac425a', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'backpacker-f56207', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'cafe-customer-ca7e8e', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'neighborhood-child-8cc5ac', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'check-in-agent-229fce', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'airport-security-officer-8fd38a', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'airline-pilot-63226a', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'flight-attendant-befaf4', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'baggage-handler-0823f5', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'police-officer-1cc379', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'salaryman-commuter-4170c1', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'city-commuter-52a53f', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'commuter-381e7f', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'student-with-backpack-65d2b4', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'student-in-a-hoodie-7c8223', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'visitor-with-badge-1005a3', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'spectator-d086fe', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'barista-505240', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
  { id: 'shopkeeper-be5547', role: 'character', drop: HELD, dropped: 'what it held in its hand removed' },
];

/** Frames sampled from each character's built-in clips, and the seat height the sitting pose is made for, metres. */
const WALK_FRAMES = 16;
const IDLE_FRAMES = 12;
const RUN_FRAMES = 12;
const SEAT_HEIGHT = 0.46;

// ---- fetching ----------------------------------------------------------------------------------

async function get(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': AGENT } });
    if (response.status !== 429) return response;
    // Asked to slow down: wait as long as asked, or a while.
    const wait = Number(response.headers.get('retry-after') ?? 0) * 1000 || 5000 * (attempt + 1);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  throw new Error(`${url}: still refused after waiting`);
}

interface Meta {
  id: string;
  name: string;
  credit: string;
  page: string;
  triangles: number;
  size: [number, number, number];
}

/** A row of the dataset's index of free models. */
interface Row {
  id: string;
  title: string;
  free: boolean;
  page: string;
  triangles: number;
  size_m: { x: number; y: number; z: number };
  download?: { glb?: string };
}

let rows: Map<string, Row> | null = null;

/** The dataset's index of the free models, by id. */
function indexed(): Map<string, Row> {
  if (!rows) {
    const file = join(dataset, 'free-assets.json');
    if (!existsSync(file)) throw new Error(`No Polyfork dataset at ${dataset}: pass --dataset <dir> holding free-assets.json`);
    rows = new Map((JSON.parse(readFileSync(file, 'utf8')) as Row[]).map((r) => [r.id, r]));
  }
  return rows;
}

async function fetchModel(m: Wanted): Promise<{ glb: Buffer; meta: Meta }> {
  const row = indexed().get(m.id);
  if (!row) throw new Error(`${m.id}: not in the dataset's index at ${dataset}`);
  // Every free model's mesh files are offered under CC BY 4.0 (the dataset's INDEX-LICENSE.md and
  // https://polyfork.dev/licensing); the credit line is the one Polyfork gives each model.
  if (!row.free) throw new Error(`${m.id}: not a free model, so not under CC BY 4.0`);
  const meta: Meta = { id: m.id, name: row.title, credit: `${row.title} by Polyfork (${row.page}), CC BY 4.0`, page: row.page, triangles: row.triangles, size: [row.size_m.x, row.size_m.y, row.size_m.z] };
  const local = join(dataset, `${m.id}.glb`);
  if (existsSync(local) && !refetch) return { glb: readFileSync(local), meta };
  mkdirSync(cache, { recursive: true });
  const glbFile = join(cache, `${m.id}.glb`);
  if (refetch || !existsSync(glbFile)) {
    const file = await get(row.download?.glb ?? `https://polyfork.dev/cdn/${m.id}.glb`);
    if (!file.ok) throw new Error(`${m.id}: GLB ${file.status}`);
    writeFileSync(glbFile, Buffer.from(await file.arrayBuffer()));
    console.log(`fetched ${m.id} (${(readFileSync(glbFile).length / 1024).toFixed(0)} KiB)`);
  }
  return { glb: readFileSync(glbFile), meta };
}

// ---- reading a GLB ---------------------------------------------------------------------------

interface Gltf {
  nodes: { name?: string; children?: number[]; mesh?: number; skin?: number; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  animations?: { name?: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
  scenes?: { nodes: number[] }[];
  scene?: number;
}

function parseGlb(buffer: Buffer): { json: Gltf; bin: Buffer } {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let at = 12;
  let json: Gltf | null = null;
  let bin: Buffer | null = null;
  while (at < buffer.length) {
    const length = buffer.readUInt32LE(at);
    const type = buffer.readUInt32LE(at + 4);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8')) as Gltf;
    else if (type === 0x004e4942) bin = data;
    at += 8 + length;
  }
  if (!json || !bin) throw new Error('GLB without its JSON or binary chunk');
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** An accessor's values as plain numbers, normalized integers scaled to 0..1. */
function read(g: Gltf, bin: Buffer, index: number): { values: Float64Array; size: number } {
  const a = g.accessors[index];
  const size = COMPONENTS[a.type];
  const values = new Float64Array(a.count * size);
  if (a.bufferView === undefined) return { values, size };
  const view = g.bufferViews[a.bufferView];
  const bytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const each = bytes[a.componentType];
  const stride = view.byteStride ?? each * size;
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i += 1) {
    for (let k = 0; k < size; k += 1) {
      const p = base + i * stride + k * each;
      let v: number;
      switch (a.componentType) {
        case 5120: v = bin.readInt8(p); if (a.normalized) v = Math.max(v / 127, -1); break;
        case 5121: v = bin.readUInt8(p); if (a.normalized) v /= 255; break;
        case 5122: v = bin.readInt16LE(p); if (a.normalized) v = Math.max(v / 32767, -1); break;
        case 5123: v = bin.readUInt16LE(p); if (a.normalized) v /= 65535; break;
        case 5125: v = bin.readUInt32LE(p); break;
        default: v = bin.readFloatLE(p);
      }
      values[i * size + k] = v;
    }
  }
  return { values, size };
}

// ---- small matrix and quaternion helpers (column-major 4x4, as glTF) ---------------------------

type M4 = Float64Array;
const identity = (): M4 => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function multiply(a: M4, b: M4): M4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

function compose(t: number[], q: number[], s: number[]): M4 {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

function apply(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

function qmul(a: number[], b: number[]): number[] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const qinv = (q: number[]): number[] => [-q[0], -q[1], -q[2], q[3]];

function slerp(a: number[], b: number[], t: number): number[] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const c = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (c[i] - v) * t);
    const n = Math.hypot(...r);
    return r.map((v) => v / n);
  }
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return a.map((v, i) => v * wa + c[i] * wb);
}

function invert(m: M4): M4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return Float64Array.from([
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
}

/** A rotation by `angle` about the x axis, as a quaternion. */
const aboutX = (angle: number): number[] => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];

// ---- a node tree that can be posed -------------------------------------------------------------

interface Pose {
  t: number[][];
  r: number[][];
  s: number[][];
}

/** A node's matrix taken apart into translation, rotation and scale. */
function decompose(m: readonly number[]): { t: number[]; r: number[]; s: number[] } {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const trace = r00 + r11 + r22;
  let q: number[];
  if (trace > 0) {
    const k = 0.5 / Math.sqrt(trace + 1);
    q = [(r21 - r12) * k, (r02 - r20) * k, (r10 - r01) * k, 0.25 / k];
  } else if (r00 > r11 && r00 > r22) {
    const k = 2 * Math.sqrt(1 + r00 - r11 - r22);
    q = [0.25 * k, (r01 + r10) / k, (r02 + r20) / k, (r21 - r12) / k];
  } else if (r11 > r22) {
    const k = 2 * Math.sqrt(1 + r11 - r00 - r22);
    q = [(r01 + r10) / k, 0.25 * k, (r12 + r21) / k, (r02 - r20) / k];
  } else {
    const k = 2 * Math.sqrt(1 + r22 - r00 - r11);
    q = [(r02 + r20) / k, (r12 + r21) / k, 0.25 * k, (r10 - r01) / k];
  }
  return { t: [m[12], m[13], m[14]], r: q, s: [sx, sy, sz] };
}

/** Every node as it stands in the file, as translation, rotation and scale, whichever way the file gives it. */
function restPose(g: Gltf): Pose {
  const parts = g.nodes.map((n) => (n.matrix ? decompose(n.matrix) : { t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1] }));
  return { t: parts.map((p) => p.t), r: parts.map((p) => p.r), s: parts.map((p) => p.s) };
}

function parents(g: Gltf): Int32Array {
  const p = new Int32Array(g.nodes.length).fill(-1);
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (p[c] = i)));
  return p;
}

/** World matrices of every node in a pose. */
function worlds(g: Gltf, pose: Pose, parent: Int32Array): M4[] {
  const out: (M4 | null)[] = g.nodes.map(() => null);
  const world = (i: number): M4 => {
    const done = out[i];
    if (done) return done;
    const local = compose(pose.t[i], pose.r[i], pose.s[i]);
    const m = parent[i] >= 0 ? multiply(world(parent[i]), local) : local;
    out[i] = m;
    return m;
  };
  return g.nodes.map((_, i) => world(i));
}

/** World rotation of a node in a pose, as a quaternion. */
function worldRotation(pose: Pose, parent: Int32Array, i: number): number[] {
  return parent[i] >= 0 ? qmul(worldRotation(pose, parent, parent[i]), pose.r[i]) : pose.r[i];
}

/** A clip and the file it is in. */
interface Clip {
  g: Gltf;
  bin: Buffer;
  animation: NonNullable<Gltf['animations']>[number];
}

const bare = (name: string | undefined): string => (name ?? '').replace(/^.*:/, '');

/**
 * A pose at time `time` of a clip, starting from `base`: the clip's tracks go to the nodes of the
 * same name, so a clip from one character plays on another. Root motion across the floor is left out.
 */
function sample(g: Gltf, clip: Clip, time: number, base: Pose, hips: number): Pose {
  const pose: Pose = { t: base.t.map((v) => [...v]), r: base.r.map((v) => [...v]), s: base.s.map((v) => [...v]) };
  const { g: from, bin, animation } = clip;
  const byName = new Map(g.nodes.map((n, i) => [bare(n.name), i] as const));
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    const times = read(from, bin, sampler.input).values;
    const { values, size } = read(from, bin, sampler.output);
    const cubic = sampler.interpolation === 'CUBICSPLINE';
    const stride = cubic ? size * 3 : size;
    const offset = cubic ? size : 0;
    const local = ((time % times[times.length - 1]) + times[times.length - 1]) % times[times.length - 1];
    let k = 0;
    while (k < times.length - 2 && times[k + 1] <= local) k += 1;
    const span = times[k + 1] - times[k] || 1;
    const f = sampler.interpolation === 'STEP' ? 0 : Math.max(0, Math.min(1, (local - times[k]) / span));
    const a = Array.from(values.subarray(k * stride + offset, k * stride + offset + size));
    const b = Array.from(values.subarray((k + 1) * stride + offset, (k + 1) * stride + offset + size));
    const node = from === g ? channel.target.node : byName.get(bare(from.nodes[channel.target.node].name)) ?? -1;
    if (node < 0) continue;
    if (channel.target.path === 'rotation') pose.r[node] = slerp(a, b, f);
    else if (channel.target.path === 'translation') {
      const v = a.map((x, i) => x + (b[i] - x) * f);
      // Walking on the spot: the hips keep their rest place across the floor, and only bob.
      if (node === hips) pose.t[node] = [base.t[node][0], v[1], base.t[node][2]];
      else pose.t[node] = v;
    } else if (channel.target.path === 'scale') pose.s[node] = a.map((x, i) => x + (b[i] - x) * f);
  }
  return pose;
}

/**
 * How far one cycle of a clip played on the spot carries a character: while a foot is planted it
 * moves back under the body as far as the body moves forward, so the stride is that backward
 * travel over the share of the cycle the foot is down. Characters face +z.
 */
function strideOf(g: Gltf, c: Clip, length: number, rest: Pose, hips: number, parent: Int32Array, named: (name: string) => number): number | undefined {
  const foot = named('LeftFoot');
  if (foot < 0 || length <= 0) return undefined;
  const steps = 60;
  const at: { y: number; z: number }[] = [];
  for (let f = 0; f < steps; f += 1) {
    const w = worlds(g, sample(g, c, (f / steps) * length, rest, hips), parent);
    at.push({ y: w[foot][13], z: w[foot][14] });
  }
  const lowest = Math.min(...at.map((p) => p.y));
  const down = at.filter((p) => p.y < lowest + 0.02);
  if (down.length < 3) return undefined;
  const travel = Math.max(...down.map((p) => p.z)) - Math.min(...down.map((p) => p.z));
  return travel / (down.length / steps);
}

// ---- converting --------------------------------------------------------------------------------

interface Entry {
  id: string;
  name: string;
  role: Role;
  credit: string;
  page: string;
  changed: string;
  size: [number, number, number];
  file: string;
  vertices: number;
  triangles: number;
  /** Positions are stored as int16 across this box: min x, y, z and size x, y, z. */
  box: number[];
  /** Linear RGB of each colour slot. */
  palette: number[];
  /** For characters, the part each colour slot is on: body (skin), hair, top, coat, bottom, feet and so on. */
  parts?: string[];
  bones?: number;
  poses?: Record<string, [number, number]>;
  /** For characters: metres one cycle of the walk, and of the run, carries them, from how far a planted foot moves back. */
  stride?: number;
  runStride?: number;
}

function convert(m: Wanted, glb: Buffer, meta: Meta, borrowed: Clip[]): Entry {
  const { json: g, bin } = parseGlb(glb);
  const parent = parents(g);
  const rest = restPose(g);
  const restWorld = worlds(g, rest, parent);
  const positions: number[] = [];
  const colours: number[] = [];
  /** The part each vertex is on, by the name of the node it came from: 'body', 'hair', 'coat'... */
  const partOf: string[] = [];
  const bones: number[] = [];
  const triangles: number[] = [];
  // The bones, as nodes: every joint of every skin, the first skin's in its order.
  const joints: number[] = [];
  for (const skin of g.skins ?? []) for (const j of skin.joints) if (!joints.includes(j)) joints.push(j);
  // A node is left out when its own name, or a parent's, says it is a part dropped.
  const dropped = (i: number): boolean => {
    for (let n = i; n >= 0; n = parent[n]) if (m.drop && m.drop.test(g.nodes[n].name ?? '')) return true;
    return false;
  };
  let skipped = 0;
  g.nodes.forEach((node, ni) => {
    if (node.mesh === undefined) return;
    if (dropped(ni)) {
      skipped += 1;
      return;
    }
    const skinned = node.skin !== undefined;
    // The garment or part a mesh is: its node's name, or its parent's, without the 'attach-' and '-mesh'.
    let named = ni;
    while (named >= 0 && !/^(body|attach-)/i.test(g.nodes[named].name ?? '')) named = parent[named];
    const part = named >= 0 ? (g.nodes[named].name ?? 'body').replace(/^attach-/i, '').replace(/-mesh$/i, '').toLowerCase() : 'body';
    for (const prim of g.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const pos = read(g, bin, prim.attributes.POSITION).values;
      const count = pos.length / 3;
      const col = prim.attributes.COLOR_0 !== undefined ? read(g, bin, prim.attributes.COLOR_0) : null;
      const base = g.materials?.[prim.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      const jnt = skinned && prim.attributes.JOINTS_0 !== undefined ? read(g, bin, prim.attributes.JOINTS_0).values : null;
      const wgt = skinned && prim.attributes.WEIGHTS_0 !== undefined ? read(g, bin, prim.attributes.WEIGHTS_0).values : null;
      const skin = skinned ? g.skins![node.skin!] : null;
      const ibm = skin?.inverseBindMatrices !== undefined ? read(g, bin, skin.inverseBindMatrices).values : null;
      const first = positions.length / 3;
      for (let i = 0; i < count; i += 1) {
        let x = pos[i * 3];
        let y = pos[i * 3 + 1];
        let z = pos[i * 3 + 2];
        if (jnt && wgt && skin) {
          // Bound rigidly: each vertex follows the one bone that carries most of its weight. It
          // is kept where that bone puts it at rest, so every part shares one space whatever its skin.
          let best = 0;
          for (let k = 1; k < 4; k += 1) if (wgt[i * 4 + k] > wgt[i * 4 + best]) best = k;
          const local = jnt[i * 4 + best];
          const joint = skin.joints[local];
          const bind = ibm ? Float64Array.from(ibm.subarray(local * 16, local * 16 + 16)) : identity();
          [x, y, z] = apply(multiply(restWorld[joint], bind), x, y, z);
          bones.push(joints.indexOf(joint));
        } else {
          // A prop, or a part hung from a bone, as it stands at rest.
          [x, y, z] = apply(restWorld[ni], x, y, z);
          if (joints.length) {
            let n = ni;
            while (n >= 0 && !joints.includes(n)) n = parent[n];
            bones.push(n >= 0 ? joints.indexOf(n) : 0);
          }
        }
        positions.push(x, y, z);
        partOf.push(part);
        const c = col ? [col.values[i * col.size], col.values[i * col.size + 1], col.values[i * col.size + 2]] : [1, 1, 1];
        colours.push(c[0] * base[0], c[1] * base[1], c[2] * base[2]);
      }
      const idx = prim.indices !== undefined ? read(g, bin, prim.indices).values : Float64Array.from({ length: count }, (_, i) => i);
      for (let i = 0; i < idx.length; i += 1) triangles.push(first + idx[i]);
    }
  });
  if (m.drop && !skipped && m.role === 'prop') console.warn(`${m.id}: no part named like ${m.drop}; kept whole (${g.nodes.map((n) => n.name).filter(Boolean).slice(0, 12).join(', ')})`);

  // Colour slots: each distinct colour once on each part, so the app can recolour part by part.
  const palette: number[] = [];
  const slotParts: string[] = [];
  const slotOf = new Map<string, number>();
  const slots: number[] = [];
  for (let i = 0; i < colours.length; i += 3) {
    const part = m.role === 'character' ? partOf[i / 3] : '';
    const key = `${colours.slice(i, i + 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')}:${part}`;
    let s = slotOf.get(key);
    if (s === undefined) {
      s = palette.length / 3;
      slotOf.set(key, s);
      palette.push(colours[i], colours[i + 1], colours[i + 2]);
      slotParts.push(part);
    }
    slots.push(s);
  }
  if (palette.length / 3 > 255) throw new Error(`${m.id}: more than 255 colours`);

  // Weld: faces are shaded flat, so a corner shared by faces of one colour and bone is one vertex.
  const weld = new Map<string, number>();
  const remap: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < positions.length / 3; i += 1) {
    const key = `${positions[i * 3].toFixed(5)},${positions[i * 3 + 1].toFixed(5)},${positions[i * 3 + 2].toFixed(5)},${slots[i]},${bones[i] ?? 0}`;
    let w = weld.get(key);
    if (w === undefined) {
      w = kept.length;
      weld.set(key, w);
      kept.push(i);
    }
    remap.push(w);
  }
  const tris = triangles.map((v) => remap[v]);

  // Poses: the bone matrices (bind space to model space) of each frame the app draws.
  let poses: Record<string, [number, number]> | undefined;
  let stride: number | undefined;
  let runStride: number | undefined;
  const matrices: number[] = [];
  if (m.role === 'character') {
    if (!joints.length) throw new Error(`${m.id}: a character with no skin`);
    const named = (name: string): number => joints.find((j) => bare(g.nodes[j].name) === name) ?? -1;
    const hips = named('Hips');
    // Its own clips, or else those borrowed from another character on the same skeleton.
    const clip = (name: string): Clip | undefined => {
      const own = (g.animations ?? []).find((a) => (a.name ?? '').toLowerCase() === name.toLowerCase());
      return own ? { g, bin, animation: own } : borrowed.find((c) => (c.animation.name ?? '').toLowerCase() === name.toLowerCase());
    };
    const frames: Pose[] = [];
    poses = {};
    const walk = clip('Walk');
    const idle = clip('Idle');
    const run = clip('Run');
    if (!walk || !idle) throw new Error(`${m.id}: no walk or idle clip, here or borrowed`);
    const standing = sample(g, idle, 0, rest, hips);
    const lengthOf = (c: Clip): number => {
      const times = read(c.g, c.bin, c.animation.samplers[0].input).values;
      return times[times.length - 1];
    };
    // Each built-in clip as frames over one cycle, as made: walking, standing idle, running.
    const take = (name: string, c: Clip, count: number): void => {
      poses![name] = [frames.length, count];
      for (let f = 0; f < count; f += 1) frames.push(sample(g, c, (f / count) * lengthOf(c), rest, hips));
    };
    take('walk', walk, WALK_FRAMES);
    take('idle', idle, IDLE_FRAMES);
    if (run) take('run', run, RUN_FRAMES);
    // Standing still is the idle clip's first frame.
    poses.stand = [poses.idle[0], 1];
    stride = strideOf(g, walk, lengthOf(walk), rest, hips, parent, named);
    if (run) runStride = strideOf(g, run, lengthOf(run), rest, hips, parent, named);
    // Sitting, made from standing: thighs forward, shins down, and the hips lowered onto a seat.
    {
      const sit: Pose = { t: standing.t.map((v) => [...v]), r: standing.r.map((v) => [...v]), s: standing.s.map((v) => [...v]) };
      const bend = (joint: number, angle: number): void => {
        if (joint < 0) return;
        const up = parent[joint] >= 0 ? worldRotation(sit, parent, parent[joint]) : [0, 0, 0, 1];
        sit.r[joint] = qmul(qmul(qmul(qinv(up), aboutX(angle)), up), sit.r[joint]);
      };
      bend(named('LeftUpLeg'), -Math.PI / 2);
      bend(named('RightUpLeg'), -Math.PI / 2);
      bend(named('LeftLeg'), Math.PI / 2);
      bend(named('RightLeg'), Math.PI / 2);
      bend(named('LeftForeArm'), -Math.PI / 5);
      bend(named('RightForeArm'), -Math.PI / 5);
      if (hips >= 0) {
        const w = worlds(g, sit, parent);
        const drop = w[hips][13] - (SEAT_HEIGHT + 0.06);
        // The hips' translation is in their parent's frame; with an upright parent, down is down.
        const up = parent[hips] >= 0 ? worldRotation(sit, parent, parent[hips]) : [0, 0, 0, 1];
        const local = qmul(qmul(qinv(up), [0, -drop, 0, 0]), up);
        const scale = parent[hips] >= 0 ? Math.hypot(w[parent[hips]][4], w[parent[hips]][5], w[parent[hips]][6]) : 1;
        sit.t[hips] = [sit.t[hips][0] + local[0] / scale, sit.t[hips][1] + local[1] / scale, sit.t[hips][2] + local[2] / scale];
      }
      poses.sit = [frames.length, 1];
      frames.push(sit);
    }
    const fromRest = joints.map((j) => invert(restWorld[j]));
    for (const [f, pose] of frames.entries()) {
      const w = worlds(g, pose, parent);
      const bone = joints.map((j, k) => multiply(w[j], fromRest[k]));
      // The lowest point of the posed figure: a pose that would put the feet through the floor
      // (sitting, with legs longer than the seat is high) is lifted onto it.
      let lowest = Infinity;
      for (let i = 0; i < positions.length / 3; i += 1) {
        const mtx = bone[bones[i] ?? 0];
        lowest = Math.min(lowest, mtx[1] * positions[i * 3] + mtx[5] * positions[i * 3 + 1] + mtx[9] * positions[i * 3 + 2] + mtx[13]);
      }
      const lift = f === poses.sit[0] && lowest < 0 ? -lowest : 0;
      for (const mtx of bone) {
        // From where the bone holds a vertex at rest to where it holds it in this pose: the rows
        // of the 3x4 matrix that takes a vertex to the posed model.
        matrices.push(mtx[0], mtx[4], mtx[8], mtx[12], mtx[1], mtx[5], mtx[9], mtx[13] + lift, mtx[2], mtx[6], mtx[10], mtx[14]);
      }
    }
  }

  // Quantize across the box of the kept vertices.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of kept) for (let k = 0; k < 3; k += 1) {
    min[k] = Math.min(min[k], positions[i * 3 + k]);
    max[k] = Math.max(max[k], positions[i * 3 + k]);
  }
  const span = max.map((v, k) => Math.max(v - min[k], 1e-6));
  const vertexCount = kept.length;
  const wide = vertexCount > 65535;
  const parts: Buffer[] = [];
  const q = Buffer.alloc(vertexCount * 6);
  kept.forEach((i, n) => {
    for (let k = 0; k < 3; k += 1) q.writeInt16LE(Math.round(((positions[i * 3 + k] - min[k]) / span[k]) * 65535 - 32768), n * 6 + k * 2);
  });
  parts.push(q);
  parts.push(Buffer.from(kept.map((i) => slots[i])));
  if (m.role === 'character') parts.push(Buffer.from(kept.map((i) => bones[i] ?? 0)));
  const pad = (b: Buffer[]): void => {
    const length = b.reduce((n, x) => n + x.length, 0);
    if (length % 4) b.push(Buffer.alloc(4 - (length % 4)));
  };
  pad(parts);
  const idx = Buffer.alloc(tris.length * (wide ? 4 : 2));
  tris.forEach((v, i) => (wide ? idx.writeUInt32LE(v, i * 4) : idx.writeUInt16LE(v, i * 2)));
  parts.push(idx);
  pad(parts);
  if (matrices.length) parts.push(Buffer.from(Float32Array.from(matrices).buffer));
  const file = `${m.id}.bin`;
  const data = Buffer.concat(parts);
  writeFileSync(join(out, file), data);
  const changes = ['converted to a compact form for this app (vertices welded and quantized, colours as slots)'];
  if (m.dropped && skipped) changes.push(m.dropped);
  if (m.role === 'character') changes.push(`its built-in Walk, Idle and Run clips sampled as ${WALK_FRAMES}, ${IDLE_FRAMES} and ${RUN_FRAMES} frames, and a sitting pose made here from its standing one`);
  console.log(`${m.id}: ${vertexCount} vertices, ${tris.length / 3} triangles, ${palette.length / 3} colours${m.role === 'character' ? `, ${joints.length} bones, ${matrices.length / 12 / joints.length} poses` : ''}${skipped ? `, ${skipped} parts left out` : ''}; ${(data.length / 1024).toFixed(0)} KiB`);
  return {
    id: m.id,
    name: meta.name,
    role: m.role,
    credit: meta.credit,
    page: meta.page,
    changed: changes.join('; '),
    size: meta.size,
    file,
    vertices: vertexCount,
    triangles: tris.length / 3,
    box: [...min, ...span],
    palette: palette.map((v) => Math.round(v * 10000) / 10000),
    parts: m.role === 'character' ? slotParts : undefined,
    bones: m.role === 'character' ? joints.length : undefined,
    poses,
    stride: stride === undefined ? undefined : Math.round(stride * 1000) / 1000,
    runStride: runStride === undefined ? undefined : Math.round(runStride * 1000) / 1000,
  };
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const entries: Entry[] = [];
  const fetched = new Map<string, { glb: Buffer; meta: Meta }>();
  for (const m of MODELS) fetched.set(m.id, await fetchModel(m));
  // Clips any character may borrow: the traveller's, on the skeleton they all share.
  const lender = parseGlb(fetched.get('traveller-92f20c')!.glb);
  const borrowed: Clip[] = (lender.json.animations ?? []).map((animation) => ({ g: lender.json, bin: lender.bin, animation }));
  for (const m of MODELS) {
    const { glb, meta } = fetched.get(m.id)!;
    entries.push(convert(m, glb, meta, borrowed));
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify({ source: 'https://polyfork.dev', licence: 'CC BY 4.0', models: entries }, null, 1)}\n`);
  const credits = [
    '# Model credits',
    '',
    'The 3D models in this folder are from [Polyfork](https://polyfork.dev), under the [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) licence. Each was changed for this app as noted. Polyfork does not endorse this project.',
    '',
    ...entries.map((e) => `- ${e.credit}. Changed: ${e.changed}.`),
    '',
  ];
  writeFileSync(join(out, 'CREDITS.md'), credits.join('\n'));
  console.log(`${entries.length} models written to public/models`);
}

await main();
