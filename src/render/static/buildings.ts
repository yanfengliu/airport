// Buildings around the airport: hangars, cargo sheds, garages, hotels, offices and the houses of
// San Bruno and Millbrae.

import * as THREE from 'three';
import type { Building, BuildingKind, Buildings } from '../../shared/layout.ts';
import { MeshBuilder, box, fillPolygon, rgb, shade, wallPolygon, type RGB } from '../builder.ts';
import type { FacadeTextures } from '../textures.ts';
import { solidMesh } from './common.ts';

/** A material whose emissive channel is switched on at night, and how bright it gets. */
export interface NightGlow {
  /** A material whose emissive glow is turned up at night. */
  material: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
  strength: number;
}

const WALLS: Record<BuildingKind, RGB[]> = {
  house: [0xd9cdb8, 0xc9b9a0, 0xe3d9c8, 0xb9a88f, 0xcfc4b0, 0xd6c2a8, 0xc4c7c2].map(rgb),
  generic: [0xc8c4bb, 0xb9b6ae, 0xd3cfc6, 0xbfc3c6].map(rgb),
  office: [0xcfd3d6, 0xbfc5ca, 0xd9d4c8, 0xb8c0c6].map(rgb),
  hotel: [0xd8d2c4, 0xcdd2d6, 0xc9c0ae].map(rgb),
  industrial: [0xbfc2c4, 0xc9c6bd, 0xaeb4b8, 0xd4d1c9].map(rgb),
  cargo: [0xc5c9cc, 0xd2d0c8, 0xb4bbc0].map(rgb),
  hangar: [0xb7bec6, 0xc4c9ce].map(rgb),
  garage: [0xc2c0b8, 0xcbc8bf].map(rgb),
  roof: [0xd7d9db].map(rgb),
  tank: [0xe4e4e0, 0xd9dad6].map(rgb),
  tower: [0xe2e2de].map(rgb),
};

const ROOFS: Record<BuildingKind, RGB[]> = {
  house: [0x6b5a4e, 0x5a5550, 0x7a6657, 0x4f4a48, 0x8a7460, 0x63666a].map(rgb),
  generic: [0x9a9892, 0x8d8f90, 0xa9a59c].map(rgb),
  office: [0x8f9296, 0x9c9d99, 0x85898d].map(rgb),
  hotel: [0x8f9296, 0x9a958b].map(rgb),
  industrial: [0xa8aaac, 0xb9b9b4, 0x9fa3a6, 0xc4c4be].map(rgb),
  cargo: [0xb3b6b8, 0xc2c2bc, 0xa5aaae].map(rgb),
  hangar: [0xc9ced3, 0xbcc2c8].map(rgb),
  garage: [0x6c6e72, 0x74767a].map(rgb),
  roof: [0xe0e2e3].map(rgb),
  tank: [0xeeeeea].map(rgb),
  tower: [0xcfcfca].map(rgb),
};

/** A repeatable number in [0, 1) from a position, so a building keeps its colour between runs. */
function hash(x: number, y: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

const pick = <T,>(list: readonly T[], h: number): T => list[Math.min(list.length - 1, Math.floor(h * list.length))];

function gableHouse(walls: MeshBuilder, roofs: MeshBuilder, x: number, y: number, hl: number, hw: number, rot: number, height: number, wall: RGB, roof: RGB): void {
  const rise = Math.min(2.4, hw * 0.75);
  const eave = Math.max(2.2, height - rise);
  const top = eave + rise;
  box(walls, x, y, 0, eave, hl, hw, rot, wall, wall);
  const ux = Math.cos(rot);
  const uy = Math.sin(rot);
  const nx = -uy;
  const ny = ux;
  const over = 0.35;
  const at = (u: number, v: number): [number, number] => [x + ux * u + nx * v, y + uy * u + ny * v];
  const L = hl + over;
  const W = hw + over;
  const run = Math.hypot(rise, W);
  // The two slopes: normals lean outwards from the ridge.
  for (const side of [1, -1]) {
    const mx = (nx * side * rise) / run;
    const my = (ny * side * rise) / run;
    const mz = W / run;
    const [ax, ay] = at(L, W * side);
    const [bx, by] = at(-L, W * side);
    const [r1x, r1y] = at(L, 0);
    const [r2x, r2y] = at(-L, 0);
    const a = roofs.vertex(ax, ay, eave, mx, my, mz, roof);
    const b = roofs.vertex(bx, by, eave, mx, my, mz, roof);
    const r2 = roofs.vertex(r2x, r2y, top, mx, my, mz, roof);
    const r1 = roofs.vertex(r1x, r1y, top, mx, my, mz, roof);
    if (side === 1) roofs.quad(a, b, r2, r1);
    else roofs.quad(r1, r2, b, a);
  }
  // Gable ends.
  for (const end of [1, -1]) {
    const [lx, ly] = at(hl * end, hw);
    const [rx, ry] = at(hl * end, -hw);
    const [px, py] = at(hl * end, 0);
    const l = walls.vertex(lx, ly, eave, ux * end, uy * end, 0, wall);
    const r = walls.vertex(rx, ry, eave, ux * end, uy * end, 0, wall);
    const p = walls.vertex(px, py, top, ux * end, uy * end, 0, wall);
    if (end === 1) walls.tri(r, l, p);
    else walls.tri(l, r, p);
  }
}

/**
 * The mapped buildings, but those `skip` says not to; and the houses, drawn as boxes, unless
 * `houses` is false, as when building only the parts of a terminal's roof.
 */
export function buildBuildings(data: Buildings, facades: FacadeTextures, skip: (b: Building) => boolean = () => false, houses = true): { group: THREE.Group; glows: NightGlow[] } {
  const group = new THREE.Group();
  group.name = 'buildings';
  const plain = new MeshBuilder();
  const windowed = new MeshBuilder();
  const decks = new MeshBuilder();
  const roofs = new MeshBuilder();

  for (const b of data.buildings) {
    if (skip(b)) continue;
    const h = hash(b.poly.outer[0], b.poly.outer[1]);
    const wall = pick(WALLS[b.kind], h);
    const roof = pick(ROOFS[b.kind], (h * 7.31) % 1);
    const base = b.minHeight ?? 0;
    if (b.kind === 'roof') {
      // A canopy: a thin slab at its height.
      wallPolygon(plain, b.poly, Math.max(base, b.height - 0.5), b.height, wall);
      fillPolygon(roofs, b.poly, b.height, roof);
      continue;
    }
    const target = b.kind === 'garage' ? decks : b.kind === 'office' || b.kind === 'hotel' || (b.kind === 'generic' && b.height > 9) ? windowed : plain;
    wallPolygon(target, b.poly, base, b.height, wall, 1);
    fillPolygon(roofs, b.poly, b.height, roof);
    if (b.kind !== 'tank' && b.kind !== 'house') {
      // A low parapet stops large flat roofs reading as paper.
      wallPolygon(plain, b.poly, b.height, b.height + 0.6, shade(wall, 0.92));
    }
  }

  for (let i = 0; houses && i < data.boxes.length; i += 6) {
    const x = data.boxes[i];
    const y = data.boxes[i + 1];
    const hl = data.boxes[i + 2];
    const hw = data.boxes[i + 3];
    const rot = data.boxes[i + 4];
    const height = data.boxes[i + 5];
    const h = hash(x, y);
    const wall = pick(WALLS.house, h);
    const roof = pick(ROOFS.house, (h * 5.17) % 1);
    // The ridge runs along the longer side.
    if (hl >= hw) gableHouse(plain, roofs, x, y, hl, hw, rot, height, wall, roof);
    else gableHouse(plain, roofs, x, y, hw, hl, rot + Math.PI / 2, height, wall, roof);
  }

  const plainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  const roofMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const windowMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: facades.windows,
    emissiveMap: facades.windowsLit,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.6,
    metalness: 0.05,
  });
  const deckMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: facades.decks,
    emissiveMap: facades.decksLit,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.9,
    metalness: 0,
  });
  group.add(solidMesh(plain, plainMaterial, 'building-walls'));
  group.add(solidMesh(windowed, windowMaterial, 'building-windows'));
  group.add(solidMesh(decks, deckMaterial, 'building-decks'));
  group.add(solidMesh(roofs, roofMaterial, 'building-roofs'));
  return { group, glows: [{ material: windowMaterial, strength: 1.1 }, { material: deckMaterial, strength: 0.7 }] };
}
