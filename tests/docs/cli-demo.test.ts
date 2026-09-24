/**
 * CLI demo guards (`tests/docs/cli-demo.test.ts`).
 *
 * The committed cast is a PUBLISHED artifact generated from the developer's own
 * machine, so two things must never be true of it: it must not leak private
 * values (home paths, keys, phone numbers, emails), and it must not be
 * malformed, mis-timestamped or stale. Both were real defects found by hand —
 * the first generation wrote event timestamps in MILLISECONDS where asciinema v2
 * specifies SECONDS (a ~45s tour declaring a 12.5-hour duration, freezing a
 * player on the first event), and the first curated tour recorded `stats`,
 * `history list`, `trace list`, `memory list` and `gateway logs`, publishing
 * real prompts and a partially-masked API key.
 *
 * The logic lives in the generator (`--check` / `--check-cast`) rather than in
 * this file so that the SCRUBBER (`redact()`) and the GUARD share one
 * `SECRET_PATTERNS` list and cannot drift apart — the same shape as the
 * `generate-commands-surface.mjs --check` drift guard next door.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const script = join(repoRoot, 'scripts', 'generate-cli-demo.mjs');
const bin = join(repoRoot, 'dist', 'index.js');
const cast = join(repoRoot, 'docs', 'demos', 'nuvira-cli-tour.cast');

/** Run the generator in a check mode and report its exit code + output. */
function runGenerator(args: string[]): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync('node', [script, ...args], { encoding: 'utf-8', cwd: repoRoot }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('docs/demos — the committed cast is publishable', () => {
  it('passes the format, timestamp, leak and staleness guard', () => {
    // The cast is TRACKED (see .gitignore), so its absence is a real failure:
    // the README links to it and a fresh clone would 404.
    expect(
      existsSync(cast),
      'docs/demos/nuvira-cli-tour.cast is missing — regenerate it with `npm run demo:cli`',
    ).toBe(true);

    const { code, output } = runGenerator(['--check-cast', cast]);
    expect(code, `the committed cast failed its guard:\n${output}`).toBe(0);
    expect(output).toContain('asciinema v2');
  });
});

describe('docs/demos — the curated tour cannot leak', () => {
  // Runs every curated command against the BUILT CLI, so it needs a build (CI
  // builds before the suite). Skips — never silently passes — without one, and
  // fails if a newly curated command prints local state or a secret that
  // redact() does not cover.
  it.skipIf(!existsSync(bin))(
    'fails if a curated command prints home paths or key-shaped tokens',
    () => {
      const { code, output } = runGenerator(['--check']);
      expect(
        code,
        `the curated tour leaked, or a state-printing command was added:\n${output}`,
      ).toBe(0);
    },
    180_000,
  );
});
