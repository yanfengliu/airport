// The day-long airside benchmark, one seed, as part of the gate: a full day of flights with every
// limit of `tools/sim/soak.ts` (whole cycles, waits on the ground and at the gates, go-arounds, no
// two aircraft meeting, no runway conflicts, nothing stuck, under a minute of the processor's
// time). It runs alone, after the other tests (vite.config.ts). Bound: one
// seed of the eleven the benchmark is judged on; run
// `node tools/sim/soak.ts --seeds 7,11,3,21,42,101,202,303,404,505,606` for all of them.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/layout.ts';

describe('a day of flights', () => {
  it('passes the airside benchmark on seed 7', () => {
    const run = spawnSync(process.execPath, [join(repoRoot, 'tools', 'sim', 'soak.ts'), '--seeds', '7'], { encoding: 'utf8', timeout: 240_000 });
    expect(run.stdout + run.stderr).toMatch(/1 of 1 seeds pass/);
    expect(run.status).toBe(0);
  }, 300_000);
});
