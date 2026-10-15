/**
 * `scripts/release-prep.mjs` — the fold that must not lose the release notes.
 *
 * THE BUG THIS PINS. The script scanned "the junk region" as
 * `src.slice(0, src.indexOf('# Changelog'))` — empty by construction, because the
 * title is the first line of the file. So the loop over that region never saw a
 * line, `kept` was always `[]`, and a `## [Unreleased] — Session N …` block was
 * silently dropped when it was folded under the release header: the notes for the
 * release existed nowhere else afterwards. It printed "0 session entries kept",
 * which reads like a changelog with nothing pending rather than a scan of the
 * wrong span.
 *
 * The script is run as a process, against a throwaway CHANGELOG in its own cwd,
 * because that is exactly what the release pipeline does (`release-pipeline.sh`
 * → `node scripts/release-prep.mjs <version> "<title>"`) — and because the bug was
 * a file-level one that no in-process unit test of the parsing would have caught.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/release-prep.mjs');

/** A changelog shaped like the real one: title, intro, an Unreleased block, releases. */
const PENDING = `# Changelog

All notable changes to **Agent-Nuvira** are documented in this file.

## [Unreleased] — Session 54 — the fold kept the notes

The body of the unreleased entry.

- **One fixed thing** — measured, with a number in it.

## v3.5.6 — the previous release

- **An older bullet** — still here.
`;

describe('release-prep.mjs — folding an Unreleased block', () => {
  let dir: string;

  const run = (version: string, title: string): { out: string; status: number } => {
    try {
      const out = execFileSync('node', [SCRIPT, version, title], { cwd: dir, encoding: 'utf8' });
      return { out, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
    }
  };
  const changelog = (): string => readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-release-prep-'));
    writeFileSync(join(dir, 'CHANGELOG.md'), PENDING, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves the unreleased session entry under the new version header', () => {
    const { out, status } = run('3.5.7', 'the fold kept the notes');
    expect(status).toBe(0);
    // Reported honestly: one entry kept, one block folded.
    expect(out).toContain('1 session entries kept, 1 unreleased block(s) folded');

    const folded = changelog();
    // The new version header exists, and the entry is a session section under it…
    expect(folded).toContain('## v3.5.7 — the fold kept the notes');
    // The entry keeps ITS OWN title (the version header carries the release one),
    // with ONE separator — not `### Session 54 — — the fold kept the notes`.
    expect(folded).toContain('### Session 54 — the fold kept the notes');
    expect(folded).not.toContain('— — ');
    // And it is not ALSO left where it was: one entry, one copy. The body is the
    // test — a duplicated entry kept its body in the original `## [Unreleased]`
    // block, which is what a fold that copies without removing produces.
    expect(folded.match(/The body of the unreleased entry\./g) ?? []).toHaveLength(1);
    expect(folded.match(/One fixed thing/g) ?? []).toHaveLength(1);
    // …with its body intact — the notes are the whole point of the fold.
    expect(folded).toContain('The body of the unreleased entry.');
    expect(folded).toContain('- **One fixed thing** — measured, with a number in it.');
    // The Unreleased placeholder is gone, and the older release survives.
    expect(folded).not.toContain('## [Unreleased]');
    expect(folded).toContain('## v3.5.6 — the previous release');
    expect(folded).toContain('- **An older bullet** — still here.');
  });

  it('refuses a re-run of the SAME version instead of writing a second copy', () => {
    run('3.5.7', 'the fold kept the notes');
    const once = changelog();
    // Pressing the release again (or re-running the pipeline for a version
    // already folded) must not add a second header, a second highlights list or a
    // second copy of the entry.
    const second = run('3.5.7', 'the fold kept the notes');
    expect(second.status).toBe(1);
    expect(second.out).toContain('already in CHANGELOG.md');
    expect(changelog()).toBe(once);
    expect(changelog().match(/^## v3\.5\.7/gm) ?? []).toHaveLength(1);
    expect(changelog().match(/### Session 54/g) ?? []).toHaveLength(1);
  });

  it('REFUSES to fold an unreleased block it cannot keep, rather than dropping it', () => {
    // A block the fold cannot parse (no session number) is the shape of the
    // original bug. Dropping it would delete the only copy of the notes, so the
    // script must abort — and leave the file untouched.
    const malformed = PENDING.replace(
      '## [Unreleased] — Session 54 — the fold kept the notes',
      '## [Unreleased] — an entry the fold cannot number',
    );
    writeFileSync(join(dir, 'CHANGELOG.md'), malformed, 'utf8');

    const { out, status } = run('3.5.7', 'no notes kept');
    expect(status).toBe(1);
    expect(out).toContain('NONE could be kept');
    // The deliverable is intact: the notes are still in the file, untouched.
    expect(changelog()).toBe(malformed);
    expect(changelog()).toContain('The body of the unreleased entry.');
  });
});
