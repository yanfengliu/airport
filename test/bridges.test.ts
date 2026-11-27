// The jet bridges are drawn from Polyfork's jet bridge, cut into the parts that are placed or move
// apart (tools/models/polyfork.ts): the fixed link, its post and the rotunda are placed once along
// each mapped bridge (src/render/static/bridges.ts), and the tunnel, the cab and the lift move to
// the door of each aircraft that parks (src/render/dynamic/bridge-layer.ts), both by where
// JET_BRIDGE says each part is in the model. Bound: those measures, held to the converted parts;
// and at every stand with a bridge, for every type the stand takes, the cab's face at the front
// door with its floor at the sill, and nothing of the bridge (tunnel, lift or cab) in the wings,
// engines or tail, or in a floodlight mast, there or pulled back.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BridgeLayer, doorFor } from '../src/render/dynamic/bridge-layer.ts';
import { airfieldFurniture } from '../src/render/static/airfield-props.ts';
import { BRIDGE_PARTS, JET_BRIDGE, buildBridges } from '../src/render/static/bridges.ts';
import { airframe } from '../src/shared/airframe.ts';
import { outline, polygonGap } from '../src/shared/footprint.ts';
import { fuselageAt, newFuselage } from '../src/sim/airfield/path.ts';
import { standPath, type Aircraft } from '../src/sim/airside/aircraft.ts';
import { AIRCRAFT } from '../src/sim/fleet.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';
import { loadModelsFromDisk } from './helpers/models.ts';
import { once } from './helpers/once.ts';

const models = loadModelsFromDisk(Object.values(BRIDGE_PARTS));

/** A part's corners as converted: x along the bridge, y up, z across. */
function points(id: string): [number, number, number][] {
  const p = models.get(id)!.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]);
}

const span = (values: number[]): [number, number] => [Math.min(...values), Math.max(...values)];
const middle = (values: number[]): number => (Math.min(...values) + Math.max(...values)) / 2;

describe('the jet bridge model', () => {
  it('has its parts where the bridge layer places them by', () => {
    for (const id of Object.values(BRIDGE_PARTS)) expect(models.get(id), `${id} converted`).toBeDefined();
    const link = points(BRIDGE_PARTS.link);
    expect(span(link.map((p) => p[0]))[0]).toBeCloseTo(JET_BRIDGE.link[0], 1);
    expect(span(link.map((p) => p[0]))[1]).toBeCloseTo(JET_BRIDGE.link[1], 1);
    expect(Math.max(...link.map((p) => Math.abs(p[2])))).toBeCloseTo(JET_BRIDGE.linkHalf, 1);
    expect(middle(points(BRIDGE_PARTS.post).map((p) => p[0]))).toBeCloseTo(JET_BRIDGE.post, 1);
    // The rotunda's pedestal stands under its middle.
    expect(middle(points(BRIDGE_PARTS.rotunda).filter((p) => p[1] < 0.2).map((p) => p[0]))).toBeCloseTo(JET_BRIDGE.rotunda, 1);
    // The tunnel's walls, without the cables hung under its front.
    const walls = points(BRIDGE_PARTS.tunnel).filter((p) => p[1] > 2.7);
    expect(span(walls.map((p) => p[0]))[0]).toBeCloseTo(JET_BRIDGE.tunnel[0], 1);
    expect(span(walls.map((p) => p[0]))[1]).toBeCloseTo(JET_BRIDGE.tunnel[1], 1);
    // The cab's drum by its roof, its face, and the floor at the face.
    const cab = points(BRIDGE_PARTS.cab);
    expect(middle(cab.filter((p) => p[1] > 6.45).map((p) => p[0]))).toBeCloseTo(JET_BRIDGE.drum, 1);
    expect(span(cab.map((p) => p[0]))[1]).toBeCloseTo(JET_BRIDGE.door, 1);
    // At the face, the floor plate: its underside, then its top, the floor the door opens onto.
    const face = [...new Set(cab.filter((p) => p[0] > JET_BRIDGE.door - 0.05).map((p) => Math.round(p[1] * 100) / 100))].sort((a, b) => a - b);
    expect(face[1] - face[0]).toBeLessThan(0.3);
    expect(face[1]).toBeCloseTo(JET_BRIDGE.cabFloor, 1);
    expect(middle(points(BRIDGE_PARTS.lift).map((p) => p[0]))).toBeCloseTo(JET_BRIDGE.lift, 1);
    const legs = span(points(BRIDGE_PARTS.legs).map((p) => p[1]));
    expect(legs[0]).toBeCloseTo(JET_BRIDGE.legs[0], 1);
    expect(legs[1]).toBeCloseTo(JET_BRIDGE.legs[1], 1);
    // The wheels stand on the ground, below the legs.
    const wheels = span(points(BRIDGE_PARTS.wheels).map((p) => p[1]));
    expect(wheels[0]).toBeLessThan(0.1);
    expect(wheels[1]).toBeLessThanOrEqual(JET_BRIDGE.legs[0] + 0.01);
  });
});

describe('the jet bridges', () => {
  const layout = loadLayoutFromDisk();
  const bridges = once(() => buildBridges(layout.airfield, models));

  it('are all drawn from the model, each with a moving end', () => {
    const { ends, group } = bridges();
    expect(ends.length).toBeGreaterThan(90);
    const names = group.children.map((m) => m.name).sort();
    expect(names).toEqual(['jet-bridge-links', 'jet-bridge-posts', 'jet-bridge-rotundas']);
    expect((group.children.find((m) => m.name === 'jet-bridge-rotundas') as THREE.InstancedMesh).count).toBe(ends.length);
  });

  it('reach the front door of every type each stand takes, square on and level with its sill, clear of its wings, engines and tail and of the floodlight masts', () => {
    const faults: string[] = [];
    let docked = 0;
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const sim = new Sim(layout, { seed: 7, startTime: 4 * 3600 });
    // Each mast's base and pole, as a square three metres across.
    const masts = airfieldFurniture(layout).masts.map((m) => ({ stand: m.stand, x: m.x, y: m.y, square: [m.x - 1.5, m.y - 1.5, m.x + 1.5, m.y - 1.5, m.x + 1.5, m.y + 1.5, m.x - 1.5, m.y + 1.5] }));
    /** The tunnel, the lift under it and the cab of a layer's one bridge, in plan. */
    const parts = (layer: BridgeLayer): { tunnel: number[]; lift: number[]; cab: number[] } => {
      const plan = (name: string, x0: number, x1: number, half: number): number[] => {
        (layer.group.children.find((m) => m.name === name) as THREE.InstancedMesh).getMatrixAt(0, matrix);
        return [
          [x0, -half],
          [x1, -half],
          [x1, half],
          [x0, half],
        ].flatMap(([x, z]) => {
          at.set(x, 0, z).applyMatrix4(matrix);
          return [at.x, -at.z];
        });
      };
      return {
        tunnel: plan('jet-bridge-tunnels', JET_BRIDGE.rotunda + 2, JET_BRIDGE.drum - 2, 1.45),
        // The lift's columns stand out either side of the tunnel.
        lift: plan('jet-bridge-lifts', JET_BRIDGE.lift - 0.25, JET_BRIDGE.lift + 0.25, 2),
        cab: plan('jet-bridge-cabs', JET_BRIDGE.drum - 2, JET_BRIDGE.door, 2),
      };
    };
    const clearOfMasts = (what: string, end: { x0: number; y0: number }, bridge: Record<string, number[]>): void => {
      for (const m of masts) {
        if (Math.hypot(m.x - end.x0, m.y - end.y0) > 90) continue;
        for (const [name, part] of Object.entries(bridge)) if (polygonGap(part, m.square) === 0) faults.push(`${what}: the ${name} through ${m.stand}'s mast`);
      }
    };
    for (const end of bridges().ends) {
      // Pulled back, with no aircraft at the stand.
      const idle = new BridgeLayer([end], models);
      idle.update([], 0);
      clearOfMasts(`${end.stand} pulled back`, end, parts(idle));
      const usable = sim.usableStands.get(end.stand);
      if (usable === undefined) continue;
      for (const type of Object.values(AIRCRAFT)) {
        if (type.span > usable + 0.5) continue;
        const path = standPath(sim.airside.net, end.stand, type.length);
        if (!path) continue;
        const pose = fuselageAt(path, path.total, newFuselage());
        const plane = { x: pose.x, y: pose.y, heading: pose.heading, type, phase: 'parked', visit: { stand: end.stand, doorsClosed: false } } as unknown as Aircraft;
        const layer = new BridgeLayer([end], models);
        layer.update([plane], 0);
        const placed = (name: string): THREE.Matrix4 => {
          (layer.group.children.find((m) => m.name === name) as THREE.InstancedMesh).getMatrixAt(0, matrix);
          return matrix;
        };
        // The middle of the cab's face, at its floor.
        at.set(JET_BRIDGE.door, JET_BRIDGE.cabFloor, 0).applyMatrix4(placed('jet-bridge-cabs'));
        const door = doorFor(plane, end.x0, end.y0);
        const sill = airframe(type).doors.front.sill;
        const off = Math.hypot(at.x - door.x, -at.z - door.y);
        if (off > 0.05 || Math.abs(at.y - sill) > 0.05) faults.push(`${type.id} at ${end.stand}: the cab's face ${off.toFixed(2)} m from the door, its floor at ${at.y.toFixed(2)} m for a sill at ${sill.toFixed(2)} m`);
        // In plan: the tunnel from the rotunda's wall to the drum's, and the cab, against the outline.
        const bridge = parts(layer);
        clearOfMasts(`${type.id} at ${end.stand}`, end, bridge);
        const [, ...rest] = outline(type, plane.x, plane.y, plane.heading);
        for (const [k, part] of rest.entries()) {
          for (const [name, piece] of Object.entries(bridge)) if (polygonGap(piece, part) === 0) faults.push(`${type.id} at ${end.stand}: the ${name} in part ${k + 1} of the aircraft`);
        }
        docked += 1;
      }
    }
    expect(docked).toBeGreaterThan(300);
    expect(faults.slice(0, 12)).toEqual([]);
  });
});
