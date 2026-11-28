import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AircraftLayer } from '../src/render/dynamic/aircraft-layer.ts';
import { wingOver } from '../src/shared/airframe.ts';
import { Aircraft } from '../src/sim/airside/aircraft.ts';
import { FlightBook } from '../src/sim/airside/flights.ts';
import { AIRCRAFT, AIRLINES } from '../src/sim/fleet.ts';
import { loadModelsFromDisk } from './helpers/models.ts';

const models = loadModelsFromDisk(['narrow-body-airliner-619183', 'widebody-airliner-ae0a5a', 'double-deck-airliner']);
const layer = new AircraftLayer(models);
const book = new FlightBook([{ id: 0, airline: 'UA', type: 'B738', tail: 'N123UA', arrFlight: 'UA 1', depFlight: 'UA 2', from: 'LAX', to: 'SEA', arr: 0, dep: 3600, paxIn: 130, paxOut: 145, stand: 'E2', customs: false, internationalOut: false }]);
book.extendTo(0);
const visit = book.visits.get(200_000)!;

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
camera.position.set(0, 70, 20);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

describe('picking a moving aircraft between simulation steps', () => {
  it.each(Object.values(AIRCRAFT))('projects a point on the displayed $id wing under its own pick ray', (type) => {
    const a = new Aircraft(3, visit, type, AIRLINES[0]);
    a.phase = 'taxiOut';
    a.x = 7; // The simulation advanced 0.5 s at 14 m/s. The frame is just 1% of the way there.
    layer.update([a], 0.01);
    const side = type.span * 0.65 / 2;
    const wing = wingOver(type, side)!;
    const pixel = layer.projectPoint(a, new THREE.Vector3((wing.lead + wing.trail) / 2, wing.under + 0.25, side), camera)!;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(pixel.x, pixel.y), camera);
    expect(layer.pick(ray)?.id).toBe(a.id);
    layer.update([], 0.01);
    expect(layer.projectPoint(a, new THREE.Vector3(), camera)).toBeNull();
  });
});
