// Rail: the AirTrain guideway, BART's aerial structure and the Caltrain corridor.

import * as THREE from 'three';
import type { Rail, RailLine, RailStation } from '../../shared/layout.ts';
import { MeshBuilder, box, ribbon, rgb } from '../builder.ts';
import { ORDER, PALETTE, decalMaterial, decalMesh, solidMesh } from './common.ts';
import { deck, piers } from './structures.ts';

const WIDTH: Record<RailLine['kind'], number> = { airtrain: 3.1, bart: 4, caltrain: 4.4 };
const ELEVATED_FROM = 0.6;
const BURIED_BELOW = -0.4;

/**
 * Split a line into the runs that are above ground, dropping what is in tunnel. A run ends where
 * the track goes into the ground, between its points if need be, so that a viaduct comes down to
 * its tunnel mouth rather than stopping in the air at its last point above ground.
 */
export function visibleRuns(pts: readonly number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  /** Where the track between points `a` and `b` (indices) is at the ground. */
  const portal = (a: number, b: number): number[] => {
    const t = (BURIED_BELOW - pts[a + 2]) / (pts[b + 2] - pts[a + 2]);
    return [pts[a] + (pts[b] - pts[a]) * t, pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t, BURIED_BELOW];
  };
  for (let i = 0; i < pts.length; i += 3) {
    const buried = pts[i + 2] < BURIED_BELOW;
    const before = i >= 3 ? pts[i - 1] < BURIED_BELOW : buried;
    if (buried) {
      if (!before && current.length) current.push(...portal(i - 3, i));
      if (current.length >= 6) runs.push(current);
      current = [];
    } else {
      if (before && i >= 3) current.push(...portal(i - 3, i));
      current.push(pts[i], pts[i + 1], pts[i + 2]);
    }
  }
  if (current.length >= 6) runs.push(current);
  return runs;
}

/** Direction of the nearest piece of track of a station's own kind. */
function trackHeading(rail: Rail, station: RailStation): number {
  let best = Infinity;
  let heading = 0;
  for (const line of rail.lines) {
    if (line.kind !== station.kind) continue;
    for (let i = 3; i < line.pts.length; i += 3) {
      const mx = (line.pts[i - 3] + line.pts[i]) / 2;
      const my = (line.pts[i - 2] + line.pts[i + 1]) / 2;
      const d = Math.hypot(mx - station.x, my - station.y);
      if (d < best) {
        best = d;
        heading = Math.atan2(line.pts[i + 1] - line.pts[i - 2], line.pts[i] - line.pts[i - 3]);
      }
    }
  }
  return heading;
}

export function buildRail(rail: Rail): THREE.Group {
  const group = new THREE.Group();
  group.name = 'rail';
  const structure = new MeshBuilder();
  const running = new MeshBuilder();
  const ballast = new MeshBuilder();
  const steel = new MeshBuilder();
  const concrete = PALETTE.concrete;
  const guideway = rgb(0x55585c);
  const gravel = rgb(0x7a7468);
  const railTone = rgb(0x9da3a8);

  for (const line of rail.lines) {
    const width = WIDTH[line.kind];
    for (const run of visibleRuns(line.pts)) {
      let top = 0;
      for (let i = 2; i < run.length; i += 3) top = Math.max(top, run[i]);
      if (top > ELEVATED_FROM) {
        deck(structure, run, width, concrete, 0.55);
        piers(structure, run, width, concrete, 24);
        ribbon(running, run, 3, width, guideway, { lift: 0.1 });
      } else {
        ribbon(ballast, run, 3, width, gravel);
        ribbon(steel, run, 3, 0.16, railTone, { offset: 0.72 });
        ribbon(steel, run, 3, 0.16, railTone, { offset: -0.72 });
      }
    }
  }

  // Stations: platforms either side of the tracks under a canopy, open at the sides.
  const canopyTone = rgb(0xdfe3e6);
  const platformTone = rgb(0xb9bbb8);
  for (const s of rail.stations) {
    const heading = trackHeading(rail, s);
    const length = s.kind === 'airtrain' ? 34 : s.kind === 'bart' ? 110 : 120;
    const halfWidth = s.kind === 'airtrain' ? 9 : 11;
    const z = Math.max(0, s.z);
    const nx = -Math.sin(heading);
    const ny = Math.cos(heading);
    // The roof clears the highest track under it: a line climbing away from the platforms must not
    // come up through it.
    let under = z;
    for (const line of rail.lines) {
      if (line.kind !== s.kind) continue;
      for (let i = 0; i < line.pts.length; i += 3) {
        const dx = line.pts[i] - s.x;
        const dy = line.pts[i + 1] - s.y;
        if (Math.abs(dx * Math.cos(heading) + dy * Math.sin(heading)) <= length / 2 + 4 && Math.abs(dx * nx + dy * ny) <= halfWidth + 2) under = Math.max(under, line.pts[i + 2]);
      }
    }
    const roof = Math.max(z + 5.6, under + 5.0);
    for (const side of [1, -1]) {
      const ox = nx * side * (halfWidth - 2.2);
      const oy = ny * side * (halfWidth - 2.2);
      box(structure, s.x + ox, s.y + oy, Math.max(0, z - 1.2), z + 1.05, length / 2, 2.2, heading, platformTone, platformTone);
      if (s.kind !== 'caltrain') {
        for (const along of [-0.42, -0.14, 0.14, 0.42]) {
          box(structure, s.x + ox + Math.cos(heading) * length * along, s.y + oy + Math.sin(heading) * length * along, z + 1.05, roof, 0.22, 0.22, heading, canopyTone, canopyTone);
        }
      }
    }
    if (s.kind !== 'caltrain') box(structure, s.x, s.y, roof, roof + 0.6, length / 2 + 2, halfWidth + 1, heading, canopyTone, canopyTone);
  }

  group.add(solidMesh(structure, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }), 'rail-structures'));
  group.add(solidMesh(running, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }), 'rail-running', false));
  group.add(decalMesh(ballast, ORDER.roadCasing, decalMaterial(), 'rail-ballast'));
  group.add(decalMesh(steel, ORDER.road, decalMaterial(), 'rail-steel'));
  return group;
}
