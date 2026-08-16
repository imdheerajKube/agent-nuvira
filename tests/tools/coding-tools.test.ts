/**
 * P0.2 — Coding perception tools tests (`read_file` / `list_dir` / `glob`).
 *
 * The brief (master-plan P0.2): the chat agent must be able to OPEN the
 * files code_search finds — read with line numbers + offset/limit, list a
 * directory, glob by pattern. Covers the deny-first workspace gate (the
 * security boundary that the action tools in P0.3/P0.4 inherit), the output
 * caps (a huge file must not flood context), and the toolset gating.
 *
 * Everything runs in a hermetic tmpdir — no real project touched.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runReadFile, runListDir, runGlob } from '../../src/tools/coding-tools.js';
import { getTool, listTools } from '../../src/tools/registry.js';
import { toolsetForTool, filterToolsByToolsets, TOOLSETS } from '../../src/tools/toolsets.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** A hermetic workspace rooted in a fresh tmpdir. */
function makeWorkspace(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'buff-coding-tools-'));
  createdDirs.push(dir);
  mkdirSync(join(dir, 'src', 'components'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const root = 1;\nexport const root2 = 2;\n');
  writeFileSync(join(dir, 'src', 'components', 'Button.tsx'), 'export function Button() { return null; }\n');
  writeFileSync(join(dir, 'tests', 'index.test.ts'), 'import { test } from "vitest";\n');
  writeFileSync(join(dir, 'README.md'), '# workspace\n');
  // A file with a known line count for offset/limit checks.
  writeFileSync(join(dir, 'src', 'many-lines.ts'), Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n'));
  const ctx: ToolContext = { configManager: {}, cwd: dir };
  return { dir, ctx };
}

// Track created workspaces for cleanup (tmpdirs are pruned by the OS anyway).
const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('read_file — the agent opens a file', () => {
  it('returns numbered lines for a relative path', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src/index.ts' }, ctx);
    expect(out).toContain('src/index.ts (2 lines');
    expect(out).toContain('1: export const root = 1;');
    expect(out).toContain('2: export const root2 = 2;');
  });

  it('honors offset/limit (windowing a large file)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src/many-lines.ts', offset: 3, limit: 2 }, ctx);
    expect(out).toContain('showing lines 3–4');
    expect(out).toContain('3: line 3');
    expect(out).toContain('4: line 4');
    expect(out).not.toContain('5: line 5');
  });

  it('reports the total line count so the model can continue', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src/many-lines.ts', offset: 20, limit: 10 }, ctx);
    expect(out).toContain('(25 lines');
    expect(out).toContain('showing lines 20–25'); // clamps at EOF, no crash
  });

  it('tells the model when the path is a directory', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src' }, ctx);
    expect(out).toContain('is a directory — use list_dir');
  });

  it('reports a missing file cleanly', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src/nope.ts' }, ctx);
    expect(out).toContain('no such file or directory');
  });

  it('flags binary files instead of injecting them into context', async () => {
    const { dir, ctx } = makeWorkspace();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const out = await runReadFile({ path: 'blob.bin' }, ctx);
    expect(out).toContain('looks binary');
  });
});

describe('read_file — deny-first workspace gate', () => {
  it('refuses .. traversal escaping the workspace', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: '../../etc/passwd' }, ctx);
    expect(out).toContain('denied');
  });

  it('refuses an absolute path outside the workspace', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: '/etc/hosts' }, ctx);
    expect(out).toContain('denied');
  });

  it('refuses a symlink inside the workspace that points outside', async () => {
    const { dir, ctx } = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'buff-coding-tools-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside the workspace');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    const out = await runReadFile({ path: 'leak.txt' }, ctx);
    expect(out).toContain('denied');
  });
});

describe('list_dir — the agent explores structure', () => {
  it('lists directories first (sorted), then files (sorted)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runListDir({}, ctx);
    expect(out).toContain('📁 src/');
    expect(out).toContain('📁 tests/');
    expect(out).toContain('📄 README.md');
    // Directories precede files in the output.
    expect(out.indexOf('📁 src/')).toBeLessThan(out.indexOf('📄 README.md'));
  });

  it('lists a subdirectory by relative path', async () => {
    const { ctx } = makeWorkspace();
    const out = await runListDir({ path: 'src' }, ctx);
    expect(out).toContain('📁 components/');
    expect(out).toContain('📄 index.ts');
  });

  it('defaults to the workspace root', async () => {
    const { ctx } = makeWorkspace();
    const out = await runListDir({}, ctx);
    expect(out).toContain('list_dir: . —');
  });

  it('refuses .. traversal and reports a missing dir cleanly', async () => {
    const { ctx } = makeWorkspace();
    expect(await runListDir({ path: '../..' }, ctx)).toContain('denied');
    expect(await runListDir({ path: 'no-such-dir' }, ctx)).toContain('no such file or directory');
  });
});

describe('glob — the agent finds files by shape', () => {
  it('matches ** across depths', async () => {
    const { ctx } = makeWorkspace();
    const out = await runGlob({ pattern: 'src/**/*.ts' }, ctx);
    expect(out).toContain('src/index.ts');
    expect(out).toContain('src/many-lines.ts');
  });

  it('matches a single-segment pattern', async () => {
    const { ctx } = makeWorkspace();
    const out = await runGlob({ pattern: 'tests/*.test.ts' }, ctx);
    expect(out).toContain('tests/index.test.ts');
  });

  it('matches at the workspace root with **/ zero-depth semantics', async () => {
    const { ctx } = makeWorkspace();
    const out = await runGlob({ pattern: '**/*.ts' }, ctx);
    expect(out).toContain('src/index.ts');
    expect(out).toContain('tests/index.test.ts');
  });

  it('reports no matches cleanly', async () => {
    const { ctx } = makeWorkspace();
    const out = await runGlob({ pattern: '*.py' }, ctx);
    expect(out).toContain("no files match '*.py'");
  });

  it('deny-first: refuses .. escapes and absolute patterns', async () => {
    const { ctx } = makeWorkspace();
    expect(await runGlob({ pattern: '../**/*.ts' }, ctx)).toContain('denied');
    expect(await runGlob({ pattern: '/etc/**' }, ctx)).toContain('denied');
  });

  it('caps matches at max_results', async () => {
    const { dir, ctx } = makeWorkspace();
    mkdirSync(join(dir, 'many'));
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, 'many', `f${i}.ts`), 'x\n');
    const out = await runGlob({ pattern: 'many/*.ts', max_results: 3 }, ctx);
    expect(out).toContain('3 matches');
    expect(out).toContain('(truncated');
  });
});

describe('toolset gating — the coding toolset owns the perception tools', () => {
  it('registers read_file / list_dir / glob in the registry', () => {
    for (const name of ['read_file', 'list_dir', 'glob']) {
      const tool = getTool(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool!.category).toBe('workflow');
      expect(tool!.endsAgentStep).toBe(false);
    }
  });

  it('assigns each tool to EXACTLY ONE toolset (the coding toolset)', () => {
    for (const name of ['read_file', 'list_dir', 'glob']) {
      expect(toolsetForTool(name)?.name).toBe('coding');
    }
    expect(TOOLSETS.find((t) => t.name === 'coding')?.tools).toEqual(['read_file', 'list_dir', 'glob']);
  });

  it('the coding toolset is disabled → the tools are gated out', () => {
    const names = filterToolsByToolsets(listTools(), ['coding']).map((t) => t.name);
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('list_dir');
    expect(names).not.toContain('glob');
    expect(names).toContain('code_search'); // untouched sibling toolset
  });
});
