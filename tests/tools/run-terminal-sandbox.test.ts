/**
 * C3 — `run_terminal` must SANDBOX a Python package install: when no project
 * virtualenv exists it provisions a project-scoped `.venv`, and the install
 * runs with `VIRTUAL_ENV` pointing at it — never at the interpreter on PATH
 * (the machine's global Python).
 *
 * This reproduces the shape without touching a real index: a fake `poetry`
 * shim on PATH reports the `VIRTUAL_ENV` it was handed, and the tool must show
 * it was the freshly provisioned project venv. `poetry` (not `pip`) is used
 * because a provisioned venv contains its own `pip`, which would shadow the
 * shim; `poetry` is not in the venv, so the shim is the binary that runs.
 *
 * POSIX-only (uses a shell shim + a real `python3 -m venv`).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { runTerminalTool } from '../../src/tools/run-terminal.js';
import { clearPinnedProjectVenv, clearEnvironmentProbeCache } from '../../src/utils/project-env.js';
import type { ToolContext } from '../../src/tools/registry.js';

const dirs: string[] = [];
const origPath = process.env.PATH;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'run-terminal-sandbox-'));
  dirs.push(d);
  return d;
}

function hasPython(): boolean {
  try {
    execSync('python3 --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Put a fake `poetry` on PATH that echoes the VIRTUAL_ENV it was given. */
function installFakePoetry(root: string): void {
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'poetry');
  writeFileSync(
    shim,
    ['#!/bin/sh', 'echo "POETRY_SAW_VIRTUAL_ENV=$VIRTUAL_ENV"', 'echo "POETRY_SAW_PATH=$PATH"', 'exit 0', ''].join('\n'),
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${origPath ?? ''}`;
}

beforeEach(() => {
  clearPinnedProjectVenv();
  clearEnvironmentProbeCache();
});

afterEach(() => {
  process.env.PATH = origPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posixOnly = process.platform === 'win32' ? it.skip : it;
const withPython = hasPython() ? posixOnly : it.skip;

describe('run_terminal — install sandbox (C3)', () => {
  withPython('provisions a project .venv instead of installing against the global interpreter', async () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    installFakePoetry(root);
    const ctx: ToolContext = { configManager: {}, cwd: root };

    const result = await runTerminalTool({ command: 'poetry install', confirm: true }, ctx);

    // A project venv was created to land the install in…
    expect(existsSync(join(root, '.venv'))).toBe(true);
    // …and the install ran with VIRTUAL_ENV pointed at it (never the global).
    // (Assert on the mask-stable parts — run_terminal masks digit runs.)
    expect(result).toMatch(/POETRY_SAW_VIRTUAL_ENV=.*\/\.venv/);
    expect(result).toContain('/.venv/bin');
    expect(result).toContain('🔒');
    expect(result).not.toContain('Error:');
    // A cold, loaded runner can spend >15s creating the venv; the default 15s
    // test timeout failed on runner speed, not on the tool.
  }, 60_000);

  withPython('reuses an existing project .venv rather than creating a second one', async () => {
    const root = tmp();
    installFakePoetry(root);
    // Pre-create the project venv the way a user would.
    execSync('python3 -m venv .venv', { cwd: root });
    clearPinnedProjectVenv();
    const ctx: ToolContext = { configManager: {}, cwd: root };

    const result = await runTerminalTool({ command: 'poetry install', confirm: true }, ctx);

    expect(result).toMatch(/POETRY_SAW_VIRTUAL_ENV=.*\/\.venv/);
    expect(result).toContain('/.venv/bin');
    expect(result).not.toContain('Error:');
    // A cold, loaded runner can spend >15s creating the venv; the default 15s
    // test timeout failed on runner speed, not on the tool.
  }, 60_000);
});
