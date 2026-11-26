// The ground: the bay, the land with its shore, ground cover, and the approach-light piers.

import * as THREE from 'three';
import type { Land, SurfaceKind } from '../../shared/layout.ts';
import { MeshBuilder, box, fillPolygon, ribbon, rgb, wallPolygon, type RGB } from '../builder.ts';
import { waterNormals } from '../textures.ts';
import { ORDER, PALETTE, decalMaterial, decalMesh, grainTexture, solidMesh } from './common.ts';

const WATER_LEVEL = -1.4;
const TILE = 1 / 40;

const SURFACE_COLOUR: Record<SurfaceKind, RGB> = {
  airfield: PALETTE.airportGrass,
  grass: PALETTE.grass,
  park: PALETTE.park,
  wood: rgb(0x4f7347),
  wetland: PALETTE.wetland,
  scrub: PALETTE.scrub,
  water: PALETTE.water,
  parking: PALETTE.parking,
  residential: PALETTE.residential,
  commercial: rgb(0x8f8d86),
  industrial: PALETTE.industrial,
  rock: rgb(0x8d8674),
};

export interface Ground {
  group: THREE.Group;
  /** Call each frame with elapsed seconds to drift the ripples on the bay. */
  animate(seconds: number): void;
}

export function buildGround(land: Land): Ground {
  const group = new THREE.Group();
  group.name = 'ground';

  // ---- the bay --------------------------------------------------------------------------
  const ripples = waterNormals();
  ripples.repeat.set(700, 700);
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a5568,
    roughness: 0.16,
    metalness: 0.02,
    normalMap: ripples,
    normalScale: new THREE.Vector2(0.55, 0.55),
    envMapIntensity: 1.25,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 8,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(90_000, 90_000), waterMaterial);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.receiveShadow = true;
  water.name = 'bay';
  group.add(water);

  // ---- dry land, with a rock edge down to the water ---------------------------------------
  const solid = new MeshBuilder();
  const rock = SURFACE_COLOUR.rock;
  for (const p of land.land) {
    fillPolygon(solid, p, 0, PALETTE.land, TILE);
    wallPolygon(solid, p, WATER_LEVEL - 0.4, 0, rock);
  }
  for (const s of land.surfaces) {
    if (s.kind !== 'rock') continue;
    fillPolygon(solid, s.poly, 0.7, rock, TILE);
    wallPolygon(solid, s.poly, WATER_LEVEL - 0.4, 0.7, rock);
  }
  const landMesh = solidMesh(solid, new THREE.MeshLambertMaterial({ vertexColors: true, map: grainTexture() }), 'land', false);
  group.add(landMesh);

  // ---- ground cover, largest patches first so smaller ones draw over them -----------------
  const cover = new MeshBuilder();
  for (const s of land.surfaces) {
    if (s.kind === 'rock') continue;
    fillPolygon(cover, s.poly, 0, SURFACE_COLOUR[s.kind], TILE);
  }
  for (const w of land.waterways) ribbon(cover, w.pts, 2, w.width, PALETTE.water);
  group.add(decalMesh(cover, ORDER.surface, decalMaterial({ map: grainTexture() }), 'ground-cover'));

  // ---- approach-light piers ---------------------------------------------------------------
  const pier = new MeshBuilder();
  const timber = rgb(0x8a8273);
  for (const line of land.piers) {
    const deck: number[] = [];
    for (let i = 0; i < line.length; i += 2) deck.push(line[i], line[i + 1], 2.6);
    ribbon(pier, deck, 3, 2.4, timber);
    let carried = 0;
    for (let i = 2; i < line.length; i += 2) {
      const x0 = line[i - 2];
      const y0 = line[i - 1];
      const x1 = line[i];
      const y1 = line[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const heading = Math.atan2(y1 - y0, x1 - x0);
      for (let s = 18 - carried; s <= len; s += 18) {
        const t = s / len;
        box(pier, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, WATER_LEVEL - 1, 2.6, 0.25, 1.1, heading, timber, timber);
      }
      carried = (carried + len) % 18;
    }
  }
  group.add(solidMesh(pier, new THREE.MeshLambertMaterial({ vertexColors: true }), 'light-piers'));

  return {
    group,
    animate(seconds: number): void {
      ripples.offset.set(seconds * 0.012, seconds * 0.007);
    },
  };
}
