/**
 * CLI-surface drift guard (`tests/docs/commands-surface.test.ts`).
 *
 * The generated `docs/COMMANDS_SURFACE.md` must always match the live
 * commander tree — that is its entire reason to exist (the curated
 * COMMANDS.md footer drifted for five minor releases before anyone noticed).
 * This test runs the generator in `--check` mode, which exits 0 in sync and
 * 1 on drift, so CI fails the moment a command is added/renamed without
 * regenerating the doc.
 *
 * Skips (never fails) when `dist/cli/cli-program.js` is absent — the generator
 * derives the surface from the BUILT tree, and test environments that never
 * built have no surface to compare. Drift itself, though, always fails.
 *
 * The path moved from `dist/cli/router.js` when `createCLI()` was split into
 * its own dispatcher module (see `src/cli/cli-program.ts`).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const script = join(repoRoot, 'scripts', 'generate-commands-surface.mjs');
const distRouter = join(repoRoot, 'dist', 'cli', 'cli-program.js');
const doc = join(repoRoot, 'docs', 'COMMANDS_SURFACE.md');

describe('docs/COMMANDS_SURFACE.md — live-CLI drift guard', () => {
  it.skipIf(!existsSync(distRouter))('matches the live commander tree', () => {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('node', [script, '--check'], { encoding: 'utf-8', cwd: repoRoot });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
      stdout = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(exitCode, `surface drifted from the live CLI:\n${stdout}`).toBe(0);
  });

  it.skipIf(!existsSync(distRouter) || !existsSync(doc))('documents the current version line in its header source', () => {
    const text = require('node:fs').readFileSync(doc, 'utf-8');
    expect(text).toContain('Source of truth: src/cli/cli-program.ts (createCLI)');
    // The product is agent-nuvira: the surface must name the CLI `nuvira`, not
    // the legacy `buff` alias.
    expect(text).toContain('### `nuvira chat`');
    expect(text).toContain('### `nuvira execute`');
    expect(text).toContain('### `nuvira skills`');
  });
});
