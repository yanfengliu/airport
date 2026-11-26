// Shared pieces of the static world: the palette, the stacking order of things painted on the
// ground, and the materials they use.

import * as THREE from 'three';
import { MeshBuilder, rgb } from '../builder.ts';
import { detailTexture } from '../textures.ts';

export const PALETTE = {
  water: rgb(0x2f5d74),
  land: rgb(0x7f8466),
  airportGrass: rgb(0x8c8a63),
  grass: rgb(0x7c8f5a),
  park: rgb(0x6d9358),
  wetland: rgb(0x61775f),
  scrub: rgb(0x77805c),
  sand: rgb(0xb5a682),
  residential: rgb(0x8d8b7e),
  industrial: rgb(0x8a8b89),
  parking: rgb(0x6c6e72),
  apron: rgb(0xa9a8a1),
  taxiway: rgb(0x77797c),
  taxiShoulder: rgb(0x6b6d70),
  runway: rgb(0x4b4d51),
  runwayShoulder: rgb(0x6a6c6f),
  blastPad: rgb(0x4d4b46),
  paintWhite: rgb(0xe6e6e0),
  paintYellow: rgb(0xe3b93a),
  asphalt: rgb(0x5c5f64),
  roadCasing: rgb(0x8e8f8a),
  concrete: rgb(0xb4b2ab),
};

/** Stacking order of flat things on the ground, lowest first. */
export const ORDER = {
  surface: 1,
  apron: 2,
  taxiShoulder: 3,
  taxiway: 4,
  runwayShoulder: 5,
  runway: 6,
  roadCasing: 7,
  road: 8,
  junction: 9,
  paint: 10,
  paintText: 11,
} as const;

let grain: THREE.Texture | null = null;
let slabs: THREE.Texture | null = null;

export function grainTexture(): THREE.Texture {
  grain ??= detailTexture(11, 0.2);
  return grain;
}

export function slabTexture(): THREE.Texture {
  slabs ??= detailTexture(23, 0.14, 4);
  return slabs;
}

/**
 * Material for something painted flat on the ground. Decals are drawn after everything solid, in
 * ORDER, without writing depth, and pulled slightly towards the camera, so layers that share the
 * ground plane neither fight each other nor show through buildings and aircraft.
 */
export function decalMaterial(options: { map?: THREE.Texture | null; lit?: boolean; transparent?: boolean; colour?: number } = {}): THREE.Material {
  const common = {
    vertexColors: true,
    map: options.map ?? null,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
    transparent: options.transparent ?? false,
    color: options.colour ?? 0xffffff,
  };
  return options.lit === false ? new THREE.MeshBasicMaterial(common) : new THREE.MeshLambertMaterial(common);
}

export function decalMesh(builder: MeshBuilder, order: number, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(builder.build(), material);
  mesh.name = name;
  mesh.renderOrder = order;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function solidMesh(builder: MeshBuilder, material: THREE.Material, name: string, shadows = true): THREE.Mesh {
  const mesh = new THREE.Mesh(builder.build(), material);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
