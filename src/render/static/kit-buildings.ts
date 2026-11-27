// Buildings from Polyfork's airport kit where the map has a building of their kind whose footprint
// is near enough their shape: a hangar, a cargo shed, a multi-storey car park or a fuel tank,
// fitted to the footprint's box and the mapped height. A footprint much larger than the model is
// laid with copies of it, so that doors and decks keep their proportions: a hangar along its length,
// each keeping the hangar's shape (a big hangar is one building); a cargo building as a row of bays
// along its length, each a shed's width and the building's depth, under one run of roof; a car park
// in modules both ways, its decks on top. Their fronts face the airfield, or for a car park the
// road. A footprint far from a rectangle (a tank, from a circle) is left as mapped.

import * as THREE from 'three';
import type { Building, Layout } from '../../shared/layout.ts';
import { flatMaterial, propInstances, type Models } from '../models/library.ts';

/** The kit's building for each mapped kind, how it is laid over a footprint, and what its front faces. */
export const KIT_BUILDINGS = {
  hangar: { id: 'maintenance-hangar-6fab99', lay: 'length', faces: 'taxiway' },
  cargo: { id: 'cargo-shed-bcb2a8', lay: 'bays', faces: 'taxiway' },
  garage: { id: 'multi-storey-car-park-021465', lay: 'grid', faces: 'road' },
  tank: { id: 'fuel-farm-tank-ed67f0', lay: 'one', faces: null },
} as const;
type KitKind = keyof typeof KIT_BUILDINGS;

/** How near a footprint must be to the model's shape: its area as a share of its box's, or of its circle's. */
export const RECTANGULAR = 0.85;
export const CIRCULAR = 0.8;

export interface KitPlacement {
  id: string;
  /** The building it stands in for. */
  building: Building;
  x: number;
  y: number;
  h: number;
  facing: number;
  /** Scale of the model across its front, up and front to back. */
  sx: number;
  sy: number;
  sz: number;
}

/** A model's box as converted: least x, y, z, then its size along each. */
type Box = readonly number[];

function area(o: readonly number[]): number {
  let a = 0;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) a += o[j] * o[i + 1] - o[i] * o[j + 1];
  return Math.abs(a / 2);
}

/** The smallest box round a footprint: its middle, its long side's direction, length and width. */
export function footprintBox(o: readonly number[]): { x: number; y: number; angle: number; length: number; width: number } {
  let best = { x: 0, y: 0, angle: 0, length: 0, width: 0, area: Infinity };
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) {
    const angle = Math.atan2(o[i + 1] - o[j + 1], o[i] - o[j]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let k = 0; k < o.length; k += 2) {
      const u = o[k] * c + o[k + 1] * s;
      const v = -o[k] * s + o[k + 1] * c;
      [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
    }
    const a = (u1 - u0) * (v1 - v0);
    if (a >= best.area) continue;
    const [mu, mv] = [(u0 + u1) / 2, (v0 + v1) / 2];
    const long = u1 - u0 >= v1 - v0;
    best = { x: mu * c - mv * s, y: mu * s + mv * c, angle: long ? angle : angle + Math.PI / 2, length: Math.max(u1 - u0, v1 - v0), width: Math.min(u1 - u0, v1 - v0), area: a };
  }
  return best;
}

/**
 * Where each of the kit's buildings stands in for a mapped one, given each model's box, and which
 * mapped buildings they replace.
 */
export function kitBuildings(layout: Pick<Layout, 'buildings' | 'airfield' | 'roads'>, boxes: ReadonlyMap<string, Box>): { placements: KitPlacement[]; replaced: Set<Building> } {
  // The way from a point to the nearest taxiway, or road, as a direction.
  const towards = (x: number, y: number, what: 'taxiway' | 'road'): number | null => {
    let best = Infinity;
    let way: number | null = null;
    const visit = (ax: number, ay: number, bx: number, by: number): void => {
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const [px, py] = [ax + dx * t, ay + dy * t];
      const d = Math.hypot(px - x, py - y);
      if (d < best) [best, way] = [d, Math.atan2(py - y, px - x)];
    };
    if (what === 'taxiway') {
      for (const e of layout.airfield.edges) if (e.kind !== 'rwy') for (let i = 2; i < e.pts.length; i += 2) visit(e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]);
    } else {
      for (const e of layout.roads.edges) for (let i = 3; i < e.pts.length; i += 3) visit(e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]);
    }
    return way;
  };
  const placements: KitPlacement[] = [];
  const replaced = new Set<Building>();
  for (const b of layout.buildings.buildings) {
    if (!(b.kind in KIT_BUILDINGS) || (b.minHeight ?? 0) > 0) continue;
    const kit = KIT_BUILDINGS[b.kind as KitKind];
    const box = boxes.get(kit.id);
    if (!box) continue;
    const o = b.poly.outer;
    const fit = footprintBox(o);
    const shape = kit.lay === 'one' ? area(o) / (Math.PI * (fit.length / 2) ** 2) : area(o) / (fit.length * fit.width);
    if (shape < (kit.lay === 'one' ? CIRCULAR : RECTANGULAR)) continue;
    const [mx, my, mz] = [box[3], box[4], box[5]];
    // The model's long side (its x, across its front) along the footprint's length.
    const along = kit.lay === 'grid' || kit.lay === 'bays' ? Math.max(1, Math.round(fit.length / mx)) : kit.lay === 'length' ? Math.max(1, Math.round(fit.length / fit.width / (mx / mz))) : 1;
    const across = kit.lay === 'grid' ? Math.max(1, Math.round(fit.width / mz)) : 1;
    const tileL = fit.length / along;
    const tileW = fit.width / across;
    // A tank as wide as its round footprint is across, on average.
    const [sx, sz] = kit.lay === 'one' ? [(fit.length + fit.width) / 2 / mx, (fit.length + fit.width) / 2 / mz] : [tileL / mx, tileW / mz];
    const sy = b.height > 0 ? b.height / my : 1;
    // The front faces one long side or the other: the one towards what it serves.
    const c = Math.cos(fit.angle);
    const s = Math.sin(fit.angle);
    let facing = fit.angle - Math.PI / 2;
    if (kit.faces) {
      const way = towards(fit.x, fit.y, kit.faces);
      if (way !== null && Math.cos(way - (fit.angle + Math.PI / 2)) > 0) facing = fit.angle + Math.PI / 2;
    }
    // The model's middle in its own frame, off its origin, turned as placed: model +x runs along
    // facing + 90°, +z along facing.
    const [ox, oz] = [(box[0] + mx / 2) * sx, (box[2] + mz / 2) * sz];
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    const offX = Math.cos(facing + Math.PI / 2) * ox + fx * oz;
    const offY = Math.sin(facing + Math.PI / 2) * ox + fy * oz;
    for (let i = 0; i < along; i += 1) {
      for (let j = 0; j < across; j += 1) {
        const u = (i + 0.5) * tileL - fit.length / 2;
        const v = (j + 0.5) * tileW - fit.width / 2;
        const x = fit.x + c * u - s * v;
        const y = fit.y + s * u + c * v;
        placements.push({ id: kit.id, building: b, x: x - offX, y: y - offY, h: 0, facing, sx, sy, sz });
      }
    }
    replaced.add(b);
  }
  return { placements, replaced };
}

/** The kit's buildings, drawn: one draw for each model. */
export function buildKitBuildings(placements: readonly KitPlacement[], models: Models): THREE.Group {
  const group = new THREE.Group();
  group.name = 'kit-buildings';
  const material = flatMaterial();
  for (const id of new Set(placements.map((p) => p.id))) {
    const model = models.get(id);
    if (!model) continue;
    const mesh = propInstances(model, material, placements.filter((p) => p.id === id), `kit-${id}`);
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}
