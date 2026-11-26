// Geometry assembly for the static world. Callers work in map coordinates (x east, y north,
// h up, metres); the builder writes three.js positions (x, h, -y) so north is -Z and up is +Y.

import * as THREE from 'three';
import type { Flat, PolygonData } from '../shared/layout.ts';

export type RGB = readonly [number, number, number];

/** A linear-space colour triple from an sRGB hex value. */
export function rgb(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export function shade(c: RGB, factor: number): RGB {
  return [c[0] * factor, c[1] * factor, c[2] * factor];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];
  private count = 0;

  get vertexCount(): number {
    return this.count;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Add a vertex given in map coordinates with a map-space normal (nx east, ny north, nz up). */
  vertex(x: number, y: number, h: number, nx: number, ny: number, nz: number, c: RGB, u = 0, v = 0): number {
    this.positions.push(x, h, -y);
    this.normals.push(nx, nz, -ny);
    this.colors.push(c[0], c[1], c[2]);
    this.uvs.push(u, v);
    this.count += 1;
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Two triangles a-b-c, a-c-d; give the corners counter-clockwise seen from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.indices, 1) : new THREE.Uint16BufferAttribute(this.indices, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const ringPoints = (flat: Flat): THREE.Vector2[] => {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(new THREE.Vector2(flat[i], flat[i + 1]));
  return out;
};

function signedArea(flat: Flat): number {
  let twice = 0;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) twice += flat[j] * flat[i + 1] - flat[i] * flat[j + 1];
  return twice / 2;
}

/** A flat, upward-facing fill of a polygon at height h. uvScale maps metres to texture units. */
export function fillPolygon(b: MeshBuilder, poly: PolygonData, h: number, c: RGB, uvScale = 0): void {
  const contour = ringPoints(poly.outer);
  if (contour.length < 3) return;
  const holes = (poly.holes ?? []).map(ringPoints).filter((r) => r.length >= 3);
  const all = [contour, ...holes].flat();
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const base = b.vertexCount;
  for (const p of all) b.vertex(p.x, p.y, h, 0, 0, 1, c, p.x * uvScale, p.y * uvScale);
  for (const f of faces) {
    const p0 = all[f[0]];
    const p1 = all[f[1]];
    const p2 = all[f[2]];
    const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    if (cross >= 0) b.tri(base + f[0], base + f[1], base + f[2]);
    else b.tri(base + f[0], base + f[2], base + f[1]);
  }
}

/** Vertical walls around every ring of a polygon, from h0 up to h1, facing away from the solid. */
export function wallPolygon(b: MeshBuilder, poly: PolygonData, h0: number, h1: number, c: RGB, uvScale = 0): void {
  const rings: { flat: Flat; outer: boolean }[] = [{ flat: poly.outer, outer: true }, ...(poly.holes ?? []).map((flat) => ({ flat, outer: false }))];
  for (const { flat, outer } of rings) {
    const n = flat.length / 2;
    if (n < 3) continue;
    // Walk so the solid is on the left: counter-clockwise for the outer ring, clockwise for holes.
    const forward = signedArea(flat) > 0 === outer;
    let run = 0;
    for (let k = 0; k < n; k += 1) {
      const i = forward ? k : n - 1 - k;
      const j = forward ? (k + 1) % n : (n - 2 - k + n) % n;
      const x0 = flat[i * 2];
      const y0 = flat[i * 2 + 1];
      const x1 = flat[j * 2];
      const y1 = flat[j * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.01) continue;
      const nx = (y1 - y0) / len;
      const ny = -(x1 - x0) / len;
      const u0 = run * uvScale;
      const u1 = (run + len) * uvScale;
      const a = b.vertex(x0, y0, h0, nx, ny, 0, c, u0, h0 * uvScale);
      const bb = b.vertex(x1, y1, h0, nx, ny, 0, c, u1, h0 * uvScale);
      const cc = b.vertex(x1, y1, h1, nx, ny, 0, c, u1, h1 * uvScale);
      const d = b.vertex(x0, y0, h1, nx, ny, 0, c, u0, h1 * uvScale);
      b.quad(a, bb, cc, d);
      run += len;
    }
  }
}

/** A closed prism: walls from h0 to h1 with a roof on top. */
export function extrudePolygon(b: MeshBuilder, poly: PolygonData, h0: number, h1: number, wall: RGB, roof: RGB): void {
  wallPolygon(b, poly, h0, h1, wall);
  fillPolygon(b, poly, h1, roof);
}

export interface RibbonOptions {
  /** Texture repeats once per this many metres along the ribbon; 0 leaves v at 0. */
  vLength?: number;
  /** Extra height added to every point. */
  lift?: number;
  /** Shift the ribbon sideways, positive to the left of travel. */
  offset?: number;
}

/**
 * A flat strip of the given width following a polyline. `pts` holds `stride` numbers per point
 * (x, y) or (x, y, h). Corners are mitred, with the mitre capped so sharp turns do not spike.
 */
export function ribbon(b: MeshBuilder, pts: readonly number[], stride: 2 | 3, width: number, c: RGB, options: RibbonOptions = {}): void {
  const n = pts.length / stride;
  if (n < 2) return;
  const half = width / 2;
  const lift = options.lift ?? 0;
  const offset = options.offset ?? 0;
  const vLength = options.vLength ?? 0;
  let run = 0;
  let prevLeft = -1;
  let prevRight = -1;
  for (let i = 0; i < n; i += 1) {
    const x = pts[i * stride];
    const y = pts[i * stride + 1];
    const h = (stride === 3 ? pts[i * stride + 2] : 0) + lift;
    const p = Math.max(0, i - 1);
    const q = Math.min(n - 1, i + 1);
    // Unit directions of the segments before and after this point.
    let ax = x - pts[p * stride];
    let ay = y - pts[p * stride + 1];
    let bx = pts[q * stride] - x;
    let by = pts[q * stride + 1] - y;
    const al = Math.hypot(ax, ay);
    const bl = Math.hypot(bx, by);
    if (al > 1e-6) {
      ax /= al;
      ay /= al;
    } else {
      ax = bx / (bl || 1);
      ay = by / (bl || 1);
    }
    if (bl > 1e-6) {
      bx /= bl;
      by /= bl;
    } else {
      bx = ax;
      by = ay;
    }
    let tx = ax + bx;
    let ty = ay + by;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) {
      tx = ax;
      ty = ay;
    } else {
      tx /= tl;
      ty /= tl;
    }
    // Left normal of the averaged tangent, lengthened so the strip keeps its width round the bend.
    const cos = Math.max(0.5, tx * ax + ty * ay);
    const lx = -ty / cos;
    const ly = tx / cos;
    if (i > 0) run += al;
    const v = vLength ? run / vLength : 0;
    const left = b.vertex(x + lx * (half + offset), y + ly * (half + offset), h, 0, 0, 1, c, 0, v);
    const right = b.vertex(x - lx * (half - offset), y - ly * (half - offset), h, 0, 0, 1, c, 1, v);
    if (i > 0) b.quad(prevRight, right, left, prevLeft);
    prevLeft = left;
    prevRight = right;
  }
}

/** An upward-facing disc, for covering the gap where ribbons meet. */
export function disc(b: MeshBuilder, x: number, y: number, h: number, radius: number, c: RGB, segments = 14): void {
  const centre = b.vertex(x, y, h, 0, 0, 1, c, 0.5, 0.5);
  let prev = -1;
  let first = -1;
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const v = b.vertex(x + Math.cos(a) * radius, y + Math.sin(a) * radius, h, 0, 0, 1, c, 0.5, 0.5);
    if (i === 0) first = v;
    else b.tri(centre, prev, v);
    prev = v;
  }
  b.tri(centre, prev, first);
}

/** An axis-free box: centre (x, y), base height h0, top h1, half-extents along a heading. */
export function box(b: MeshBuilder, x: number, y: number, h0: number, h1: number, halfLength: number, halfWidth: number, headingRad: number, side: RGB, top: RGB): void {
  const ux = Math.cos(headingRad);
  const uy = Math.sin(headingRad);
  const corners: [number, number][] = [
    [x + ux * halfLength - uy * halfWidth, y + uy * halfLength + ux * halfWidth],
    [x - ux * halfLength - uy * halfWidth, y - uy * halfLength + ux * halfWidth],
    [x - ux * halfLength + uy * halfWidth, y - uy * halfLength - ux * halfWidth],
    [x + ux * halfLength + uy * halfWidth, y + uy * halfLength - ux * halfWidth],
  ];
  const flat = corners.flat();
  extrudePolygon(b, { outer: flat }, h0, h1, side, top);
}
