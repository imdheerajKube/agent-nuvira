/**
 * R12 — the bounded performance probe.
 *
 * The module exists because startup time, memory and throughput were the one class
 * of claim BOTH agents left UNMEASURED on the head-to-head audit. These tests pin
 * the three things that decide whether the probe is worth having:
 *
 *   1. THE COMMANDS RUN. Two of the first drafts named an interpreter and a timeout
 *      wrapper that this machine does not have (`python` and `timeout` are both
 *      absent on macOS), which produced a probe block whose commands fail — worse
 *      than no block, because it reads as one that ran. Both are pinned below.
 *   2. A REPO-DERIVED NAME NEVER REACHES A SHELL TEMPLATE UNCHECKED. The module
 *      name comes from the repository, so a hostile directory name must not become
 *      a hostile command.
 *   3. NOTHING TO PROBE MEANS NO PROMPT. `''` keeps such a turn byte-identical to a
 *      build without this module, and a false runtime detection (a stray
 *      `__init__.py` in a TypeScript repo) is exactly how that promise breaks.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROBE_TIMEOUT_SECONDS,
  buildPerfProbeBlock,
  detectPerfProbeInput,
  executableOnPath,
  pythonImportProbe,
  pythonProbe,
  safeIdentifier,
  safeRelativePath,
  type PerfProbeInput,
} from '../../src/learning/perf-probe.js';

const roots: string[] = [];
const fixture = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvira-perf-probe-'));
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

/** A host like the one this was measured on: no coreutils wrapper, only python3. */
const MACOS_LIKE: PerfProbeInput = {
  runtime: 'python',
  pythonModule: 'ai_voice_studio',
  pythonCommand: 'python3',
  timeoutCommand: '',
  platform: 'darwin',
  nativePerfTool: 'bsd',
};

describe('the emitted commands are bounded by something that EXISTS on this host', () => {
  it('falls back to the interpreter alarm when there is no timeout wrapper', () => {
    // MEASURED: `timeout` and `gtimeout` are both absent on a stock macOS, so a
    // template that assumed coreutils emitted commands the user cannot run.
    const probe = pythonImportProbe(MACOS_LIKE, 'ai_voice_studio');
    expect(probe.bounded).toBe(true);
    expect(probe.command).toContain(`signal.alarm(${PROBE_TIMEOUT_SECONDS})`);
    // The `-X` flag has to give way to the env var, because the bound now comes
    // from inside the interpreter. Measured: the env var prints the same profile.
    expect(probe.command).toContain('PYTHONPROFILEIMPORTTIME=1');
    expect(probe.command).not.toContain('timeout ');
  });

  it('uses the coreutils wrapper when the host has one', () => {
    const probe = pythonImportProbe({ ...MACOS_LIKE, timeoutCommand: 'gtimeout' }, 'x');
    expect(probe.command.startsWith(`gtimeout ${PROBE_TIMEOUT_SECONDS} `)).toBe(true);
    expect(probe.command).toContain('-X importtime');
  });

  it('never uses the interpreter name the module was not told about', () => {
    // MEASURED: `python` is absent on macOS (only `python3`), so the interpreter is
    // detected rather than assumed.
    const mac = pythonProbe(MACOS_LIKE, 'import json');
    expect(mac.command.startsWith('python3 -c')).toBe(true);
    const win = pythonProbe(
      { runtime: 'python', pythonModule: 'x', pythonCommand: 'python', platform: 'win32', timeoutCommand: '' },
      'import json',
    );
    expect(win.command.startsWith('python -c')).toBe(true);
  });

  it('says so, in the block, when nothing on the host can bound the command', () => {
    const block = buildPerfProbeBlock({
      runtime: 'python',
      pythonModule: 'x',
      pythonCommand: 'python',
      platform: 'win32',
      timeoutCommand: '',
    });
    // Honesty over a false promise: on Windows there is no wrapper and no alarm,
    // so the block states the bound is the operator's and an unbound number is
    // tagged UNMEASURED.
    expect(block).toMatch(/interrupt it and tag the measurement UNMEASURED/);
    expect(block).toMatch(/Do not report a number you had to kill to get/);
  });
});

describe('a repository-derived name never reaches a shell template unchecked', () => {
  it('drops anything outside the identifier charset', () => {
    expect(safeIdentifier('ai_voice_studio')).toBe('ai_voice_studio');
    // Every metacharacter is DROPPED (not escaped) — including the space, so the
    // result can only ever be one identifier-shaped token.
    expect(safeIdentifier('pkg"; rm -rf / #')).toBe('pkgrm-rf');
    expect(safeIdentifier('$(whoami)')).toBe('whoami');
    expect(safeIdentifier('a`b`c')).toBe('abc');
  });

  it('refuses a path carrying shell metacharacters outright', () => {
    expect(safeRelativePath('dist/index.js')).toBe('dist/index.js');
    expect(safeRelativePath('./src/main.ts')).toBe('src/main.ts');
    expect(safeRelativePath('dist/$(rm -rf /).js')).toBe('');
    expect(safeRelativePath('dist/`x`.js')).toBe('');
    expect(safeRelativePath('a"b.js')).toBe('');
  });
});

describe('runtime detection is marker-based, not guess-based', () => {
  it('does NOT call a TypeScript repo python because of one stray __init__.py', () => {
    // MEASURED on this very repository: `addon/__init__.py` (a fixture) made a
    // Node project probe as Python, and the block would have told the model to time
    // the import of a directory that is not the shipped program.
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js' }),
      'addon/__init__.py': '',
    });
    const input = detectPerfProbeInput(dir);
    expect(input.runtime).toBe('node');
    expect(input.nodeEntry).toBe('dist/index.js');
  });

  it('probes python when a python project marker exists, even beside node tooling', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js' }),
      'requirements.txt': 'wxpython\n',
      'ai_voice_studio/__init__.py': '',
    });
    const input = detectPerfProbeInput(dir);
    expect(input.runtime).toBe('python');
    expect(input.pythonModule).toBe('ai_voice_studio');
  });

  it('prefers the pyproject name, and reports nothing for a bare directory', () => {
    const named = fixture({
      'pyproject.toml': '[project]\nname = "voice_studio"\nversion = "1.0"\n',
      'voice_studio/__init__.py': '',
    });
    expect(detectPerfProbeInput(named).pythonModule).toBe('voice_studio');
    expect(detectPerfProbeInput(fixture({ 'README.md': '# nothing' })).runtime).toBe('none');
  });
});

describe('buildPerfProbeBlock', () => {
  it('returns NOTHING when there is nothing to probe', () => {
    // The byte-identity guarantee: the caller appends this to the prompt.
    expect(buildPerfProbeBlock({ runtime: 'none' })).toBe('');
  });

  it('names the three measurements, and the boundary of the memory one', () => {
    const block = buildPerfProbeBlock(MACOS_LIKE);
    expect(block).toContain('ai_voice_studio');
    expect(block).toMatch(/Cold import cost/);
    expect(block).toMatch(/Peak PYTHON allocation/);
    expect(block).toMatch(/heaviest realistic operation/);
    // tracemalloc cannot see a native/CUDA allocation — said, not implied.
    expect(block).toMatch(/tracemalloc sees Python allocations only/);
    expect(block).toMatch(/UNMEASURED/);
  });

  it('stays inside a small, fixed budget', () => {
    const block = buildPerfProbeBlock(MACOS_LIKE);
    expect(block.length).toBeLessThanOrEqual(2048);
    expect(block.split('\n').length).toBeLessThanOrEqual(26);
  });
});

describe('executableOnPath', () => {
  it('finds a name that is on PATH and rejects one that is not', () => {
    // Node itself is the one executable guaranteed to be here.
    expect(executableOnPath('node')).toBe(true);
    expect(executableOnPath('definitely-not-a-real-binary-xyz')).toBe(false);
    expect(executableOnPath('', { PATH: '/bin' })).toBe(false);
  });

  it('looks only where it was told to look', () => {
    expect(executableOnPath('node', { PATH: '/definitely/not/a/real/dir' })).toBe(false);
  });
});
