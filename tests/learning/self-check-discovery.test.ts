/**
 * SELF-CHECK DISCOVERY — name the project's own checks on an assessment turn.
 *
 * The module exists because the head-to-head audit (2026-10-16) on a Python
 * desktop app read the right modules, measured two real bugs, and STILL missed
 * three findings — it never ran the repository's own `tools/` checkers. These
 * tests pin the discovery rules (which declared script names count as checks,
 * which interpreters map to which extension) and, just as importantly, the two
 * guarantees that make the block safe to inject: it is CAPPED, and it is EMPTY
 * for a project that declares nothing, so such a turn is byte-identical to one
 * from a build without this module.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CHECKS,
  buildSelfCheckBlock,
  discoverSelfChecks,
  parseMakeTargets,
  readProjectSelfChecks,
} from '../../src/learning/self-check-discovery.js';

describe('discoverSelfChecks — what counts as a check', () => {
  it('takes the declared check names and skips the ones that are not checks', () => {
    const checks = discoverSelfChecks({
      packageScripts: {
        test: 'vitest run',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'check:schema': 'node scripts/schema.mjs',
        'build:cli': 'tsc',
        // Not checks: a substring match would wrongly pull these in.
        contest: 'echo no',
        latest: 'echo no',
        dev: 'tsx src/index.ts',
        start: 'node dist/index.js',
      },
    });
    const commands = checks.map((c) => c.command);
    expect(commands).toEqual([
      'npm run build:cli',
      'npm run check:schema',
      'npm run lint',
      'npm run test',
      'npm run typecheck',
    ]);
  });

  it('uses the repo\'s package manager for the run command', () => {
    const run = (packageManager?: string): string[] =>
      discoverSelfChecks({ packageScripts: { test: 'x' }, packageManager }).map((c) => c.command);
    expect(run('pnpm@9')).toEqual(['pnpm run test']);
    expect(run('yarn@4')).toEqual(['yarn test']);
    expect(run('bun@1')).toEqual(['bun run test']);
    expect(run('npm@10')).toEqual(['npm run test']);
    expect(run(undefined)).toEqual(['npm run test']);
  });

  it('maps a shipped tool to the interpreter its extension implies', () => {
    const checks = discoverSelfChecks({
      toolFiles: [
        'tools/winget_validate.py',
        'tools/dead_code_audit.py',
        'scripts/gate.sh',
        'scripts/report.ts',
        'tools/README.md', // not runnable — must be skipped, not guessed at
      ],
    });
    // Check-shaped names rank ahead of the rest, alphabetical inside each tier:
    // the two auditors first, then the other scripts.
    expect(checks.map((c) => c.command)).toEqual([
      'python tools/dead_code_audit.py',
      'python tools/winget_validate.py',
      'bash scripts/gate.sh',
      'npx tsx scripts/report.ts',
    ]);
    expect(checks.every((c) => c.source === "the project's own tooling")).toBe(true);
  });

  it('names the case this module was written for — the audited Python tree', () => {
    // The three findings the other agent found and this CLI's audit did not came
    // from these shipped checkers, which its plan mentioned and never ran.
    const checks = discoverSelfChecks({
      toolFiles: ['tools/dead_code_audit.py', 'tools/winget_validate.py', 'tools/make_winget.py'],
      hasPythonTests: true,
    });
    const commands = checks.map((c) => c.command);
    expect(commands).toContain('python tools/dead_code_audit.py');
    expect(commands).toContain('python tools/winget_validate.py');
    expect(commands).toContain('python -m pytest');
  });

  it('survives the cap on a tools/ directory full of a11y- noise (the measured miss)', () => {
    // THE REGRESSION THIS PINS. The real project's `tools/` holds 21 scripts, six
    // of them named `a11y_*`. An alphabetical cap of ten filled up on those and
    // NEVER named `tools/winget_validate.py` — the checker whose output was the
    // release defect the assessment missed — nor `pytest`. Both must survive.
    const checks = discoverSelfChecks({
      toolFiles: [
        'tools/a11y_adjacency.py',
        'tools/a11y_audit.py',
        'tools/a11y_gestures.py',
        'tools/a11y_mnemonics.py',
        'tools/a11y_sample.py',
        'tools/a11y_windows.py',
        'tools/build_book_pdf.py',
        'tools/dead_code_audit.py',
        'tools/e2e_omnivoice.py',
        'tools/e2e_server_profiles.py',
        'tools/e2e_voice_library_gui.py',
        'tools/fetch_omnivoice_languages.py',
        'tools/make_daisy_samples.py',
        'tools/make_winget.py',
        'tools/omnivoice_direct_probe.py',
        'tools/omnivoice_drone_probe.py',
        'tools/probe_msaa.py',
        'tools/rebuild_daisy2_book.py',
        'tools/walk_daisy_book.py',
        'tools/winget_manifests.py',
        'tools/winget_validate.py',
      ],
      hasPythonTests: true,
    });
    const commands = checks.map((c) => c.command);
    expect(commands.length).toBe(MAX_CHECKS);
    // The suite leads, then the three checkers, and only then the utility scripts.
    expect(commands[0]).toBe('python -m pytest');
    expect(commands).toContain('python tools/dead_code_audit.py');
    expect(commands).toContain('python tools/winget_validate.py');
    expect(commands).toContain('python tools/a11y_audit.py');
    expect(commands.slice(1, 4)).toEqual([
      'python tools/a11y_audit.py',
      'python tools/dead_code_audit.py',
      'python tools/winget_validate.py',
    ]);
  });

  it('reads CI as something to look at, and a marker file as the command it implies', () => {
    const checks = discoverSelfChecks({
      ciWorkflows: ['.github/workflows/ci.yml'],
      markerFiles: ['justfile'],
    });
    const commands = checks.map((c) => c.command);
    expect(commands).toContain('cat .github/workflows/ci.yml');
    expect(commands).toContain('just --list');
  });

  it('never repeats a command, and stays under the cap however many it is given', () => {
    const packageScripts: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) packageScripts[`test:unit-${i}`] = 'x';
    const checks = discoverSelfChecks({
      packageScripts,
      toolFiles: Object.keys(packageScripts).map((n) => `tools/${n}.py`),
      hasPythonTests: true,
    });
    expect(checks.length).toBe(MAX_CHECKS);
    expect(new Set(checks.map((c) => c.command)).size).toBe(checks.length);
    // Deterministic: the same input twice gives the identical list, so the block
    // does not churn the prompt cache between turns.
    expect(checks).toEqual(
      discoverSelfChecks({
        packageScripts,
        toolFiles: Object.keys(packageScripts).map((n) => `tools/${n}.py`),
        hasPythonTests: true,
      }),
    );
  });
});

describe('parseMakeTargets', () => {
  it('takes targets, not variable assignments or special targets', () => {
    const targets = parseMakeTargets(
      [
        'CFLAGS = -O2', // assignment, not a target
        'VERSION := 1.0', // := is still an assignment
        '.PHONY: test lint',
        'test: build',
        '\techo testing',
        'lint:',
        'build-app:',
        '%:',
        'all: build-app',
      ].join('\n'),
    );
    expect(targets).toEqual(['test', 'lint', 'build-app', 'all']);
  });

  it('filters the discovered targets down to check-shaped ones', () => {
    const checks = discoverSelfChecks({ makeTargets: ['test', 'lint', 'serve', 'all'] });
    expect(checks.map((c) => c.command)).toEqual(['make lint', 'make test']);
  });
});

describe('buildSelfCheckBlock — empty means byte-identical', () => {
  it('returns nothing at all when the project declares nothing', () => {
    // This is the load-bearing guarantee: the caller appends this string to the
    // prompt, so '' is what keeps a project with no discoverable checks on the
    // exact prompt a build without this module would send.
    expect(buildSelfCheckBlock([])).toBe('');
  });

  it('names the commands, the provenance, and the "say why you skipped it" rule', () => {
    const block = buildSelfCheckBlock(discoverSelfChecks({ toolFiles: ['tools/audit.py'] }));
    expect(block).toContain('python tools/audit.py');
    expect(block).toContain("the project's own tooling");
    expect(block).toMatch(/run these, do not just read them/i);
    expect(block).toMatch(/say so\s+and why|say so/i);
  });
});

describe('readProjectSelfChecks — the I/O wrapper', () => {
  const roots: string[] = [];
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-selfcheck-'));
    roots.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    return dir;
  };

  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  it('finds the declared scripts, the shipped tools, the Make targets and the suite', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9', scripts: { test: 'x', dev: 'y' } }),
      'tools/dead_code_audit.py': '# audit\n',
      'Makefile': 'test:\n\techo ok\n',
      'tests/test_thing.py': 'def test(): pass\n',
    });
    // Source order: declared scripts, then Make targets, then the project's own
    // test suite, then the tooling.
    const commands = readProjectSelfChecks(dir).map((c) => c.command);
    expect(commands).toEqual([
      'pnpm run test',
      'make test',
      'python -m pytest',
      'python tools/dead_code_audit.py',
    ]);
  });

  it('falls back to the lockfile for the package manager', () => {
    const dir = fixture({ 'package.json': '{"scripts":{"test":"x"}}', 'yarn.lock': '' });
    expect(readProjectSelfChecks(dir).map((c) => c.command)).toEqual(['yarn test']);
  });

  it('is best-effort: a missing directory, a malformed package.json and an empty project never throw', () => {
    expect(readProjectSelfChecks(join(tmpdir(), 'nuvira-does-not-exist-' + Date.now()))).toEqual([]);
    expect(readProjectSelfChecks('')).toEqual([]);
    expect(readProjectSelfChecks(fixture({ 'package.json': '{ not json' }))).toEqual([]);
  });
});
