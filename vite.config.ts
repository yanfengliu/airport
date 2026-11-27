import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The day-long benchmarks run after the other tests. The airside day judges how fast the
 * simulation runs a day as well as how it runs (under 60 seconds), so it runs alone, timing the
 * simulation and not the rest of the suite sharing the machine with it (in among the other tests
 * it took 84 s; alone, 18). The roads and people days judge no time and then run side by side.
 */
const AIRSIDE_DAY = ['test/soak.test.ts'];
const DAYS = ['test/day.test.ts'];
const TESTS = { environment: 'node', testTimeout: 180_000, hookTimeout: 180_000 } as const;

export default defineConfig({
  base: './',
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5183,
  },
  preview: {
    port: 4183,
  },
  test: {
    projects: [
      { test: { ...TESTS, name: 'checks', include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...AIRSIDE_DAY, ...DAYS], sequence: { groupOrder: 0 } } },
      { test: { ...TESTS, name: 'airside day', include: AIRSIDE_DAY, sequence: { groupOrder: 1 } } },
      { test: { ...TESTS, name: 'days', include: DAYS, sequence: { groupOrder: 2 } } },
    ],
  },
});
