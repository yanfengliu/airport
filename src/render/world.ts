// The static world: everything that does not move, built once from the layout.

import * as THREE from 'three';
import type { Building, Layout } from '../shared/layout.ts';
import { Lights } from './lights.ts';
import type { Models } from './models/library.ts';
import { airfieldFurniture, buildAirfieldProps } from './static/airfield-props.ts';
import { buildAirfieldGround } from './static/airfield.ts';
import { buildBridges, type BridgeEnd } from './static/bridges.ts';
import { buildBuildings, type NightGlow } from './static/buildings.ts';
import { buildGroundGlow } from './static/glow.ts';
import { buildKitBuildings, kitBuildings } from './static/kit-buildings.ts';
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
  /** The ends of the jet bridges that reach out to the aircraft, drawn as they move. */
  bridgeEnds: BridgeEnd[];
  /** Fixed lights, and the moving ones other layers add each frame between `begin` and `end`. */
  lights: Lights;
  /** Advance animated parts: `seconds` of running time, `day` from 0 (night) to 1. */
  update(seconds: number, day: number, view: FrameView): void;
  stats: { meshes: number; triangles: number };
}

/**
 * Which mapped buildings are drawn, but for those `replaced` by the kit's: those that stand on their own, and the parts of a terminal
 * mapped as buildings of their own, from the terminal's roof up. Those parts come off with its roof
 * in the cut-away view; below the roof they are inside its walls, where their own walls would lie
 * on the glass and flicker against it. The tower's mapped shaft and cab, which stand on a terminal's
 * roof, are neither: the tower is our model of it (src/render/static/landmarks.ts).
 */
export function mappedBuildings(layout: Layout, replaced: ReadonlySet<Building> = new Set()): { own: Building[]; aboveRoofs: Building[] } {
  const [towerX, towerY] = layout.airfield.tower;
  const mappedTower = (b: Building): boolean => b.height > 40 && Math.hypot(b.poly.outer[0] - towerX, b.poly.outer[1] - towerY) < 40;
  const terminalOf = (outer: number[]): { height: number } | null => {
    for (const t of layout.terminals.buildings) {
      const ring = t.poly.outer;
      let within = 0;
      for (let i = 0; i < outer.length; i += 2) if (insideOrOn(ring, outer[i], outer[i + 1], 1)) within += 1;
      if (within >= 0.8 * (outer.length / 2)) return t;
    }
    return null;
  };
  const own: Building[] = [];
  const aboveRoofs: Building[] = [];
  for (const b of layout.buildings.buildings) {
    if (mappedTower(b) || replaced.has(b)) continue;
    const terminal = terminalOf(b.poly.outer);
    if (!terminal) own.push(b);
    else if (b.height > terminal.height + 0.3) aboveRoofs.push({ ...b, minHeight: Math.max(b.minHeight ?? 0, terminal.height) });
  }
  return { own, aboveRoofs };
}

/** `models`: the library's models, for what is drawn with them; without them it is drawn plainly. */
export function buildStaticWorld(layout: Layout, models: Models = new Map()): StaticWorld {
  const group = new THREE.Group();
  group.name = 'static-world';
  const facades = facadeTextures();
  const glows: NightGlow[] = [];

  const ground = buildGround(layout.land);
  group.add(ground.group);
  group.add(buildAirfieldGround(layout.airfield));
  group.add(buildRoads(layout.roads));
  group.add(buildRail(layout.rail));
  // The airfield's furniture, drawn with the models: the gates' floodlights are on its masts.
  const furniture = models.size ? airfieldFurniture(layout) : null;
  if (furniture) group.add(buildAirfieldProps(furniture, models));

  const [towerX, towerY] = layout.airfield.tower;
  // The kit's buildings where the map has one of their kind of near their shape, in place of it.
  const kit = models.size ? kitBuildings(layout, new Map([...models].map(([id, m]) => [id, m.info.box]))) : null;
  if (kit) group.add(buildKitBuildings(kit.placements, models));
  const drawn = mappedBuildings(layout, kit?.replaced);
  const buildings = buildBuildings({ ...layout.buildings, buildings: drawn.own }, facades);
  group.add(buildings.group);
  glows.push(...buildings.glows);

  const terminals = buildTerminalShells(layout.terminals, facades);
  // The parts of the terminals above their roofs only: the houses are in the buildings above already.
  const roofParts = buildBuildings({ buildings: drawn.aboveRoofs, boxes: [] }, facades, () => false, false);
  terminals.shell.add(roofParts.group);
  // The bridges stay when the roofs come off for the cut-away view.
  const bridges = buildBridges(layout.airfield, models);
  group.add(terminals.shell, bridges.group);
  glows.push(...terminals.glows, ...roofParts.glows);

  const tower = buildTower(towerX, towerY, models);
  group.add(tower.group);
  glows.push({ material: tower.glass, strength: 0.5 });

  const lights = new Lights(layout.airfield, layout.roads, layout.land, undefined, furniture?.floodlights ?? null);
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
    bridgeEnds: bridges.ends,
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

/** Whether (x, y) is inside a flat ring of x, y pairs, or within `tolerance` metres of its edge. */
function insideOrOn(ring: readonly number[], x: number, y: number, tolerance: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const [ax, ay, bx, by] = [ring[j], ring[j + 1], ring[i], ring[i + 1]];
    if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(ax + dx * t - x, ay + dy * t - y) <= tolerance) return true;
  }
  return inside;
}
