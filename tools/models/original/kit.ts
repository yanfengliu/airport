// A small kit for making our own models the way Polyfork's are made: low-poly solids built from
// boxes, prisms and lofts, every face one flat colour from a named palette whose slots the app can
// change per instance (a train's livery, a tail in an airline's colour), and named parts that turn
// or slide about their own pivots, so that a model can be drawn in poses (doors open, gear up).
// What it makes is written in the app's compact form by tools/models/format.ts and listed in
// public/models/index.json as our own, not Polyfork's.
//
// The model's frame: +z its front, +x its left, +y up, metres, its origin on the ground under its
// middle.

import type { CompactMesh } from '../format.ts';

export type V3 = [number, number, number];

/** A colour given as sRGB hex, stored as the linear RGB the app's palettes hold. */
function linear(hex: number): V3 {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
  return c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))) as V3;
}

/** How a part is moved in a pose: turned about an axis through its pivot, then slid. */
export interface Move {
  /** Axis (unit vector) and angle, radians, right-handed. */
  turn?: { axis: V3; angle: number };
  slide?: V3;
}

interface Part {
  name: string;
  pivot: V3;
  parent: number;
}

export class ModelKit {
  private readonly colours: { name: string; rgb: V3 }[] = [];
  private readonly parts: Part[] = [{ name: 'body', pivot: [0, 0, 0], parent: -1 }];
  private readonly positions: number[] = [];
  private readonly slots: number[] = [];
  private readonly bones: number[] = [];
  private readonly triangles: number[] = [];
  private readonly welded = new Map<string, number>();
  private readonly frames: Map<string, Move>[] = [];
  private readonly poseNames = new Map<string, [number, number]>();

  /** A named colour slot, sRGB hex; asking again for a name gives its slot. */
  colour(name: string, hex: number): number {
    const known = this.colours.findIndex((c) => c.name === name);
    if (known >= 0) return known;
    this.colours.push({ name, rgb: linear(hex) });
    return this.colours.length - 1;
  }

  /** A part that can move, about `pivot`, carried by `parent` (the body unless said). */
  part(name: string, pivot: V3, parent = 'body'): number {
    const p = this.parts.findIndex((q) => q.name === parent);
    if (p < 0) throw new Error(`no part ${parent}`);
    this.parts.push({ name, pivot, parent: p });
    return this.parts.length - 1;
  }

  private vertex(p: V3, slot: number, bone: number): number {
    const key = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}:${slot}:${bone}`;
    const known = this.welded.get(key);
    if (known !== undefined) return known;
    const i = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.slots.push(slot);
    this.bones.push(bone);
    this.welded.set(key, i);
    return i;
  }

  /** A triangle, its corners counter-clockwise seen from outside. */
  tri(bone: number, slot: number, a: V3, b: V3, c: V3): void {
    this.triangles.push(this.vertex(a, slot, bone), this.vertex(b, slot, bone), this.vertex(c, slot, bone));
  }

  /** A four-sided face, corners counter-clockwise seen from outside. */
  quad(bone: number, slot: number, a: V3, b: V3, c: V3, d: V3): void {
    this.tri(bone, slot, a, b, c);
    this.tri(bone, slot, a, c, d);
  }

  /** A box between two corners; the slot of each face may differ: [sides, top, bottom]. */
  box(bone: number, slot: number | [number, number, number], lo: V3, hi: V3): void {
    const [side, top, bottom] = typeof slot === 'number' ? [slot, slot, slot] : slot;
    const [x0, y0, z0] = lo;
    const [x1, y1, z1] = hi;
    this.quad(bone, side, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // front
    this.quad(bone, side, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // back
    this.quad(bone, side, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // left
    this.quad(bone, side, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // right
    this.quad(bone, top, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    this.quad(bone, bottom, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  }

  /**
   * A solid through rings of points (each the same count, going round the same way), from the
   * first ring to the last, capped at both ends: a fuselage, a nacelle, a car's body. `slotOf`
   * colours each band between rings by the band's index and the side's index.
   */
  loft(bone: number, rings: V3[][], slotOf: (band: number, side: number) => number, caps: [number, number] | null = null): void {
    const n = rings[0].length;
    for (let r = 0; r + 1 < rings.length; r += 1) {
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        this.quad(bone, slotOf(r, i), rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]);
      }
    }
    if (caps) {
      const first = rings[0];
      const last = rings[rings.length - 1];
      for (let i = 1; i + 1 < n; i += 1) {
        this.tri(bone, caps[0], first[0], first[i + 1], first[i]);
        this.tri(bone, caps[1], last[0], last[i], last[i + 1]);
      }
    }
  }

  /** A prism along z from `z0` to `z1` whose section is the convex polygon `outline` (x, y), counter-clockwise. */
  prism(bone: number, slot: number | [number, number], outline: [number, number][], z0: number, z1: number): void {
    const [side, ends] = typeof slot === 'number' ? [slot, slot] : slot;
    const back = outline.map(([x, y]): V3 => [x, y, z0]);
    const front = outline.map(([x, y]): V3 => [x, y, z1]);
    this.loft(bone, [back, front], () => side, [ends, ends]);
  }

  /** A cylinder of `sides` faces round an axis from `a` to `b`. */
  cylinder(bone: number, slot: number | [number, number], a: V3, b: V3, radius: number, sides = 8): void {
    const [side, ends] = typeof slot === 'number' ? [slot, slot] : slot;
    const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    const w = axis.map((v) => v / len);
    // Two directions square to the axis.
    const helper = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [w[1] * helper[2] - w[2] * helper[1], w[2] * helper[0] - w[0] * helper[2], w[0] * helper[1] - w[1] * helper[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    const uu = u.map((v) => v / ul);
    const vv = [w[1] * uu[2] - w[2] * uu[1], w[2] * uu[0] - w[0] * uu[2], w[0] * uu[1] - w[1] * uu[0]];
    const ring = (c: V3): V3[] =>
      Array.from({ length: sides }, (_, k) => {
        const t = (k / sides) * Math.PI * 2;
        return [0, 1, 2].map((d) => c[d] + radius * (Math.cos(t) * uu[d] + Math.sin(t) * vv[d])) as V3;
      });
    this.loft(bone, [ring(a), ring(b)], () => side, [ends, ends]);
  }

  /**
   * A pose: how each named part is moved in it (parts not named stay as made). Several poses
   * under one name make an animation, played in the order given.
   */
  pose(name: string, moves: Record<string, Move>): void {
    const frame = new Map<string, Move>(Object.entries(moves));
    const known = this.poseNames.get(name);
    if (known && known[0] + known[1] !== this.frames.length) throw new Error(`pose ${name}: frames out of order`);
    this.poseNames.set(name, known ? [known[0], known[1] + 1] : [this.frames.length, 1]);
    this.frames.push(frame);
  }

  /** The rows of the 3x4 matrix of each part in a pose: turned about its pivot and slid, after its parent. */
  private matrices(frame: Map<string, Move>): number[][] {
    const out: number[][] = [];
    for (const [i, p] of this.parts.entries()) {
      const move = frame.get(p.name);
      // Rotation about the axis (Rodrigues), about the pivot, then the slide.
      let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (move?.turn) {
        const [x, y, z] = move.turn.axis;
        const c = Math.cos(move.turn.angle);
        const s = Math.sin(move.turn.angle);
        const t = 1 - c;
        r = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
      }
      const [px, py, pz] = p.pivot;
      const slide = move?.slide ?? [0, 0, 0];
      const own = [
        [r[0], r[1], r[2], px - (r[0] * px + r[1] * py + r[2] * pz) + slide[0]],
        [r[3], r[4], r[5], py - (r[3] * px + r[4] * py + r[5] * pz) + slide[1]],
        [r[6], r[7], r[8], pz - (r[6] * px + r[7] * py + r[8] * pz) + slide[2]],
      ];
      if (p.parent < 0) {
        out.push(own.flat());
        continue;
      }
      // After the parent's: parent · own.
      const q = out[p.parent];
      const pm = [q.slice(0, 4), q.slice(4, 8), q.slice(8, 12)];
      const composed: number[] = [];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          let v = col === 3 ? pm[row][3] : 0;
          for (let k = 0; k < 3; k += 1) v += pm[row][k] * own[k][col];
          composed.push(v);
        }
      }
      void i;
      out.push(composed);
    }
    return out;
  }

  /** What the model is, ready to write: its mesh, palette, parts and poses. */
  build(): { mesh: CompactMesh; palette: number[]; colours: string[]; parts: string[]; poses: Record<string, [number, number]> | undefined } {
    const moving = this.parts.length > 1 || this.frames.length > 0;
    // Every model with moving parts has its pose as made first, 'rest'.
    const frames = moving ? [new Map<string, Move>(), ...this.frames] : [];
    const poses: Record<string, [number, number]> | undefined = moving ? { rest: [0, 1] } : undefined;
    if (poses) for (const [name, [first, count]] of this.poseNames) poses[name] = [first + 1, count];
    return {
      mesh: {
        positions: this.positions,
        slots: this.slots,
        bones: moving ? this.bones : undefined,
        triangles: this.triangles,
        matrices: moving ? frames.flatMap((f) => this.matrices(f).flat()) : undefined,
      },
      palette: this.colours.flatMap((c) => c.rgb.map((v) => Math.round(v * 10000) / 10000)),
      colours: this.colours.map((c) => c.name),
      parts: this.parts.map((p) => p.name),
      poses,
    };
  }
}
