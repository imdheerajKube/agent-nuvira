import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sdk = (rel: string) => fileURLToPath(new URL(`../../src/agent-sdk/src/${rel}`, import.meta.url));

/**
 * The example imports the SDK by its published name (`@agent-nuvira/sdk`), which
 * is what a user copies. In-repo there is no `node_modules/@agent-nuvira/sdk`, so
 * these aliases point that specifier at the local source — the same trick the
 * `tsconfig.verify.json` paths use. A consumer of the example (after `npm install`)
 * resolves the real package instead and needs neither.
 */
export default defineConfig({
  // Anchor to the example directory so the suite runs standalone from any cwd.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: [
      { find: '@agent-nuvira/sdk/testing', replacement: sdk('testing.ts') },
      { find: '@agent-nuvira/sdk/agent', replacement: sdk('agent.ts') },
      { find: '@agent-nuvira/sdk/types', replacement: sdk('types.ts') },
      { find: '@agent-nuvira/sdk/define', replacement: sdk('define.ts') },
      { find: '@agent-nuvira/sdk', replacement: sdk('index.ts') },
    ],
  },
});
