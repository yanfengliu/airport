// What the road vehicles and the trains are drawn as is the size the simulation moves them at: the
// simulation keeps a car's length behind the one ahead and trains on tracks side by side apart by
// their cars' width, so a model drawn longer or wider than that shows them touching where they do
// not. Bound: near the camera each road vehicle is one of Polyfork's of its kind, scaled to its
// length, centred on where it is, on the road, within the narrowest lane, a truck's trailer joined to
// its tractor; every train car's model is its line's car, less the gap between two coupled, and no
// wider than it with its doors open; the doors open and close over their 1.6 s.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DOORS_MOVE, GAP, MODELS, doorShare } from '../src/render/dynamic/train-layer.ts';
import { TRAILER, VEHICLE_MODELS, VehicleLayer } from '../src/render/dynamic/vehicle-layer.ts';
import { CONFIG } from '../src/sim/config.ts';
import { LANE_WIDTH } from '../src/shared/road-spec.ts';
import { VEHICLE_LENGTH, type Vehicle, type VehicleKind } from '../src/sim/roads/traffic.ts';
import { loadModelsFromDisk } from './helpers/models.ts';

const ids = [...Object.values(VEHICLE_MODELS).flatMap((list) => list.map((m) => m.id)), TRAILER.id];
const models = loadModelsFromDisk(ids);

/** A vehicle's drawn extent, metres: along its heading from its point, across it, and its lowest point. */
function extent(layer: VehicleLayer, id: string, v: Vehicle): { back: number; front: number; across: number; bottom: number } {
  const mesh = layer.group.children.find((m) => m.name === `vehicles-${id}`) as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  const p = models.get(id)!.geometry.getAttribute('position');
  const at = new THREE.Vector3();
  const c = Math.cos(v.heading);
  const s = Math.sin(v.heading);
  const out = { back: Infinity, front: -Infinity, across: 0, bottom: Infinity };
  for (let i = 0; i < p.count; i += 1) {
    at.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(matrix);
    const dx = at.x - v.x;
    const dy = -at.z - v.y;
    const along = dx * c + dy * s;
    out.back = Math.min(out.back, along);
    out.front = Math.max(out.front, along);
    out.across = Math.max(out.across, Math.abs(-dx * s + dy * c));
    out.bottom = Math.min(out.bottom, at.y - v.z);
  }
  return out;
}

describe('road vehicles drawn as models', () => {
  const narrowest = Math.min(...Object.values(LANE_WIDTH));

  it('are the length the simulation moves them at, centred where they are, on the road', () => {
    for (const [kind, list] of Object.entries(VEHICLE_MODELS) as [VehicleKind, { id: string }[]][]) {
      list.forEach((m, k) => {
        const layer = new VehicleLayer(models);
        // The model is chosen by the vehicle's id; this one is the kth of its kind.
        const v = { id: k, kind, length: VEHICLE_LENGTH[kind], colour: 0x3366aa, x: 120, y: -40, z: 2, px: 120, py: -40, pz: 2, heading: 0.7, pheading: 0.7 } as unknown as Vehicle;
        layer.update([v], 1, 200, null, v.x, v.y);
        const half = v.length / 2;
        const body = extent(layer, m.id, v);
        expect(body.bottom, `${m.id} on the road`).toBeCloseTo(0, 1);
        if (kind !== 'truck') {
          expect(body.back, `${m.id} back`).toBeCloseTo(-half, 1);
          expect(body.front, `${m.id} front`).toBeCloseTo(half, 1);
          // Within the narrowest lane it can drive in, so that two side by side do not touch.
          expect(body.across, `${m.id} half its width`).toBeLessThan(narrowest / 2);
          return;
        }
        // A truck: the tractor at the front of its length, the trailer at the back, coupled.
        const trailer = extent(layer, TRAILER.id, v);
        expect(body.front, 'the tractor at the front').toBeCloseTo(half, 1);
        expect(trailer.back, 'the trailer at the back').toBeCloseTo(-half, 1);
        expect(trailer.front - trailer.back, 'the trailer its own length').toBeCloseTo(TRAILER.length, 1);
        expect(trailer.front, 'the trailer reaching the tractor').toBeGreaterThan(body.back);
        expect(trailer.bottom, 'the trailer on the road').toBeCloseTo(0, 1);
        expect(Math.max(body.across, trailer.across), 'the truck within its lane').toBeLessThan(narrowest / 2);
      });
    }
  });
});

describe('trains drawn as models', () => {
  const index = loadModelsFromDisk(Object.values(MODELS).flatMap((m) => [m.car, ...(m.cab ? [m.cab] : [])]));

  it('are the car of their line, less the gap between two coupled', () => {
    for (const [kind, wanted] of Object.entries(MODELS) as [keyof typeof MODELS, { car: string; cab?: string }][]) {
      const car = CONFIG.transit.cars[kind];
      for (const id of [wanted.car, ...(wanted.cab ? [wanted.cab] : [])]) {
        const model = index.get(id)!;
        expect(model, id).toBeDefined();
        const [, , , across, , along] = model.info.box;
        if (id === MODELS.airtrain.car) continue; // Polyfork's shuttle, scaled to the car when drawn.
        // As long as its car less the gap between two coupled, give or take couplers, and never so
        // long that two coupled cars meet.
        expect(along, `${id} length`).toBeGreaterThan(car.length - GAP - 0.1);
        expect(along, `${id} length`).toBeLessThan(car.length - 0.4);
        expect(across, `${id} width`).toBeGreaterThan(car.width - 0.3);
        // No wider than the car, its doors open as in the last frame of their opening.
        const [first, count] = model.info.poses!.doors;
        const frame = first + count - 1;
        const bones = model.info.bones!;
        const p = model.geometry.getAttribute('position');
        const bone = model.geometry.getAttribute('bone');
        let widest = 0;
        for (let i = 0; i < p.count; i += 1) {
          const m = (frame * bones + bone.getX(i)) * 12;
          const x = model.poses![m] * p.getX(i) + model.poses![m + 1] * p.getY(i) + model.poses![m + 2] * p.getZ(i) + model.poses![m + 3];
          widest = Math.max(widest, Math.abs(x));
        }
        expect(2 * widest, `${id} width, doors open`).toBeLessThanOrEqual(car.width);
      }
    }
  });

  it('open their doors over 1.6 s, keep them open, and close them over the last 1.6 s', () => {
    const since = 1000;
    const until = since + 30;
    expect(doorShare(since, until, since)).toBe(0);
    expect(doorShare(since, until, since + DOORS_MOVE / 2)).toBeCloseTo(0.5, 6);
    expect(doorShare(since, until, since + DOORS_MOVE)).toBe(1);
    expect(doorShare(since, until, since + 15)).toBe(1);
    expect(doorShare(since, until, until - DOORS_MOVE / 2)).toBeCloseTo(0.5, 6);
    expect(doorShare(since, until, until)).toBe(0);
    expect(doorShare(since, until, until + 5)).toBe(0);
    // A stop shorter than opening and closing: the doors only part-open.
    expect(doorShare(since, since + 2, since + 1)).toBeCloseTo(1 / DOORS_MOVE, 6);
  });
});
