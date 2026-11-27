// The compact form the app loads its models in (src/render/models/library.ts reads it), written for
// Polyfork's models converted by tools/models/polyfork.ts and for our own made by
// tools/models/original/. One binary per model:
//
//   positions  int16 x, y, z per vertex, across the box of the model (index.json `box`)
//   slots      uint8 per vertex: its colour slot (index.json `palette`, three linear RGB each)
//   bones      uint8 per vertex, for a model with parts that move: the part it follows
//   (padding to four bytes)
//   triangles  uint16 per corner (uint32 past 65,535 vertices)
//   (padding to four bytes)
//   poses      float32, for a model with parts that move: per pose, per part, the three rows of the
//              3x4 matrix that takes a vertex from where it is made to where the pose puts it
//
// The model's frame: +z its front, +x its left, +y up, metres, its origin on the ground.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CompactMesh {
  /** x, y, z per vertex. */
  positions: readonly number[];
  /** Colour slot per vertex. */
  slots: readonly number[];
  /** For a model with parts that move: the part each vertex follows. */
  bones?: readonly number[];
  /** Three vertex indices per triangle. */
  triangles: readonly number[];
  /** For a model with parts that move: twelve numbers per part per pose. */
  matrices?: readonly number[];
}

/** Write a model's binary as `<id>.bin` in `dir`; what index.json needs to read it back. */
export function writeModel(dir: string, id: string, mesh: CompactMesh): { file: string; vertices: number; triangles: number; box: number[]; bytes: number } {
  const count = mesh.positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], mesh.positions[i * 3 + k]);
      max[k] = Math.max(max[k], mesh.positions[i * 3 + k]);
    }
  }
  const span = max.map((v, k) => Math.max(v - min[k], 1e-6));
  const wide = count > 65535;
  const parts: Buffer[] = [];
  const q = Buffer.alloc(count * 6);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) q.writeInt16LE(Math.round(((mesh.positions[i * 3 + k] - min[k]) / span[k]) * 65535 - 32768), i * 6 + k * 2);
  }
  parts.push(q);
  parts.push(Buffer.from(mesh.slots));
  if (mesh.bones) parts.push(Buffer.from(mesh.bones));
  const pad = (b: Buffer[]): void => {
    const length = b.reduce((n, x) => n + x.length, 0);
    if (length % 4) b.push(Buffer.alloc(4 - (length % 4)));
  };
  pad(parts);
  const idx = Buffer.alloc(mesh.triangles.length * (wide ? 4 : 2));
  mesh.triangles.forEach((v, i) => (wide ? idx.writeUInt32LE(v, i * 4) : idx.writeUInt16LE(v, i * 2)));
  parts.push(idx);
  pad(parts);
  if (mesh.matrices?.length) parts.push(Buffer.from(Float32Array.from(mesh.matrices).buffer));
  const file = `${id}.bin`;
  const data = Buffer.concat(parts);
  writeFileSync(join(dir, file), data);
  return { file, vertices: count, triangles: mesh.triangles.length / 3, box: [...min, ...span], bytes: data.length };
}
