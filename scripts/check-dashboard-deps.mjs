#!/usr/bin/env node
/**
 * Preflight for the dashboard component suite (`npm run test:dashboard`).
 *
 * The dashboard is a SEPARATE package tree (its own package.json + lockfile,
 * vitest 3.x + jsdom + react) so it is not installed by the root `npm ci`.
 * Without this check a missing tree surfaces as a slow `npx` fetch or a
 * confusing "command not found", which is exactly the kind of friction that
 * lets a whole suite go unrun.
 *
 * Exits non-zero with an actionable message rather than skipping silently.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = join(root, 'src', 'web-dashboard');

const required = ['vitest', 'react', '@testing-library/react', 'jsdom'];
const missing = required.filter((dep) => !existsSync(join(dashboard, 'node_modules', dep)));

if (missing.length === 0) process.exit(0);

console.error(
  [
    '',
    '✘ Dashboard test dependencies are not installed — the component suite cannot run.',
    '',
    `  Missing: ${missing.join(', ')}`,
    `  Package: ${join('src', 'web-dashboard')}`,
    '',
    '  Install them with:',
    '',
    '      cd src/web-dashboard && npm ci',
    '',
    '  (This is a separate package tree from the root project, so the root',
    '   `npm ci` does not cover it. `npm run build:dashboard` installs too.)',
    '',
  ].join('\n'),
);

process.exit(1);
