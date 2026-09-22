import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Automatic JSX runtime for .tsx test files (ink board tests).
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Every test file gets a throwaway memory store, so a test can never write
    // the developer's real ~/.nuvira/memory — the files the dashboard reports
    // and the router obeys. Without this, a test that drives the real pipeline
    // records real routing telemetry (see tests/setup/hermetic-env.ts).
    setupFiles: ['tests/setup/hermetic-env.ts'],
    // Disable parallel test file execution because the JSON file stores are
    // shared within a process. Parallel threads corrupt the shared file system
    // state. The full suite runs in <1s.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/**/*.ts'],
    },
  },
});
