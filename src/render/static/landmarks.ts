// One-off structures that a footprint cannot describe: the control tower.

import * as THREE from 'three';

/** SFO's torch-shaped control tower, 67 m to the tip, at a map position. */
export function buildTower(x: number, y: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'control-tower';
  const profile = (points: [number, number][]): THREE.Vector2[] => points.map(([r, h]) => new THREE.Vector2(r, h));
  const concrete = new THREE.MeshStandardMaterial({ color: 0xe8e9e6, roughness: 0.75, metalness: 0.02 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x2f4a55, roughness: 0.12, metalness: 0.6, envMapIntensity: 1.4, emissive: 0x9fd0c8, emissiveIntensity: 0 });

  const shaft = new THREE.Mesh(
    new THREE.LatheGeometry(profile([[0, 0], [5.4, 0], [4.7, 6], [3.3, 15], [2.9, 40], [3.5, 46], [5.6, 51], [8, 54.2], [8.5, 55]]), 32),
    concrete,
  );
  const cab = new THREE.Mesh(new THREE.LatheGeometry(profile([[8.5, 55], [9.1, 58.8]]), 32), glass);
  const roof = new THREE.Mesh(new THREE.LatheGeometry(profile([[9.1, 58.8], [9.6, 59.1], [9.3, 59.7], [6.5, 61.2], [1.6, 62.4], [0.35, 63], [0.3, 67], [0, 67]]), 32), concrete);
  // Lathes are built with the outside facing out only when the profile climbs; draw both faces.
  for (const mesh of [shaft, cab, roof]) {
    (mesh.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.position.set(x, 0, -y);
  group.userData.cabGlass = glass;
  return group;
}
