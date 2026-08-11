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
    // Disable parallel test file execution because memory tests share
    // a JSON file store at ~/.buff/memory/. Parallel threads corrupt
    // the shared file system state. The full suite runs in <1s.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/**/*.ts'],
    },
  },
});
