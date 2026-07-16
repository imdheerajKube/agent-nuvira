import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // Use the src/test directory for tests
    include: ['src/test/**/*.test.ts'],
    // Environment is Node (not jsdom) since this is a CLI-based extension
    environment: 'node',
    // Enable vitest globals for describe/it/expect
    globals: true,
    // Timeout for each test
    testTimeout: 10_000,
  },
  // Resolve .ts files with target matching the extension
  esbuild: {
    target: 'es2022',
  },
});
