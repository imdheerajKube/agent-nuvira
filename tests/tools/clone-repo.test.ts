/**
 * P3a — clone_repo tool tests.
 *
 * The agent can assess OTHER people's projects: clone (depth-1 shallow) into
 * an ephemeral hashed cache and scope the coding-tool family to it via
 * ctx.cwd. Hermetic — `git clone` is stubbed (no network), the home dir is a
 * temp dir, and the "clone" is a fabricated repo dir with a .git marker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Temp HOME so clones land in a sandbox, never the real ~/.buff.
const holder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { home: mkdtempSync(join(base, 'buff-clone-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => holder.home,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

// Stub git clone — no network ever. The fake creates the target dir with a
// .git marker + a couple of files, mirroring what a real shallow clone leaves.
const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { runCloneRepo } from '../../src/tools/clone-repo.js';
import { getTool, listTools } from '../../src/tools/registry.js';
import { toolsetForTool, TOOLSETS, filterToolsByToolsets } from '../../src/tools/toolsets.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** Make a fake clone target (what the stubbed git would have produced). */
function fakeClone(url: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const dir = join(holder.home, '.buff', 'clones', hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git-marker'), 'fake');
  writeFileSync(join(dir, 'README.md'), '# Cloned repo\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  return dir;
}

describe('clone_repo tool', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    // The stubbed clone creates the target dir (matching real git behavior).
    mockExecFileSync.mockImplementation((cmd: string, argv: string[]) => {
      if (cmd === 'git') {
        const url = argv[argv.length - 2];
        const target = argv[argv.length - 1];
        fakeClone(url);
        // Record the args for assertions but the dir is already made.
        return target;
      }
      return '';
    });
  });

  afterEach(() => {
    rmSync(join(holder.home, '.buff', 'clones'), { recursive: true, force: true });
  });

  it('clones an http(s) URL shallow (depth 1, --quiet) into the hashed cache and scopes cwd', async () => {
    const ctx: ToolContext = { configManager: {}, cwd: '/original/workspace' };
    const out = await runCloneRepo({ url: 'https://github.com/example/repo.git' }, ctx);
    expect(out).toContain('✅ Cloned https://github.com/example/repo.git');
    expect(out).toContain('Workspace is now scoped to the clone');
    // The clone went to the hashed cache, NOT the user workspace.
    expect(String(ctx.cwd)).toContain(join(holder.home, '.buff', 'clones'));
    expect(String(ctx.cwd)).not.toContain('/original/workspace');
    // Depth-1 shallow, quiet, argv-array (no shell).
    const call = mockExecFileSync.mock.calls[0] as [string, string[]];
    expect(call[0]).toBe('git');
    expect(call[1]).toEqual(['clone', '--depth', '1', '--quiet', 'https://github.com/example/repo.git', expect.stringContaining('clones')]);
  });

  it('supports an explicit ref via --branch', async () => {
    const ctx: ToolContext = { configManager: {} };
    await runCloneRepo({ url: 'https://github.com/example/repo.git', ref: 'v1.2.0' }, ctx);
    const call = mockExecFileSync.mock.calls[0] as [string, string[]];
    expect(call[1]).toContain('--branch');
    expect(call[1]).toContain('v1.2.0');
  });

  it('denies non-git URLs outright (no clone attempted)', async () => {
    const ctx: ToolContext = { configManager: {} };
    for (const bad of ['ftp://x/y', 'file:///etc/passwd', 'github.com/plain', 'javascript:alert(1)']) {
      const out = await runCloneRepo({ url: bad }, ctx);
      expect(out).toContain('Error:');
      expect(out).toContain('denied');
    }
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('denies URLs with shell metacharacters (injection impossible)', async () => {
    const ctx: ToolContext = { configManager: {} };
    for (const bad of ['https://x/y; rm -rf /', 'https://x/y $(curl evil)', 'git@x:y`touch /tmp/pwn`']) {
      const out = await runCloneRepo({ url: bad }, ctx);
      expect(out).toContain('Error:');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    }
    const refBad = await runCloneRepo({ url: 'https://x/y.git', ref: 'a;b' }, ctx);
    expect(refBad).toContain('Error:');
  });

  it('reuses the cached clone when .git already exists (no second clone)', async () => {
    // Pre-create the clone dir with a .git marker — the tool must reuse it.
    const url = 'https://github.com/example/repo.git';
    fakeClone(url);
    mkdirSync(join(join(holder.home, '.buff', 'clones', require('node:crypto').createHash('sha256').update(url).digest('hex').slice(0, 16)), '.git'), { recursive: true });
    mockExecFileSync.mockClear();
    const ctx: ToolContext = { configManager: {} };
    const out = await runCloneRepo({ url }, ctx);
    expect(out).toContain('✅ Cloned');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns a helpful error string when the clone fails (never throws)', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('git: could not resolve host');
    });
    const ctx: ToolContext = { configManager: {} };
    const out = await runCloneRepo({ url: 'https://github.com/nonexistent-xyz/repo.git' }, ctx);
    expect(out).toContain('Error: git clone failed');
    expect(out).toContain('could not resolve host');
  });

  it('the cloned workspace is scoped for the coding-tool family (read_file/list_dir work on the clone)', async () => {
    const ctx: ToolContext = { configManager: {} };
    await runCloneRepo({ url: 'https://github.com/example/repo.git' }, ctx);
    // list_dir on the clone works; list_dir on the ORIGINAL workspace root
    // is now OUTSIDE the scoped cwd and must be denied (deny-first).
    const { runListDir } = await import('../../src/tools/coding-tools.js');
    const inside = await runListDir({ path: '.' }, ctx);
    expect(inside).toContain('README.md');
    const outside = await runListDir({ path: '/original/workspace' }, ctx);
    expect(outside).toContain('denied');
  });

  it('is registered and owned by the code toolset (toolset gate applies)', () => {
    const tool = getTool('clone_repo');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
    expect(toolsetForTool('clone_repo')?.name).toBe('code');
    expect(TOOLSETS.find((t) => t.name === 'code')?.tools).toEqual(['code_search', 'delegate', 'clone_repo']);
    // Disabling the code toolset gates it out.
    const names = filterToolsByToolsets(listTools(), ['code']).map((t) => t.name);
    expect(names).not.toContain('clone_repo');
    expect(names).not.toContain('code_search');
  });
});
