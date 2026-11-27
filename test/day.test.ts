// The day-long road and people benchmarks, as part of the gate: a whole day of road traffic judged
// on the 'Roads flow' criterion (nobody standing ten minutes, the freeways carrying their demand,
// the curbs served), and a whole day of people judged on theirs (everyone and every bag accounted
// for, misses, mishandled bags and security waits within their limits). Neither judges time, so the
// two run side by side, after the airside day (soak.test.ts) has run alone. Bound: seed 7, from
// 04:00; run the tools with other seeds and starts for more.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/layout.ts';

/** Run one of the benchmark tools to its end: its exit status and everything it printed. */
const tool = (name: string, args: string[]): Promise<{ status: number | null; output: string }> =>
  new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'tools', 'sim', name), ...args], { timeout: 420_000 });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (status) => done({ status, output }));
  });

describe.concurrent('a day on the roads and a day of people', () => {
  it('passes the roads benchmark on seed 7', async () => {
    const run = await tool('roads.ts', ['--hours', '24', '--start', '04:00', '--seed', '7', '--every', '86400']);
    expect(run.output).toMatch(/^pass:/m);
    expect(run.status).toBe(0);
  }, 480_000);

  it('passes the people benchmark on seed 7', async () => {
    const run = await tool('people.ts', ['--hours', '24', '--start', '04:00', '--seed', '7', '--every', '86400']);
    expect(run.output).toMatch(/^pass:/m);
    expect(run.status).toBe(0);
  }, 480_000);
});
