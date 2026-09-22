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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const script = join(repoRoot, 'scripts', 'generate-commands-surface.mjs');
const distRouter = join(repoRoot, 'dist', 'cli', 'cli-program.js');
const doc = join(repoRoot, 'docs', 'COMMANDS_SURFACE.md');
const curated = join(repoRoot, 'docs', 'COMMANDS.md');

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

/**
 * The conversation this guard exists to prevent: the generated surface was
 * complete while the CURATED doc silently omitted 45 commands — including all
 * of `memory`, `gateway contact/history/logs/setup`, `marketplace`, `bedrock`,
 * `models excluded/staleness` and `nlu learnings`. The surface guard cannot
 * catch that, because the surface was never the thing that drifted.
 *
 * This is a COVERAGE check, not a formatting one: every command the CLI exposes
 * must at least be documented somewhere in COMMANDS.md. Substring matching is
 * deliberate — a command may be covered as a family (`nuvira gateway contact`)
 * rather than repeated for every subcommand.
 */
describe('docs/COMMANDS.md — curated doc covers the whole surface', () => {
  // The curated doc is TRACKED now (un-ignored in .gitignore). Its absence is a
  // real failure — it used to be silently gitignored, which meant this guard
  // skipped itself on every fresh clone AND the README linked to a 404.
  it('mentions every command the CLI exposes', () => {
    expect(
      existsSync(curated),
      'docs/COMMANDS.md is missing — it is gitignored again or was deleted',
    ).toBe(true);
    if (!existsSync(doc)) return; // no generated surface to compare against
    const surfaceText = readFileSync(doc, 'utf-8');
    const curatedText = readFileSync(curated, 'utf-8');

    const commands = [...surfaceText.matchAll(/^### `([^`]+)`$/gm)]
      .map((m) => m[1])
      // Drop the bare root command ("nuvira") — it needs no entry of its own.
      .map((c) => c.replace(/^nuvira\s*/, '').trim())
      .filter(Boolean);

    expect(commands.length).toBeGreaterThan(100);

    const undocumented = commands.filter((path) => !curatedText.includes(path));
    expect(
      undocumented,
      `${undocumented.length} command(s) exist in the CLI but are missing from docs/COMMANDS.md:\n` +
        undocumented.map((c) => `  nuvira ${c}`).join('\n') +
        '\n\nDocument them (objective + command + copy-pasteable examples) — ' +
        'a first-time user has no other source for them.',
    ).toEqual([]);
  });
});
