// The outline the stands are judged by is the aircraft as the model draws it. Review 1 found the
// stand rule's "true-size" outline built with one set of proportions for every type, while the
// model draws each type its own way: D8's A220-300 and D9's 777-300ER had wings in each other that
// the rule passed as 1.3 m apart, and on seed 11 an A321neo at E3 and a 787-9 at E6 parked with
// their wings 0.1 m apart. Bound: every type in the fleet, drawn, and placed at every stand it can
// take as the aircraft layer places a parked aircraft; the meshes are built without a GPU.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildAircraftGeometry } from '../src/render/models/aircraft.ts';
import { outline, shapeClearance } from '../src/shared/footprint.ts';
import { fuselageAt, newFuselage } from '../src/sim/airfield/path.ts';
import { standPath } from '../src/sim/airside/aircraft.ts';
import { AIRCRAFT, type AircraftType } from '../src/sim/fleet.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

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

/** Every vertex the model draws for a type, seen from above, placed by `matrix` (as the aircraft layer places an instance); map x and y. */
function drawn(type: AircraftType, matrix = new THREE.Matrix4()): [number, number][] {
  const g = buildAircraftGeometry(type);
  const v = new THREE.Vector3();
  const out: [number, number][] = [];
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

/** What is drawn but outside the outline, and corners of the outline that are not drawn. */
function mismatches(points: readonly [number, number][], polygons: readonly number[][]): string[] {
  const out: string[] = [];
  for (const [x, y] of points) {
    if (!polygons.some((poly) => inside(x, y, poly) || toEdge(x, y, poly) < TOL)) out.push(`drawn at ${x.toFixed(3)}, ${y.toFixed(3)}, outside the outline`);
  }
  for (const [k, poly] of polygons.entries()) {
    for (let i = 0; i < poly.length; i += 2) {
      if (!points.some(([x, y]) => Math.hypot(x - poly[i], y - poly[i + 1]) < TOL)) out.push(`part ${k} corner ${poly[i].toFixed(3)}, ${poly[i + 1].toFixed(3)} not drawn`);
    }
  }
  return out;
}

const sim = new Sim(loadLayoutFromDisk(), { seed: 7, startTime: 4 * 3600 });
const net = sim.airside.net;

describe('the outline the stands are judged by', () => {
  it('is what the model draws, for every type', () => {
    for (const type of Object.values(AIRCRAFT)) {
      const found = mismatches(drawn(type), outline(type, 0, 0, 0));
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
      expect(mismatches(drawn(type, placement(at.x, at.y, at.heading)), sim.airside.parkedShape(stand, type)!.polygons).slice(0, 5), `${id} at ${stand}`).toEqual([]);
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
