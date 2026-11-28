// Browser half of export-international-roof.mjs. Use the production shell builder and textures.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildTerminalShells } from '../../src/render/static/terminals.ts';
import { facadeTextures } from '../../src/render/textures.ts';
import { mappedBuildings } from '../../src/render/world.ts';

function meshes(root) {
  const entries = new Map();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (!o.name || entries.has(o.name)) throw new Error('Each part needs its own name: ' + o.name);
    entries.set(o.name, o);
  });
  return entries;
}

function matches(a, b, tolerance, label) {
  if (a.length !== b.length) throw new Error(label + ' length differs');
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(b[i]) || Math.abs(a[i] - b[i]) > tolerance) throw new Error(label + ' differs at ' + i);
  }
}

function verifyRoundTrip(source, loaded) {
  const original = meshes(source);
  const copy = meshes(loaded);
  if (original.size !== copy.size) throw new Error('Mesh count differs');
  source.updateMatrixWorld(true);
  loaded.updateMatrixWorld(true);
  let instances = 0;
  for (const [name, mesh] of original) {
    const back = copy.get(name);
    if (!back) throw new Error('Missing mesh ' + name);
    for (const attribute of ['position', 'normal', 'color', 'uv']) {
      const a = mesh.geometry.getAttribute(attribute);
      if (a) matches(a.array, back.geometry.getAttribute(attribute).array, 1e-5, name + ' ' + attribute);
    }
    matches(mesh.geometry.index.array, back.geometry.index.array, 0, name + ' triangles');
    matches(mesh.matrixWorld.elements, back.matrixWorld.elements, 1e-4, name + ' placement');
    if (mesh.isInstancedMesh) {
      if (!back.isInstancedMesh || back.count !== mesh.count) throw new Error('Lost steel instances');
      matches(mesh.instanceMatrix.array, back.instanceMatrix.array, 1e-4, name + ' beams');
      instances += back.count;
    }
  }
  return { meshes: original.size, steelMembers: instances };
}

export async function roofDataset(existing) {
  const read = kind => fetch('/data/' + kind + '.json').then(r => r.json());
  const [terminals, buildings, airfield] = await Promise.all(['terminals', 'buildings', 'airfield'].map(read));
  const { mainHallParts } = mappedBuildings({ terminals, buildings, airfield });
  const { shell } = buildTerminalShells(terminals, facadeTextures(), mainHallParts);
  const hall = shell.getObjectByName('international-departures-hall');
  hall.removeFromParent();
  hall.position.set(0, 0, 0);
  hall.rotation.set(0, 0, 0);
  const bounds = new THREE.Box3().setFromObject(hall);
  hall.position.y = -bounds.min.y;
  hall.updateMatrixWorld(true);
  const size = bounds.getSize(new THREE.Vector3());
  const dimensionsMetres = { width: size.x, height: size.y, depth: size.z };
  const bytes = existing ? Uint8Array.fromBase64(existing) : new Uint8Array(await new GLTFExporter().parseAsync(hall, { binary: true }));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const counts = verifyRoundTrip(hall, gltf.scene);
  return { ...counts, dimensionsMetres, data: existing ? null : bytes.toBase64() };
}
