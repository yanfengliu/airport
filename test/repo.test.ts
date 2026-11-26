// Repository rules that a script can hold: file size limits on what is tracked, and the boundary
// that keeps the simulation runnable without a browser. Bound: reads the tracked file list and
// import statements; it does not follow dynamic imports.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/layout.ts';

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|woff2?|ttf|otf|mp4|webm|wasm|glb|bin)$/i;

describe('tracked files', () => {
  it('stay under 1 MiB, and binaries under 512 KiB', () => {
    const over: string[] = [];
    for (const file of tracked) {
      const size = statSync(join(repoRoot, file)).size;
      const limit = BINARY.test(file) ? 512 * 1024 : 1024 * 1024;
      if (size > limit) over.push(`${file}: ${(size / 1024).toFixed(0)} KiB`);
    }
    expect(over).toEqual([]);
  });

  it('do not include task output', () => {
    expect(tracked.filter((f) => f.startsWith('artifacts/') || f.startsWith('dist/') || f.startsWith('node_modules/'))).toEqual([]);
  });
});

describe('simulation boundary', () => {
  const sources = tracked.filter((f) => /^src\/(sim|shared)\/.*\.ts$/.test(f));

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('imports neither three.js nor the renderer, and touches no browser globals', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/from\s+['"]three/.test(code)) offenders.push(`${file}: imports three`);
      if (/from\s+['"][^'"]*\/(render|ui|app)\//.test(code)) offenders.push(`${file}: imports from render, ui or app`);
      if (/\b(document|window|navigator|requestAnimationFrame|performance)\s*[.(]/.test(code)) offenders.push(`${file}: uses a browser global`);
      if (/\bMath\.random\s*\(/.test(code)) offenders.push(`${file}: uses Math.random`);
      if (/\bDate\.now\s*\(|\bnew Date\s*\(/.test(code)) offenders.push(`${file}: reads the wall clock`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses only erasable TypeScript with explicit .ts imports', () => {
    const offenders: string[] = [];
    for (const file of tracked.filter((f) => /^(src|tools|test)\/.*\.ts$/.test(f))) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      for (const match of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        if (!/\.(ts|mjs|json|css)$/.test(match[1])) offenders.push(`${file}: import of ${match[1]} has no extension`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
