#!/usr/bin/env node
// Measure one of Polyfork's airliners as the shape src/shared/airframe.ts describes an aircraft
// with, and print it for that file's MODEL_SHAPES: the fuselage as stations, each wing and
// tailplane as a tapered surface that bounds every vertex of it (flaps, ailerons and the tip device
// included), the fin, the engines as nacelles, and where the gear stands. Every number is in the
// model's own frame and size: x along the aircraft (nose forward), y to its left, z up.
//
//   node tools/models/airliner-shape.ts <file.glb>
//
// The shapes are fitted to bound what is drawn, not to look like it: test/outline.test.ts checks
// that every vertex of the drawn model lies inside the outline made from them, and that the wings
// and tailplane bound it in height too.

import { readFileSync } from 'node:fs';

type V3 = [number, number, number];

interface Node {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  nodes: Node[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  scenes?: { nodes: number[] }[];
  scene?: number;
}

function read(file: string): { g: Gltf; bin: Buffer } {
  const buffer = readFileSync(file);
  let at = 12;
  let g: Gltf | null = null;
  let bin: Buffer | null = null;
  while (at < buffer.length) {
    const length = buffer.readUInt32LE(at);
    const kind = buffer.readUInt32LE(at + 4);
    const chunk = buffer.subarray(at + 8, at + 8 + length);
    if (kind === 0x4e4f534a) g = JSON.parse(chunk.toString('utf8')) as Gltf;
    else bin = chunk;
    at += 8 + length;
  }
  if (!g || !bin) throw new Error(`${file}: not a GLB`);
  return { g, bin };
}

function multiply(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) for (let k = 0; k < 4; k += 1) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function local(n: Node): number[] {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0, 2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0, 2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}

/** One connected piece of a mesh (its triangles joined where they share a position), placed in the aircraft frame (x forward, y left, z up), with the name of the node it hangs from. */
interface Piece {
  node: string;
  points: V3[];
  lo: V3;
  hi: V3;
}

/** The least and greatest of many numbers, without spreading them into a call. */
function minOf(values: Iterable<number>): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}
function maxOf(values: Iterable<number>): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** Metres between points sampled across a triangle. */
const SAMPLE = 0.1;
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function pieces(g: Gltf, bin: Buffer): Piece[] {
  const out: Piece[] = [];
  const walk = (index: number, parent: number[], name: string): void => {
    const n = g.nodes[index];
    const m = multiply(parent, local(n));
    const own = n.name ?? name;
    if (n.mesh !== undefined) {
      for (const prim of g.meshes[n.mesh].primitives) {
        const a = g.accessors[prim.attributes.POSITION];
        const view = g.bufferViews[a.bufferView!];
        const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
        const stride = view.byteStride ?? 12;
        const pts: V3[] = [];
        for (let i = 0; i < a.count; i += 1) {
          const o = offset + i * stride;
          const x = bin.readFloatLE(o);
          const y = bin.readFloatLE(o + 4);
          const z = bin.readFloatLE(o + 8);
          // glTF: +z the nose, +x the left wing, +y up.
          pts.push([m[2] * x + m[6] * y + m[10] * z + m[14], m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]]);
        }
        let index: number[] = pts.map((_, i) => i);
        if (prim.indices !== undefined) {
          const ia = g.accessors[prim.indices];
          const iv = g.bufferViews[ia.bufferView!];
          const io = (iv.byteOffset ?? 0) + (ia.byteOffset ?? 0);
          index = [];
          for (let i = 0; i < ia.count; i += 1) index.push(ia.componentType === 5125 ? bin.readUInt32LE(io + i * 4) : bin.readUInt16LE(io + i * 2));
        }
        // Join vertices at one position, then triangles that share them.
        const ids = new Map<string, number>();
        const rep = pts.map((p) => {
          const key = p.map((v) => Math.round(v * 200)).join(',');
          if (!ids.has(key)) ids.set(key, ids.size);
          return ids.get(key)!;
        });
        const parentOf = Array.from({ length: ids.size }, (_, i) => i);
        const find = (x: number): number => {
          while (parentOf[x] !== x) {
            parentOf[x] = parentOf[parentOf[x]];
            x = parentOf[x];
          }
          return x;
        };
        for (let i = 0; i + 2 < index.length; i += 3) {
          const r = find(rep[index[i]]);
          parentOf[find(rep[index[i + 1]])] = r;
          parentOf[find(rep[index[i + 2]])] = r;
        }
        const groups = new Map<number, V3[]>();
        pts.forEach((p, i) => {
          const r = find(rep[i]);
          if (!groups.has(r)) groups.set(r, []);
          groups.get(r)!.push(p);
        });
        // Points across each triangle as well as its corners: a triangle can bridge two parts,
        // its corners inside each and its middle outside both.
        for (let i = 0; i + 2 < index.length; i += 3) {
          const [a, b, c] = [pts[index[i]], pts[index[i + 1]], pts[index[i + 2]]];
          const n = Math.max(1, Math.ceil(Math.max(dist(a, b), dist(b, c), dist(c, a)) / SAMPLE));
          const group = groups.get(find(rep[index[i]]))!;
          for (let u = 0; u <= n; u += 1) {
            for (let v = 0; u + v <= n; v += 1) {
              if (u + v === 0 || u === n || v === n) continue;
              group.push([0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * u) / n + ((c[k] - a[k]) * v) / n) as V3);
            }
          }
        }
        for (const group of groups.values()) {
          const lo: V3 = [0, 1, 2].map((k) => minOf(group.map((p) => p[k]))) as V3;
          const hi: V3 = [0, 1, 2].map((k) => maxOf(group.map((p) => p[k]))) as V3;
          out.push({ node: own, points: group, lo, hi });
        }
      }
    }
    for (const c of n.children ?? []) walk(c, m, own);
  };
  for (const r of g.scenes?.[g.scene ?? 0].nodes ?? []) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], '');
  return out;
}

const round = (v: number): number => Math.round(v * 100) / 100;
/** Rounded outward to the centimetre: a bound rounded never cuts into what it bounds. */
const up = (v: number): number => Math.ceil(v * 100 - 1e-9) / 100;
const down = (v: number): number => Math.floor(v * 100 + 1e-9) / 100;

/**
 * The fuselage seen from above, as the points (x, half width) of its convex outline from tail to
 * nose: what the stations reach, with the ones inside the outline dropped.
 */
function outlineOf(stations: [number, number, number, number][]): [number, number][] {
  const pts = stations.map((s): [number, number] => [s[0], s[2]]).sort((a, b) => a[0] - b[0]);
  const upper: [number, number][] = [];
  for (const q of pts) {
    while (upper.length >= 2) {
      const [a, b] = [upper[upper.length - 2], upper[upper.length - 1]];
      if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0) upper.pop();
      else break;
    }
    upper.push(q);
  }
  return upper;
}

/**
 * A tapered surface bounding `points` between spans `from` and `to` (y, both positive): lines for
 * its leading and trailing edges and for its underside and top, each the tightest of its family
 * with every point on the right side, fitted through the extreme points at either end.
 */
function surface(points: V3[], inner: number, outer: number): { root: V3; rootChord: number; rootThick: number; tip: V3; tipChord: number; tipThick: number } {
  // Its root and tip stations, rounded outward first: the edges are worked out where they will be.
  const from = down(inner);
  const to = up(outer);
  // For each quantity, the line over y from `from` to `to` that lies on one side of every point and
  // stays closest to them over that stretch (least area between): it runs along an edge of their
  // hull, or level through the extreme point.
  const bound = (value: (p: V3) => number, above: boolean): [number, number] => {
    const pts = points.map((p): [number, number] => [p[1], above ? value(p) : -value(p)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // The upper hull of the points (for a lower bound the values are negated).
    const upper: [number, number][] = [];
    for (const q of pts) {
      while (upper.length >= 2) {
        const [a, b] = [upper[upper.length - 2], upper[upper.length - 1]];
        if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0) upper.pop();
        else break;
      }
      upper.push(q);
    }
    const top = maxOf(pts.map((q) => q[1]));
    let best: [number, number] = [top, top];
    let cost = 2 * top;
    for (let i = 0; i + 1 < upper.length; i += 1) {
      const [y0, v0] = upper[i];
      const [y1, v1] = upper[i + 1];
      if (y1 - y0 < 1e-6) continue;
      const slope = (v1 - v0) / (y1 - y0);
      const at = (y: number): number => v0 + slope * (y - y0);
      // Every point under it, by construction of the hull; allow for rounding.
      const lift = Math.max(0, maxOf(pts.map((q) => q[1] - at(q[0]))));
      const ends: [number, number] = [at(from) + lift, at(to) + lift];
      if (ends[0] + ends[1] < cost) {
        cost = ends[0] + ends[1];
        best = ends;
      }
    }
    return above ? best : [-best[0], -best[1]];
  };
  const [leadRoot, leadTip] = bound((p) => p[0], true).map(up);
  const [trailRoot, trailTip] = bound((p) => p[0], false).map(down);
  const [underRoot, underTip] = bound((p) => p[2], false).map(down);
  const [topRoot, topTip] = bound((p) => p[2], true).map(up);
  const third = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    root: [leadRoot, from, third((underRoot + topRoot) / 2)],
    rootChord: round(leadRoot - trailRoot),
    rootThick: round(topRoot - underRoot),
    tip: [leadTip, to, third((underTip + topTip) / 2)],
    tipChord: round(leadTip - trailTip),
    tipThick: round(topTip - underTip),
  };
}

const file = process.argv[2];
if (!file) {
  console.error('node tools/models/airliner-shape.ts <file.glb>');
  process.exit(1);
}
const { g, bin } = read(file);
const parts = pieces(g, bin);
const all = parts.flatMap((p) => p.points.map((pt) => ({ p: pt, node: p.node })));
const xs = all.map((v) => v.p[0]);
const length = maxOf(xs) - minOf(xs);
const nose = maxOf(xs);
const tail = minOf(xs);
const span = 2 * maxOf(all.map((v) => Math.abs(v.p[1])));
const height = maxOf(all.map((v) => v.p[2]));

// The fuselage's half width: the widest the cabin is ahead of the wing, where nothing else is.
const cabin = all.filter((v) => v.node === 'airframe' && v.p[0] > nose - length * 0.3 && v.p[0] < nose - length * 0.12);
const half = maxOf(cabin.map((v) => Math.abs(v.p[1])));

// The engines: the piece of the airframe round the left fan, and any piece (a pylon) standing
// over it inside its width. The fan's own vertices give its centre.
const fan = parts.filter((p) => /^fan-l/.test(p.node));
const fanLo = [0, 1, 2].map((k) => minOf(fan.map((p) => p.lo[k])));
const fanHi = [0, 1, 2].map((k) => maxOf(fan.map((p) => p.hi[k])));
const fanY = (fanLo[1] + fanHi[1]) / 2;
const fanZ = (fanLo[2] + fanHi[2]) / 2;
/** A piece's box with the right side mirrored onto the left: [least y, greatest y]. */
const across = (p: Piece): [number, number] => (p.hi[1] < 0 ? [-p.hi[1], -p.lo[1]] : [p.lo[1], p.hi[1]]);
const within = (p: Piece, y: number, z: number): boolean => {
  const [y0, y1] = across(p);
  return y0 <= y && y1 >= y && p.lo[2] <= z && p.hi[2] >= z;
};
// Each side's nacelle: the narrowest piece of the airframe round its fan.
const nacelles = parts.filter((p) => p.node === 'airframe' && within(p, fanY, fanZ) && across(p)[1] - across(p)[0] < 4 * (fanHi[1] - fanLo[1]));
const nacelle = nacelles.filter((p) => p.lo[1] > 0).sort((a, b) => (a.hi[1] - a.lo[1]) - (b.hi[1] - b.lo[1]))[0];
const fans = parts.filter((p) => /^fan-/.test(p.node));
const pylons = parts.filter((p) => {
  if (nacelles.includes(p) || p.node !== 'airframe') return false;
  const [y0, y1] = across(p);
  return y0 >= nacelle.lo[1] - 0.05 && y1 <= nacelle.hi[1] + 0.05 && p.lo[2] >= fanZ && p.hi[0] >= nacelle.lo[0] && p.lo[0] <= nacelle.hi[0];
});
const engineParts = [...nacelles, ...fans, ...pylons];
const radius = Math.max(nacelle.hi[1] - fanY, fanY - nacelle.lo[1], nacelle.hi[2] - fanZ, fanZ - nacelle.lo[2]);
const engine = {
  y: round(fanY),
  z: round(fanZ),
  radius: up(radius),
  front: up(maxOf(engineParts.map((p) => p.hi[0]))),
  back: down(minOf(engineParts.map((p) => p.lo[0]))),
};

/** The gear and the doors, which are measured apart. */
const GEAR = /gear|wheel|tyre|tire|bogie|axle|door|hold/;

// Stations along the fuselage every half metre: the centre height, half width and half height of
// what lies within the cabin's width there (the fin above it left out).
// The doors are part of the fuselage's surface; the gear and its doors are not.
const fixed = parts.filter((p) => !/^(fan|flap|aileron|spoiler|elevator)/.test(p.node) && !/gear|wheel|tyre|tire|bogie|axle/.test(p.node));
// What lies within the cabin's width, and the doors and holds wherever they stand proud of it.
const bodyPoints = fixed.flatMap((p) => (/door|hold/.test(p.node) ? p.points : p.points.filter((pt) => Math.abs(pt[1]) <= half + 0.02)));
const stations: [number, number, number, number][] = [];
const along: number[] = [];
for (let x = tail; x < nose; x += 0.5) along.push(x);
along.push(nose);
for (const x of along) {
  const here = bodyPoints.filter((pt) => Math.abs(pt[0] - x) <= 0.5 && pt[2] < height * 0.62);
  if (!here.length) continue;
  const w = maxOf(here.map((pt) => Math.abs(pt[1])));
  const lo = minOf(here.map((pt) => pt[2]));
  const hi = maxOf(here.map((pt) => pt[2]));
  stations.push([round(Math.min(nose, Math.max(tail, x))), round((lo + hi) / 2), up(w + 0.02), round((hi - lo) / 2)]);
}
// The cabin's underside and top, over the cabin ahead of the wing.
const cabinStations = stations.filter((st) => st[0] > nose - length * 0.3 && st[0] < nose - length * 0.12);
const cabinBottom = minOf(cabinStations.map((st) => st[1] - st[3]));
const cabinTop = maxOf(cabinStations.map((st) => st[1] + st[3]));
/** The fuselage's half width at x, as its outline from above has it (0 beyond its ends). */
const body = outlineOf(stations);
const widthAt = (x: number): number => {
  for (let i = 0; i + 1 < body.length; i += 1) {
    const [x0, w0] = body[i];
    const [x1, w1] = body[i + 1];
    if (x >= x0 && x <= x1) return x1 > x0 ? w0 + ((w1 - w0) * (x - x0)) / (x1 - x0) : Math.max(w0, w1);
  }
  return 0;
};

// The wing is what stands out to the left ahead of the tail; the tailplane, behind it. The tail
// begins where the fin does.
const isEngine = new Set(engineParts);
const out = parts.filter((p) => !isEngine.has(p) && !GEAR.test(p.node));
const finParts = out.filter((p) => p.hi[2] > height * 0.62 && Math.abs(p.hi[1]) < half && Math.abs(p.lo[1]) < half);
const finFront = maxOf(finParts.map((p) => p.hi[0]));
// A piece that stands out from the fuselage counts whole, since its surface runs between its
// vertices: the root of a tailplane is inside the fuselage's width, its tip far outside. A piece
// that crosses the centreline (the fuselage, welded to the wings on some models) counts only where
// it stands out. Both sides count, the right one mirrored: the shapes are one for both sides, and
// a model need not be quite symmetric (a cargo door on one side).
const leftPoints = out.flatMap((p) => {
  const pts = p.points.map((pt): V3 => [pt[0], Math.abs(pt[1]), pt[2]]);
  const oneSide = p.lo[1] > 0.2 || p.hi[1] < -0.2;
  if (oneSide) return pts.some((pt) => pt[1] > widthAt(pt[0])) ? pts : [];
  return pts.filter((pt) => pt[1] > widthAt(pt[0]));
});
const wingPoints = leftPoints.filter((pt) => pt[0] > finFront);
const tailPoints = leftPoints.filter((pt) => pt[0] <= finFront && pt[2] < height * 0.62);
const tailFrom = minOf(tailPoints.map((pt) => pt[1]));
const wing = surface(wingPoints, Math.min(half, minOf(wingPoints.map((pt) => pt[1]))), span / 2);
const stabiliser = surface(tailPoints, tailFrom, maxOf(tailPoints.map((pt) => pt[1])));
const finPoints = finParts.flatMap((p) => p.points);
const gearPoints = (re: RegExp): V3[] => parts.filter((p) => re.test(p.node)).flatMap((p) => p.points);
const noseGear = gearPoints(/^gear-nose/);
const mainGear = gearPoints(/^gear-main-l/);
// The front and rearmost doors on the left: where along their middles are, and their sills.
const doorPieces = parts.filter((p) => /^door-l\d/.test(p.node) && p.lo[1] > 0);
const doorNumber = (p: Piece): number => Number(/^door-l(\d)/.exec(p.node)![1]);
const doorOf = (n: number): { x: number; sill: number } => {
  const ds = doorPieces.filter((p) => doorNumber(p) === n);
  return { x: round((minOf(ds.map((p) => p.lo[0])) + maxOf(ds.map((p) => p.hi[0]))) / 2), sill: round(minOf(ds.map((p) => p.lo[2]))) };
};
const doors = { front: doorOf(1), rear: doorOf(maxOf(doorPieces.map(doorNumber))) };
const shape = {
  length: round(length),
  span: round(span),
  height: round(height),
  nose: round(nose),
  half: round(half),
  cabin: [round(cabinBottom), round(cabinTop)],
  body,
  wing,
  stabiliser,
  fin: { front: up(finFront), back: down(minOf(finPoints.map((pt) => pt[0]))), half: up(maxOf(finPoints.map((pt) => Math.abs(pt[1])))), top: up(maxOf(finPoints.map((pt) => pt[2]))) },
  engines: [engine],
  doors,
  gear: {
    noseX: round((minOf(noseGear.map((pt) => pt[0])) + maxOf(noseGear.map((pt) => pt[0]))) / 2),
    mainX: round((minOf(mainGear.map((pt) => pt[0])) + maxOf(mainGear.map((pt) => pt[0]))) / 2),
    track: round((minOf(mainGear.map((pt) => pt[1])) + maxOf(mainGear.map((pt) => pt[1]))) / 2),
    halfLength: up((maxOf(mainGear.map((pt) => pt[0])) - minOf(mainGear.map((pt) => pt[0]))) / 2),
    halfWidth: up((maxOf(mainGear.map((pt) => pt[1])) - minOf(mainGear.map((pt) => pt[1]))) / 2),
  },
};
console.log(JSON.stringify(shape));
