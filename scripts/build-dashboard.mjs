#!/usr/bin/env node
/**
 * Build the dashboard bundle from ONE entry point, on any machine.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/web-dashboard` is a SEPARATE package tree (its own package.json +
 * package-lock.json: vite 5, react 18, vitest 3), so the root `npm ci` does
 * NOT install it. The root build script used to end with
 *
 *     cd src/web-dashboard && npx vite build
 *
 * which passed on a developer machine (leftover node_modules from an earlier
 * install) and failed on every clean CI checkout:
 *
 *     [UNRESOLVED_IMPORT] Could not resolve '@vitejs/plugin-react'
 *     failed to load config from src/web-dashboard/vite.config.ts
 *     Error [ERR_MODULE_NOT_FOUND]
 *
 * That is a "works on my machine" hole in the RELEASE path, not just CI: the
 * same `npm run build` runs from `prepack`/`prepublishOnly`, so a publish could
 * ship a stale dashboard bundle while reporting success.
 *
 * WHAT IT DOES
 *   1. Verifies the dashboard tree is actually installed.
 *   2. If not, provisions it hermetically from the COMMITTED lockfile
 *      (`npm ci`) — the same way CI does, so the result is reproducible.
 *   3. Builds with the dashboard's OWN pinned toolchain (`npm run build` in
 *      that tree), never a hoisted root `vite`. The root tree carries a
 *      different vite major, and resolving it silently was the second half of
 *      the bug.
 *   4. Proves the artifact exists afterwards, so a no-op build cannot pass
 *      silently.
 *
 * Env:
 *   NUVIRA_SKIP_DASHBOARD_INSTALL=1  fail instead of installing when the tree is
 *                                    missing (offline / air-gapped builds).
 *   NUVIRA_DASHBOARD_DIR=path        override the dashboard directory (tests).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DASHBOARD_DIR = resolve(SCRIPT_DIR, '..', 'src', 'web-dashboard');

/**
 * Deps that must be present for `vite build` to even LOAD the config.
 * `@vitejs/plugin-react` is the one CI actually failed on; `vite` is checked
 * because a hoisted root vite of a different major would "work" and produce a
 * subtly wrong bundle. `react` is checked so an empty/partial tree is caught.
 */
const REQUIRED_DEPS = ['vite', '@vitejs/plugin-react', 'react'];

/** Build output that proves the bundle was really written. */
const BUILD_OUTPUT = join('public', 'index.html');

/** Which required deps are missing from the dashboard's own node_modules. */
export function missingDashboardDeps(dashboardDir = DEFAULT_DASHBOARD_DIR) {
  const modulesDir = join(dashboardDir, 'node_modules');
  if (!existsSync(modulesDir)) return [...REQUIRED_DEPS];
  return REQUIRED_DEPS.filter((dep) => !existsSync(join(modulesDir, dep)));
}

/**
 * Install the dashboard tree from its committed lockfile.
 * `--foreground-scripts` is required so native install scripts (esbuild's
 * platform binary) actually run — without it the build fails later with a
 * confusing "cannot find esbuild" error.
 */
export function installDashboardDeps(dashboardDir = DEFAULT_DASHBOARD_DIR) {
  const args = ['ci', '--no-audit', '--no-fund', '--foreground-scripts'];
  if (!existsSync(join(dashboardDir, 'package-lock.json'))) {
    // No lockfile → `npm ci` refuses by design; fall back so a hand-rolled
    // tree still builds rather than dead-ending.
    args[0] = 'install';
    args.push('--silent');
  }
  execFileSync('npm', args, { cwd: dashboardDir, stdio: 'inherit' });
}

/** Run the dashboard's own build script (its pinned vite), not a hoisted one. */
export function buildDashboard(dashboardDir = DEFAULT_DASHBOARD_DIR) {
  execFileSync('npm', ['run', 'build'], { cwd: dashboardDir, stdio: 'inherit' });
}

/** Newest mtime under a directory, or 0 when it cannot be read. */
function newestMtimeMs(dir) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          /* best-effort */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Build the dashboard. Throws with an actionable message on any failure.
 * Returns { provisioned, output, bytes } for the caller to report.
 */
export function buildDashboardBundle(dashboardDir = DEFAULT_DASHBOARD_DIR) {
  if (!existsSync(join(dashboardDir, 'package.json'))) {
    throw new Error(`Dashboard package not found at ${dashboardDir}`);
  }

  const missing = missingDashboardDeps(dashboardDir);
  let provisioned = false;

  if (missing.length > 0) {
    if (process.env.NUVIRA_SKIP_DASHBOARD_INSTALL === '1') {
      throw new Error(
        `Dashboard dependencies are missing (${missing.join(', ')}) and ` +
          'NUVIRA_SKIP_DASHBOARD_INSTALL=1 forbids installing them.\n' +
          `  Install manually: cd ${join('src', 'web-dashboard')} && npm ci`,
      );
    }
    console.log(
      `\n[build-dashboard] dashboard tree is not installed (missing: ${missing.join(', ')}) —\n` +
        '[build-dashboard] provisioning it from the committed lockfile (npm ci)…',
    );
    installDashboardDeps(dashboardDir);
    provisioned = true;

    const stillMissing = missingDashboardDeps(dashboardDir);
    if (stillMissing.length > 0) {
      throw new Error(
        `Dashboard dependencies still missing after install: ${stillMissing.join(', ')}`,
      );
    }
  }

  const assetsDir = join(dashboardDir, 'public');
  const before = newestMtimeMs(assetsDir);
  buildDashboard(dashboardDir);

  const output = join(dashboardDir, BUILD_OUTPUT);
  if (!existsSync(output)) {
    throw new Error(`Dashboard build produced no ${BUILD_OUTPUT} — refusing to report success.`);
  }
  const bytes = statSync(output).size;
  const after = newestMtimeMs(assetsDir);
  if (before > 0 && after <= before) {
    // Not fatal (a fully cached build can reuse mtimes) but worth surfacing:
    // a silent no-op is exactly how a stale bundle ships.
    console.warn(
      '[build-dashboard] warning: bundle mtimes did not advance — verify the dashboard output is current.',
    );
  }

  return { provisioned, output, bytes };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dashboardDir = process.env.NUVIRA_DASHBOARD_DIR || DEFAULT_DASHBOARD_DIR;
  try {
    const result = buildDashboardBundle(dashboardDir);
    console.log(
      `[build-dashboard] ✅ dashboard bundle built${result.provisioned ? ' (tree provisioned)' : ''} — ` +
        `${result.output} (${(result.bytes / 1024).toFixed(1)} KB)`,
    );
  } catch (err) {
    console.error(`\n[build-dashboard] ✘ ${err.message}\n`);
    process.exit(1);
  }
}
