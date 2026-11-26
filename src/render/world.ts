// The static world: everything that does not move, built once from the layout.

import * as THREE from 'three';
import type { Layout } from '../shared/layout.ts';
import { Lights } from './lights.ts';
import { buildAirfieldGround } from './static/airfield.ts';
import { buildBuildings, type NightGlow } from './static/buildings.ts';
import { buildGroundGlow } from './static/glow.ts';
import { buildGround } from './static/ground.ts';
import { buildTower } from './static/landmarks.ts';
import { buildRail } from './static/rail.ts';
import { buildRoads } from './static/roads.ts';
import { buildTerminalShells } from './static/terminals.ts';
import { facadeTextures } from './textures.ts';

export interface FrameView {
  /** Height of the drawing area in pixels, vertical field of view in degrees, fog density. */
  height: number;
  fov: number;
  fog: number;
  /** Brightness of lamps and lit windows against the current exposure. */
  lamp: number;
}

export interface StaticWorld {
  group: THREE.Group;
  /** Terminal walls and roofs, hidden in cut-away view. */
  terminalShell: THREE.Group;
  /** Fixed lights, and the moving ones other layers add each frame between `begin` and `end`. */
  lights: Lights;
  /** Advance animated parts: `seconds` of running time, `day` from 0 (night) to 1. */
  update(seconds: number, day: number, view: FrameView): void;
  stats: { meshes: number; triangles: number };
}

export function buildStaticWorld(layout: Layout): StaticWorld {
  const group = new THREE.Group();
  group.name = 'static-world';
  const facades = facadeTextures();
  const glows: NightGlow[] = [];

  const ground = buildGround(layout.land);
  group.add(ground.group);
  group.add(buildAirfieldGround(layout.airfield));
  group.add(buildRoads(layout.roads));
  group.add(buildRail(layout.rail));

  const [towerX, towerY] = layout.airfield.tower;
  // The mapped shaft and cab of the tower are replaced by the modelled one.
  const nearTower = (flat: number[]): boolean => Math.hypot(flat[0] - towerX, flat[1] - towerY) < 40;
  // Parts of a terminal's roof mapped as buildings of their own belong to the terminal, and come
  // off with its roof in the cut-away view.
  const footprints = layout.terminals.buildings.map((t) => t.poly.outer);
  const inTerminal = (outer: number[]): boolean => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < outer.length; i += 2) {
      x += outer[i];
      y += outer[i + 1];
    }
    x /= outer.length / 2;
    y /= outer.length / 2;
    return footprints.some((ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        if (ring[i + 1] > y !== ring[j + 1] > y && x < ((ring[j] - ring[i]) * (y - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) inside = !inside;
      }
      return inside;
    });
  };
  const buildings = buildBuildings(layout.buildings, facades, (b) => inTerminal(b.poly.outer) || (b.height > 40 && nearTower(b.poly.outer)));
  group.add(buildings.group);
  glows.push(...buildings.glows);

  const terminals = buildTerminalShells(layout.terminals, layout.airfield, facades);
  const roofParts = buildBuildings(layout.buildings, facades, (b) => !inTerminal(b.poly.outer));
  terminals.shell.add(roofParts.group);
  group.add(terminals.shell, terminals.fixtures);
  glows.push(...terminals.glows, ...roofParts.glows);

  const tower = buildTower(towerX, towerY);
  group.add(tower);
  glows.push({ material: tower.userData.cabGlass as THREE.MeshStandardMaterial, strength: 0.5 });

  const lights = new Lights(layout.airfield, layout.roads, layout.land);
  group.add(lights.group);
  const glow = buildGroundGlow(layout.airfield, layout.roads);
  group.add(glow.mesh);

  let meshes = 0;
  let triangles = 0;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  });
  group.updateMatrixWorld(true);

  return {
    group,
    terminalShell: terminals.shell,
    lights,
    update(seconds: number, day: number, view: FrameView): void {
      ground.animate(seconds);
      const night = Math.pow(1 - day, 1.5);
      // Lights come on through dusk, a little before the sky is fully dark.
      const lit = Math.min(1, Math.max(0, (0.8 - day) / 0.5));
      for (const g of glows) g.material.emissiveIntensity = g.strength * Math.max(night, lit * 0.8) * view.lamp;
      lights.end(seconds, lit * view.lamp, view.height, view.fov, view.fog);
      glow.set(lit * lit * view.lamp);
    },
    stats: { meshes, triangles: Math.round(triangles) },
  };
}
