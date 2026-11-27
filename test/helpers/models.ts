// Read the converted models from disk as the app decodes them, for tests: no GPU needed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, type ModelInfo, type Models } from '../../src/render/models/library.ts';
import { repoRoot } from './layout.ts';

/** The models with these ids (all of them without), from public/models. */
export function loadModelsFromDisk(ids?: readonly string[]): Models {
  const dir = join(repoRoot, 'public', 'models');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { models: ModelInfo[] };
  const wanted = ids ? index.models.filter((m) => ids.includes(m.id)) : index.models;
  return new Map(
    wanted.map((info) => {
      const file = readFileSync(join(dir, info.file));
      return [info.id, decode(info, file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))] as const;
    }),
  );
}
