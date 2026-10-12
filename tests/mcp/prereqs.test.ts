/**
 * MCP prerequisite probe tests (`src/mcp/prereqs.ts`).
 *
 * Hermetic: PATH lookups are exercised against a TEMP directory of executable
 * files (no real toolchain is assumed — a machine without npx must not make the
 * suite fail), versions are injected, and nothing is spawned or fetched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  commandExists,
  compareVersions,
  describeMissingPrereqs,
  probePrereqs,
  type MCPPrereq,
} from '../../src/mcp/prereqs.js';

let binDir = '';

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'buff-mcp-bin-'));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/** Create an executable file in the temp bin dir (POSIX) or a .cmd on Windows. */
function fakeExecutable(name: string): string {
  const file = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
  return file;
}

const envWith = (path: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: path,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...extra,
});

describe('compareVersions', () => {
  it('orders dotted versions, tolerating a leading v and pre-release suffixes', () => {
    expect(compareVersions('20.18.1', '18.18.0')).toBeGreaterThan(0);
    expect(compareVersions('18.18.0', '20.18.1')).toBeLessThan(0);
    expect(compareVersions('v20.18.1', '20.18.1')).toBe(0);
    expect(compareVersions('20.18.1-rc.1', '20.18.1')).toBe(0);
    expect(compareVersions('18', '18.18.0')).toBeLessThan(0);
    expect(compareVersions('18.18.0', '18.18')).toBe(0);
  });
});

describe('commandExists', () => {
  it('finds an executable on PATH and rejects a name that is not there', () => {
    fakeExecutable('npx');
    expect(commandExists('npx', envWith(binDir))).toBe(true);
    expect(commandExists('uvx', envWith(binDir))).toBe(false);
    expect(commandExists('', envWith(binDir))).toBe(false);
  });

  it('accepts an absolute path to an executable', () => {
    const file = fakeExecutable('github-mcp-server');
    expect(commandExists(file, envWith(binDir))).toBe(true);
    expect(commandExists(`${file}-missing`, envWith(binDir))).toBe(false);
  });

  it('reports a non-executable file as missing rather than assuming it works', () => {
    if (process.platform === 'win32') return; // POSIX execute bit only
    const file = join(binDir, 'not-executable');
    writeFileSync(file, 'plain text', 'utf-8');
    chmodSync(file, 0o644);
    expect(commandExists('not-executable', envWith(binDir))).toBe(false);
  });
});

describe('probePrereqs', () => {
  const nodePrereq: MCPPrereq = { kind: 'node', name: 'node', minVersion: '20.18.1', hint: 'install Node 20+' };

  it('fails a node floor the running process does not meet', () => {
    const status = probePrereqs([nodePrereq], { env: envWith(binDir), nodeVersion: '18.18.0' });
    expect(status.ok).toBe(false);
    expect(status.missing).toEqual([nodePrereq]);
  });

  it('passes a node floor the process meets', () => {
    const status = probePrereqs([nodePrereq], { env: envWith(binDir), nodeVersion: '20.18.1' });
    expect(status.ok).toBe(true);
    expect(status.missing).toEqual([]);
  });

  it('lets a runtime override satisfy the floor by PRESENCE, reported unverified', () => {
    fakeExecutable('node20');
    const status = probePrereqs([nodePrereq], {
      env: envWith(binDir),
      nodeVersion: '18.18.0',
      runtimeCommand: 'node20',
    });
    expect(status.ok).toBe(true);
    expect(status.unverified).toHaveLength(1);
    // The point: it must NOT claim the version was verified.
    expect(status.unverified[0]).toContain('checked at connect');
  });

  it('still fails when the runtime override itself is absent', () => {
    const status = probePrereqs([nodePrereq], {
      env: envWith(binDir),
      nodeVersion: '18.18.0',
      runtimeCommand: 'node20',
    });
    expect(status.ok).toBe(false);
    expect(status.missing).toEqual([nodePrereq]);
  });

  it('checks env vars, commands and files', () => {
    fakeExecutable('uvx');
    const prereqs: MCPPrereq[] = [
      { kind: 'command', name: 'uvx', hint: 'install uv' },
      { kind: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'create a token' },
      { kind: 'file', name: join(binDir, 'nope.json'), hint: 'provide a token file' },
    ];
    const status = probePrereqs(prereqs, { env: envWith(binDir), nodeVersion: '20.0.0' });
    expect(status.ok).toBe(false);
    expect(status.missing.map((m) => m.name)).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN', join(binDir, 'nope.json')]);

    const ok = probePrereqs(prereqs, {
      env: envWith(binDir, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }),
      nodeVersion: '20.0.0',
    });
    expect(ok.ok).toBe(false); // the file is still missing

    const file = join(binDir, 'token.json');
    writeFileSync(file, '{}', 'utf-8');
    const all = probePrereqs(
      [
        { kind: 'command', name: 'uvx', hint: 'install uv' },
        { kind: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'create a token' },
        { kind: 'file', name: file, hint: 'provide a token file' },
      ],
      { env: envWith(binDir, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }), nodeVersion: '20.0.0' },
    );
    expect(all.ok).toBe(true);
  });

  it('treats a whitespace-only env var as unset', () => {
    const status = probePrereqs([{ kind: 'env', name: 'TOKEN', hint: 'set it' }], {
      env: envWith(binDir, { TOKEN: '   ' }),
    });
    expect(status.ok).toBe(false);
  });
});

describe('describeMissingPrereqs', () => {
  it('names the dependency and the action, per kind', () => {
    const lines = describeMissingPrereqs([
      { kind: 'command', name: 'uvx', hint: 'install uv' },
      { kind: 'env', name: 'TOKEN', hint: 'create a token' },
      { kind: 'file', name: '/tmp/x.json', hint: 'write a token file' },
      { kind: 'node', name: 'node', minVersion: '20.18.1', hint: 'install Node 20+' },
    ]);
    expect(lines[0]).toContain("'uvx' not found on PATH");
    expect(lines[0]).toContain('install uv');
    expect(lines[1]).toContain('$TOKEN is not set');
    expect(lines[2]).toContain('/tmp/x.json does not exist');
    expect(lines[3]).toContain('Node.js 20.18.1+');
  });
});
