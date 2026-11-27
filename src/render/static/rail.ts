// Rail: the AirTrain guideway, BART's aerial structure and the Caltrain corridor.

import * as THREE from 'three';
import type { Rail, RailLine, RailStation } from '../../shared/layout.ts';
import { MeshBuilder, box, ribbon, rgb, type RGB } from '../builder.ts';
import { ORDER, PALETTE, decalMaterial, decalMesh, solidMesh } from './common.ts';
import { deck, piers } from './structures.ts';

const WIDTH: Record<RailLine['kind'], number> = { airtrain: 3.1, bart: 4, caltrain: 4.4 };
const ELEVATED_FROM = 0.6;
const BURIED_BELOW = -0.4;
/** A tunnel mouth's headwall, metres above the ground, and the dark of the tunnel in it. */
const PORTAL_HEIGHT = 5.4;
const TUNNEL_DARK = rgb(0x1b1d20);

/** Where a run of track goes into the ground: the tunnel's mouth, and the way into it. */
export interface Portal {
  x: number;
  y: number;
  ux: number;
  uy: number;
}

/**
 * Split a line into the runs that are above ground, dropping what is in tunnel. A run ends where
 * the track goes into the ground, between its points if need be, so that a viaduct comes down to
 * its tunnel mouth rather than stopping in the air at its last point above ground; and each such
 * end is a tunnel's mouth.
 */
export function visibleRuns(pts: readonly number[]): { pts: number[]; portals: Portal[] }[] {
  const runs: { pts: number[]; portals: Portal[] }[] = [];
  let current: number[] = [];
  let portals: Portal[] = [];
  /** Where the track between points `a` and `b` (indices) is at the ground, facing from `a` to `b`. */
  const portal = (a: number, b: number, into: number): Portal => {
    const t = (BURIED_BELOW - pts[a + 2]) / (pts[b + 2] - pts[a + 2]);
    const length = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]) || 1;
    return { x: pts[a] + (pts[b] - pts[a]) * t, y: pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t, ux: (into * (pts[b] - pts[a])) / length, uy: (into * (pts[b + 1] - pts[a + 1])) / length };
  };
  for (let i = 0; i < pts.length; i += 3) {
    const buried = pts[i + 2] < BURIED_BELOW;
    const before = i >= 3 ? pts[i - 1] < BURIED_BELOW : buried;
    if (buried) {
      if (!before && current.length) {
        const p = portal(i - 3, i, 1);
        const n = current.length;
        if (Math.hypot(p.x - current[n - 3], p.y - current[n - 2]) > 0.01) current.push(p.x, p.y, BURIED_BELOW);
        portals.push(p);
      }
      if (current.length >= 6) runs.push({ pts: current, portals });
      current = [];
      portals = [];
    } else {
      if (before && i >= 3) {
        const p = portal(i - 3, i, -1);
        if (Math.hypot(p.x - pts[i], p.y - pts[i + 1]) > 0.01) current.push(p.x, p.y, BURIED_BELOW);
        portals.push(p);
      }
      current.push(pts[i], pts[i + 1], pts[i + 2]);
    }
  }
  if (current.length >= 6) runs.push({ pts: current, portals });
  return runs;
}

/**
 * A tunnel's mouth where track goes into the ground: a concrete headwall across it with the dark
 * of the tunnel in it, and wing walls either side of the track coming down to it.
 */
function portalAt(builder: MeshBuilder, p: Portal, width: number, concrete: RGB): void {
  const heading = Math.atan2(p.uy, p.ux);
  const [nx, ny] = [-p.uy, p.ux];
  box(builder, p.x + p.ux * 0.7, p.y + p.uy * 0.7, BURIED_BELOW, PORTAL_HEIGHT, 0.6, width / 2 + 1.8, heading, concrete, concrete);
  box(builder, p.x + p.ux * 0.06, p.y + p.uy * 0.06, BURIED_BELOW, PORTAL_HEIGHT - 1.1, 0.03, width / 2 + 0.3, heading, TUNNEL_DARK, TUNNEL_DARK);
  for (const side of [-1, 1]) {
    const across = side * (width / 2 + 1.2);
    box(builder, p.x - p.ux * 3.5 + nx * across, p.y - p.uy * 3.5 + ny * across, BURIED_BELOW, 1.6, 3.5, 0.3, heading, concrete, concrete);
  }
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
    for (const { pts: run, portals } of visibleRuns(line.pts)) {
      for (const p of portals) portalAt(structure, p, width, concrete);
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
