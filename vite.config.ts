import { defineConfig } from 'vitest/config';

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
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
