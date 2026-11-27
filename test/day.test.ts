// The day-long road and people benchmarks, as part of the gate: a whole day of road traffic judged
// on the 'Roads flow' criterion (nobody standing ten minutes, the freeways carrying their demand,
// the curbs served), and a whole day of people judged on theirs (everyone and every bag accounted
// for, misses, mishandled bags and security waits within their limits). The airside day is in
// soak.test.ts. Bound: seed 7, from 04:00; run the tools with other seeds and starts for more.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/layout.ts';

const tool = (name: string, args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'tools', 'sim', name), ...args], { encoding: 'utf8', timeout: 420_000 });

describe('a day on the roads', () => {
  it('passes the roads benchmark on seed 7', () => {
    const run = tool('roads.ts', ['--hours', '24', '--start', '04:00', '--seed', '7', '--every', '86400']);
    expect(run.stdout + run.stderr).toMatch(/^pass:/m);
    expect(run.status).toBe(0);
  }, 480_000);
});

describe('a day of people', () => {
  it('passes the people benchmark on seed 7', () => {
    const run = tool('people.ts', ['--hours', '24', '--start', '04:00', '--seed', '7', '--every', '86400']);
    expect(run.stdout + run.stderr).toMatch(/^pass:/m);
    expect(run.status).toBe(0);
  }, 480_000);
});
