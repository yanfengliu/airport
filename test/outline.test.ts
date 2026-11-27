// The outline the stands are judged by is the aircraft as it is drawn. Review 1 found the stand
// rule's "true-size" outline built with one set of proportions for every type, while the model drew
// each type its own way: D8's A220-300 and D9's 777-300ER had wings in each other that the rule
// passed as 1.3 m apart, and on seed 11 an A321neo at E3 and a 787-9 at E6 parked with their wings
// 0.1 m apart. Since then most types are drawn with one of Polyfork's airliners fitted to their
// size, and their outline is that model's shape (src/shared/airframe.ts): every triangle of the
// model as drawn must lie inside it, and every corner of it must be near something drawn. Bound:
// every type in the fleet, drawn, and placed at every stand it can take as the aircraft layer
// places a parked aircraft; the meshes are read without a GPU.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LIVERY_SLOTS } from '../src/render/dynamic/aircraft-layer.ts';
import { buildAircraftGeometry } from '../src/render/models/aircraft.ts';
import { MODEL_SHAPES, OWN_MODEL, modelFit } from '../src/shared/airframe.ts';
import { outline, shapeClearance } from '../src/shared/footprint.ts';
import { fuselageAt, newFuselage } from '../src/sim/airfield/path.ts';
import { standPath } from '../src/sim/airside/aircraft.ts';
import { AIRCRAFT, type AircraftType } from '../src/sim/fleet.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk, repoRoot } from './helpers/layout.ts';

/** Metres within which two points are one: the mesh is kept in 32-bit numbers. */
const TOL = 1e-3;

function inside(x: number, y: number, poly: readonly number[]): boolean {
  let within = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    if (poly[i + 1] > y !== poly[j + 1] > y && x < ((poly[j] - poly[i]) * (y - poly[i + 1])) / (poly[j + 1] - poly[i + 1]) + poly[i]) within = !within;
  }
  return within;
}

function toEdge(x: number, y: number, poly: readonly number[]): number {
  let least = Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const [ax, ay, bx, by] = [poly[i], poly[i + 1], poly[(i + 2) % poly.length], poly[(i + 3) % poly.length]];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
    least = Math.min(least, Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t));
  }
  return least;
}

/** A converted model's triangles, read from public/models as the app loads them: positions in its own frame. */
function modelTriangles(id: string): Float32Array {
  const index = JSON.parse(readFileSync(join(repoRoot, 'public', 'models', 'index.json'), 'utf8'));
  const list = (Array.isArray(index) ? index : index.models) as { id: string; file: string; vertices: number; triangles: number; box: number[]; bones?: number }[];
  const info = list.find((m) => m.id === id)!;
  const buffer = readFileSync(join(repoRoot, 'public', 'models', info.file));
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const n = info.vertices;
  const q = new Int16Array(data, 0, n * 3);
  let at = n * 6 + n + (info.bones ? n : 0);
  at = Math.ceil(at / 4) * 4;
  const wide = n > 65535;
  const count = info.triangles * 3;
  const indices = wide ? new Uint32Array(data.slice(at, at + count * 4)) : new Uint16Array(data.slice(at, at + count * 2));
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) out[i * 3 + k] = info.box[k] + ((q[indices[i] * 3 + k] + 32768) / 65535) * info.box[3 + k];
  }
  return out;
}

/** Points over a triangle, its corners and every `step` metres across it. */
function samples(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, step: number, out: [number, number][]): void {
  const n = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / step));
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; i + j <= n; j += 1) {
      const u = i / n;
      const v = j / n;
      const x = a.x + (b.x - a.x) * u + (c.x - a.x) * v;
      const z = a.z + (b.z - a.z) * u + (c.z - a.z) * v;
      out.push([x, -z]);
    }
  }
}

/**
 * What is drawn for a type, seen from above and placed by `matrix` (as the aircraft layer places
 * an instance), as map x and y: for a type drawn with a Polyfork model, points all over every
 * triangle of the model as fitted; for one drawn from its proportions, every vertex.
 */
function drawn(type: AircraftType, matrix = new THREE.Matrix4()): [number, number][] {
  const out: [number, number][] = [];
  const fit = modelFit(type) ?? (OWN_MODEL[type.id] ? { id: OWN_MODEL[type.id], along: 1, across: 1, up: 1, mid: 0 } : null);
  if (fit) {
    // The model's frame (+z its nose, +x its left, +y up) brought to the layer's (+x the nose, -z
    // the left, +y up), centred and scaled as src/render/dynamic/aircraft-layer.ts does.
    const toBody = new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(new THREE.Matrix4().makeScale(fit.across, fit.up, fit.along)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -fit.mid));
    const full = matrix.clone().multiply(toBody);
    const t = modelTriangles(fit.id);
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < t.length; i += 9) {
      a.set(t[i], t[i + 1], t[i + 2]).applyMatrix4(full);
      b.set(t[i + 3], t[i + 4], t[i + 5]).applyMatrix4(full);
      c.set(t[i + 6], t[i + 7], t[i + 8]).applyMatrix4(full);
      samples(a, b, c, 0.3, out);
    }
    return out;
  }
  const g = buildAircraftGeometry(type);
  const v = new THREE.Vector3();
  for (const geometry of [g.body, g.livery]) {
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 1) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      out.push([v.x, -v.z]);
    }
  }
  return out;
}

/** The aircraft layer's placement of a parked aircraft at (x, y) facing `heading`: level, on the ground. */
function placement(x: number, y: number, heading: number): THREE.Matrix4 {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heading, 0, 'YZX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, -y), quaternion, new THREE.Vector3(1, 1, 1));
}

/**
 * What is drawn but outside the outline, and corners of the outline with nothing drawn near them:
 * within a millimetre for a type drawn from its proportions, whose outline is made from its own
 * vertices, and within `loose` metres for one drawn with a fitted model, whose outline bounds it.
 */
function mismatches(points: readonly [number, number][], polygons: readonly number[][], loose = TOL): string[] {
  const out: string[] = [];
  // A fitted model is stored in 16-bit positions, a millimetre apart on a wide-body, and its
  // outline was fitted to points 0.25 m apart across its triangles: allow it 2 cm.
  const near = loose > TOL ? 0.02 : TOL;
  for (const [x, y] of points) {
    if (!polygons.some((poly) => inside(x, y, poly) || toEdge(x, y, poly) < near)) out.push(`drawn at ${x.toFixed(3)}, ${y.toFixed(3)}, outside the outline`);
  }
  for (const [k, poly] of polygons.entries()) {
    for (let i = 0; i < poly.length; i += 2) {
      if (!points.some(([x, y]) => Math.hypot(x - poly[i], y - poly[i + 1]) < loose)) out.push(`part ${k} corner ${poly[i].toFixed(3)}, ${poly[i + 1].toFixed(3)} not drawn`);
    }
  }
  return out;
}

/** How near something drawn each corner of a type's outline must be, metres. */
const looseness = (type: AircraftType): number => (modelFit(type) || OWN_MODEL[type.id] ? 1.6 : TOL);

const sim = new Sim(loadLayoutFromDisk(), { seed: 7, startTime: 4 * 3600 });
const net = sim.airside.net;

describe('the outline the stands are judged by', () => {
  it('is what the model draws, for every type', () => {
    for (const type of Object.values(AIRCRAFT)) {
      const found = mismatches(drawn(type), outline(type, 0, 0, 0), looseness(type));
      expect(found.slice(0, 5), type.id).toEqual([]);
    }
  });

  it('stands where the aircraft layer draws a parked aircraft, at every stand and for every type it takes', () => {
    const faults: string[] = [];
    let compared = 0;
    const corner = new THREE.Vector3();
    for (const [stand, span] of sim.usableStands) {
      for (const type of Object.values(AIRCRAFT)) {
        if (type.span > span + 0.5) continue;
        const shape = sim.airside.parkedShape(stand, type);
        const path = standPath(net, stand, type.length);
        if (!shape || !path) continue;
        // Where a parked aircraft is put, as Aircraft.startParked puts it and the layer draws it.
        const at = fuselageAt(path, path.total, newFuselage());
        const matrix = placement(at.x, at.y, at.heading);
        const body = outline(type, 0, 0, 0);
        for (const [k, poly] of body.entries()) {
          for (let i = 0; i < poly.length; i += 2) {
            corner.set(poly[i], 0, -poly[i + 1]).applyMatrix4(matrix);
            const gap = Math.hypot(corner.x - shape.polygons[k][i], -corner.z - shape.polygons[k][i + 1]);
            if (gap > 1e-6) faults.push(`${type.id} at ${stand}: part ${k} corner ${i / 2} off by ${gap} m`);
          }
        }
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(faults.slice(0, 5)).toEqual([]);
  });

  it('matches the drawn aircraft at the stands of the pairs review 1 found', () => {
    for (const [stand, id] of [['D8', 'BCS3'], ['D9', 'B77W'], ['E3', 'A21N'], ['E6', 'B789']] as const) {
      const type = AIRCRAFT[id];
      const path = standPath(net, stand, type.length)!;
      const at = fuselageAt(path, path.total, newFuselage());
      expect(mismatches(drawn(type, placement(at.x, at.y, at.heading)), sim.airside.parkedShape(stand, type)!.polygons, looseness(type)).slice(0, 5), `${id} at ${stand}`).toEqual([]);
    }
  });

  it('keeps those pairs off their stands together: drawn, they are less than a metre apart', () => {
    const pairs = [['D8', 'BCS3', 'D9', 'B77W'], ['E3', 'A21N', 'E6', 'B789']] as const;
    for (const [s1, t1, s2, t2] of pairs) {
      const gap = shapeClearance(sim.airside.parkedShape(s1, AIRCRAFT[t1])!, sim.airside.parkedShape(s2, AIRCRAFT[t2])!);
      expect(gap, `${t1} at ${s1} and ${t2} at ${s2}`).toBeLessThan(1);
      expect(sim.airside.fitTogether(s1, AIRCRAFT[t1], s2, AIRCRAFT[t2]), `${t1} at ${s1} and ${t2} at ${s2}`).toBe(false);
      expect(sim.airside.fitTogether(s2, AIRCRAFT[t2], s1, AIRCRAFT[t1])).toBe(false);
    }
  });
});

describe("Polyfork's airliners as drawn", () => {
  it("paints the airline's colour on the fin of each, and not on the cabin", () => {
    const index = JSON.parse(readFileSync(join(repoRoot, 'public', 'models', 'index.json'), 'utf8'));
    const list = (Array.isArray(index) ? index : index.models) as { id: string; file: string; vertices: number; box: number[] }[];
    for (const [id, slots] of Object.entries(LIVERY_SLOTS)) {
      const info = list.find((m) => m.id === id)!;
      const shape = MODEL_SHAPES[id];
      const buffer = readFileSync(join(repoRoot, 'public', 'models', info.file));
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const n = info.vertices;
      const q = new Int16Array(data, 0, n * 3);
      const slot = new Uint8Array(data, n * 6, n);
      let fin = 0;
      let finPainted = 0;
      let cabin = 0;
      let cabinPainted = 0;
      for (let i = 0; i < n; i += 1) {
        // The model's frame: x to its left, y up, z towards its nose.
        const [x, y, z] = [0, 1, 2].map((k) => info.box[k] + ((q[i * 3 + k] + 32768) / 65535) * info.box[3 + k]);
        const painted = slots.includes(slot[i]);
        if (Math.abs(x) < shape.fin.half + 0.1 && y > shape.cabin[1] + 0.5) {
          fin += 1;
          if (painted) finPainted += 1;
        } else if (Math.abs(x) < shape.half && y < shape.cabin[1] && z > shape.nose - shape.length * 0.3 && z < shape.nose - shape.length * 0.12) {
          cabin += 1;
          if (painted) cabinPainted += 1;
        }
      }
      expect(finPainted / fin, `${id}: share of the fin painted`).toBeGreaterThan(0.5);
      expect(cabinPainted / cabin, `${id}: share of the cabin painted`).toBeLessThan(0.15);
    }
  });
});
