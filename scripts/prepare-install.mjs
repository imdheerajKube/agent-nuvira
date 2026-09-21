#!/usr/bin/env node
/**
 * `prepare` — build this package for a CONSUMER who installed it from a git URL
 * or a local path (`npm install github:user/agent-nuvira`).
 *
 * WHY THIS IS GUARDED RATHER THAN A PLAIN `npm run build`
 * ------------------------------------------------------
 * npm runs `prepare` on `npm install` / `npm ci` — including in THIS project,
 * which is exactly where it is not wanted:
 *
 *   1. Every workflow already installs and then runs `npm run build`
 *      explicitly (test-linux, test-windows, publish). An ungated build here
 *      duplicates a full tsc + dashboard build on every CI job.
 *   2. It would move install-time failure earlier and less clearly: an
 *      air-gapped `npm ci` with `NUVIRA_SKIP_DASHBOARD_INSTALL=1` succeeds today
 *      and fails at the build step; with an ungated `prepare` it would fail
 *      during install instead.
 *   3. `npm pack` / `npm publish` already build through `prepack` and
 *      `prepublishOnly`, so running again from `prepare` is pure duplication.
 *
 * So the build runs only when it is actually needed — a real consumer install —
 * and is skipped for CI and for the release lifecycle paths that already build.
 *
 * Escape hatches:
 *   NUVIRA_SKIP_PREPARE=1  always skip (e.g. a scripted install that will build
 *                          itself later).
 *   CI / GITHUB_ACTIONS     detected automatically; the workflows' explicit
 *                          `npm run build` step owns the build.
 */

import { execSync } from 'node:child_process';

const lifecycleCommand = process.env.npm_command ?? '';
const isReleaseLifecycle = lifecycleCommand === 'pack' || lifecycleCommand === 'publish';
const isCi = Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS);
const skipExplicitly = process.env.NUVIRA_SKIP_PREPARE === '1';

if (skipExplicitly || isCi || isReleaseLifecycle) {
  const why = skipExplicitly
    ? 'NUVIRA_SKIP_PREPARE=1'
    : isCi
      ? 'CI detected (the workflow runs `npm run build` explicitly)'
      : `npm ${lifecycleCommand} builds via prepack/prepublishOnly`;
  console.log(`[prepare] skipping the build — ${why}. Run \`npm run build\` when you need dist/.`);
  process.exit(0);
}

console.log('[prepare] building for an install from git/local path…');
execSync('npm run build', { stdio: 'inherit' });
