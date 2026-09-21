/**
 * Upgrades-over-parity tests for the coding tools.
 *
 * Two capabilities are covered here that go beyond the basic read/edit tools:
 *
 *  1. BATCHED reads (`read_file { paths }`) — one call reads many files under a
 *     shared character budget, with per-file errors, dedup, continuation
 *     offsets, and deterministic order.
 *  2. TRANSACTIONAL multi-pair edits (`edit_file { replacements }`) — all
 *     replacements apply in one call, all-or-nothing, written atomically, with
 *     a `dry_run` preview and a unified diff in the result.
 *
 * Everything runs in a hermetic tmpdir.
 *
 * CROSS-PLATFORM NOTE: these tools report workspace paths in NATIVE form (the
 * pre-existing convention — `write_file` has always reported
 * `deep\nested\new-file.ts` on Windows). Expectations are therefore built with
 * `p()` (a `join`) rather than hard-coded slashes; this file previously spelled
 * them `src/a.ts` and failed on the windows-latest runner, where the tool
 * correctly returned `src\a.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runReadFile, runEditFile } from '../../src/tools/coding-tools.js';
import type { ToolContext } from '../../src/tools/registry.js';

/** Build a native workspace path for an assertion (`src/a.ts` on POSIX). */
const p = (...parts: string[]) => join(...parts);

const createdDirs: string[] = [];

function makeWorkspace(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'buff-coding-upgrade-'));
  createdDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\nexport const b2 = 3;\n');
  writeFileSync(join(dir, 'src', 'c.ts'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  const ctx: ToolContext = { configManager: {}, cwd: dir };
  return { dir, ctx };
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('read_file — batched reads (one call, many files)', () => {
  it('reads several files in one call, one section each', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: ['src/a.ts', 'src/b.ts'] }, ctx);
    expect(out).toContain('read_file: 2 files requested, 2 read');
    expect(out).toContain(`### ${p('src', 'a.ts')}`);
    expect(out).toContain(`### ${p('src', 'b.ts')}`);
    expect(out).toContain('1: export const a = 1;');
    expect(out).toContain('2: export const b2 = 3;');
  });

  it('preserves the caller entry order', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: ['src/c.ts', 'src/a.ts'] }, ctx);
    expect(out.indexOf(`### ${p('src', 'c.ts')}`)).toBeLessThan(out.indexOf(`### ${p('src', 'a.ts')}`));
  });

  it('honors a per-entry window ({ path, offset, limit })', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: [{ path: 'src/c.ts', offset: 4, limit: 2 }] }, ctx);
    expect(out).toContain('lines 4–5');
    expect(out).toContain('4: line 4');
    expect(out).toContain('5: line 5');
    expect(out).not.toContain('6: line 6');
  });

  it('isolates a bad path — the other files still read', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: ['src/a.ts', 'src/missing.ts', 'src/b.ts'] }, ctx);
    // Unresolvable entries are labelled with the caller's own spelling.
    expect(out).toContain('### src/missing.ts — not read');
    expect(out).toContain('no such file or directory');
    expect(out).toContain(`### ${p('src', 'a.ts')}`);
    expect(out).toContain(`### ${p('src', 'b.ts')}`);
    expect(out).toContain('2 read');
  });

  it('deny-first per entry: a denied path is reported, the rest read', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: ['../../etc/passwd', '/etc/hosts', 'src/a.ts'] }, ctx);
    expect(out).toContain('denied');
    expect(out).toContain(`### ${p('src', 'a.ts')}`);
  });

  it('deduplicates repeated paths (including ./ forms)', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ paths: ['src/a.ts', './src/a.ts', 'src/a.ts'] }, ctx);
    expect(out).toContain('duplicate of entry #1 (skipped)');
    expect(out).toContain('1 read');
  });

  it('reports binary and directory entries per-file without throwing', async () => {
    const { dir, ctx } = makeWorkspace();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0xff]));
    const out = await runReadFile({ paths: ['blob.bin', 'src', 'src/a.ts'] }, ctx);
    expect(out).toContain('looks binary');
    expect(out).toContain('is a directory');
    expect(out).toContain(`### ${p('src', 'a.ts')}`);
  });

  it('enforces a SHARED character budget across the batch', async () => {
    const { dir, ctx } = makeWorkspace();
    // Two 70,000-char files fill the 120,000-char shared budget (60k cap each).
    writeFileSync(join(dir, 'big1.txt'), 'x'.repeat(70_000));
    writeFileSync(join(dir, 'big2.txt'), 'y'.repeat(70_000));
    const out = await runReadFile({ paths: ['big1.txt', 'big2.txt', 'src/a.ts'] }, ctx);
    expect(out).toMatch(/big1\.txt[\s\S]*?truncated — continue at offset/);
    expect(out).toMatch(/big2\.txt[\s\S]*?truncated — continue at offset/);
    // The third file is honest about why it wasn't read.
    expect(out).toContain(`${p('src', 'a.ts')} — not read (batch budget exhausted`);
  });

  it('reports a continuation offset for a truncated batch entry', async () => {
    const { dir, ctx } = makeWorkspace();
    writeFileSync(join(dir, 'big.txt'), 'z'.repeat(70_000));
    const out = await runReadFile({ paths: ['big.txt'] }, ctx);
    expect(out).toContain('truncated — continue at offset');
  });

  it('rejects an empty batch cleanly', async () => {
    const { ctx } = makeWorkspace();
    expect(await runReadFile({ paths: [] }, ctx)).toContain("pass 'path'");
    expect(await runReadFile({}, ctx)).toContain("pass 'path'");
  });

  it('still returns the legacy single-file shape when only `path` is given', async () => {
    const { ctx } = makeWorkspace();
    const out = await runReadFile({ path: 'src/a.ts' }, ctx);
    expect(out).toContain(`read_file: ${p('src', 'a.ts')} (1 lines`);
    expect(out).not.toContain('### ');
  });
});

describe('edit_file — transactional multi-pair edits', () => {
  it('applies several replacements in ONE confirmed call', async () => {
    const { dir, ctx } = makeWorkspace();
    const out = await runEditFile(
      {
        path: 'src/b.ts',
        replacements: [
          { old_string: 'const b = 2', new_string: 'const b = 20' },
          { old_string: 'const b2 = 3', new_string: 'const b2 = 30' },
        ],
        confirm: true,
      },
      ctx,
    );
    expect(out).toContain('applied 2 replacement(s)');
    expect(out).toContain('2 → 2 lines');
    const content = readFileSync(join(dir, 'src', 'b.ts'), 'utf-8');
    expect(content).toContain('const b = 20');
    expect(content).toContain('const b2 = 30');
  });

  it('is ALL-OR-NOTHING: one failing pair writes NOTHING', async () => {
    const { dir, ctx } = makeWorkspace();
    const before = readFileSync(join(dir, 'src', 'b.ts'), 'utf-8');
    const out = await runEditFile(
      {
        path: 'src/b.ts',
        replacements: [
          { old_string: 'const b = 2', new_string: 'const b = 20' },
          { old_string: 'THIS DOES NOT EXIST', new_string: 'x' },
        ],
        confirm: true,
      },
      ctx,
    );
    expect(out).toContain('NO changes applied');
    expect(out).toContain('All-or-nothing');
    expect(out).toContain('not found');
    // The file is byte-identical — the first pair did NOT sneak through.
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf-8')).toBe(before);
  });

  it('is all-or-nothing when a pair is ambiguous', async () => {
    const { dir, ctx } = makeWorkspace();
    writeFileSync(join(dir, 'dup.txt'), 'foo\nfoo\nbar\n');
    const out = await runEditFile(
      {
        path: 'dup.txt',
        replacements: [
          { old_string: 'bar', new_string: 'BAR' },
          { old_string: 'foo', new_string: 'FOO' }, // ambiguous, no allow_multiple
        ],
        confirm: true,
      },
      ctx,
    );
    expect(out).toContain('NO changes applied');
    expect(out).toContain('ambiguous');
    expect(readFileSync(join(dir, 'dup.txt'), 'utf-8')).toBe('foo\nfoo\nbar\n');
  });

  it('applies replacements against the EVOLVING content (pair 2 sees pair 1)', async () => {
    const { dir, ctx } = makeWorkspace();
    writeFileSync(join(dir, 'chain.txt'), 'start\n');
    const out = await runEditFile(
      {
        path: 'chain.txt',
        replacements: [
          { old_string: 'start', new_string: 'middle' },
          { old_string: 'middle', new_string: 'end' },
        ],
        confirm: true,
      },
      ctx,
    );
    expect(out).toContain('applied 2 replacement(s)');
    expect(readFileSync(join(dir, 'chain.txt'), 'utf-8')).toBe('end\n');
  });

  it('includes a unified diff and per-replacement line spans in the result', async () => {
    const { ctx } = makeWorkspace();
    const out = await runEditFile(
      {
        path: 'src/b.ts',
        replacements: [
          { old_string: 'const b = 2', new_string: 'const b = 20' },
          { old_string: 'const b2 = 3', new_string: 'const b2 = 30' },
        ],
        confirm: true,
      },
      ctx,
    );
    expect(out).toContain(`--- ${p('src', 'b.ts')}`);
    expect(out).toContain(`+++ ${p('src', 'b.ts')}`);
    expect(out).toContain('-export const b = 2;');
    expect(out).toContain('+export const b = 20;');
    expect(out).toMatch(/✓ #1 line 1/);
    expect(out).toMatch(/✓ #2 line 2/);
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const { dir, ctx } = makeWorkspace();
    await runEditFile(
      { path: 'src/b.ts', replacements: [{ old_string: 'const b = 2', new_string: 'const b = 20' }], confirm: true },
      ctx,
    );
    const leftovers = readdirSync(join(dir, 'src')).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('preserves the file mode across an atomic write', async () => {
    const { dir, ctx } = makeWorkspace();
    const target = join(dir, 'src', 'b.ts');
    chmodSync(target, 0o640);
    await runEditFile(
      { path: 'src/b.ts', replacements: [{ old_string: 'const b = 2', new_string: 'const b = 20' }], confirm: true },
      ctx,
    );
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });
});

describe('edit_file — dry_run preview', () => {
  it('previews a multi-pair change with a diff and writes nothing (no confirm)', async () => {
    const { dir, ctx } = makeWorkspace();
    const before = readFileSync(join(dir, 'src', 'b.ts'), 'utf-8');
    const out = await runEditFile(
      {
        path: 'src/b.ts',
        replacements: [
          { old_string: 'const b = 2', new_string: 'const b = 20' },
          { old_string: 'const b2 = 3', new_string: 'const b2 = 30' },
        ],
        dry_run: true,
      },
      ctx,
    );
    expect(out).toContain('dry_run');
    expect(out).toContain('nothing written');
    expect(out).toContain('+export const b = 20;');
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf-8')).toBe(before);
  });

  it('reports validation failure on dry_run without writing', async () => {
    const { dir, ctx } = makeWorkspace();
    const before = readFileSync(join(dir, 'src', 'b.ts'), 'utf-8');
    const out = await runEditFile(
      { path: 'src/b.ts', replacements: [{ old_string: 'nope', new_string: 'x' }], dry_run: true },
      ctx,
    );
    expect(out).toContain('NO changes applied');
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf-8')).toBe(before);
  });
});

describe('edit_file — confirmation gate for multi-pair calls', () => {
  it('refuses a multi-pair edit without confirm, citing the count', async () => {
    const { dir, ctx } = makeWorkspace();
    const out = await runEditFile(
      {
        path: 'src/b.ts',
        replacements: [
          { old_string: 'const b = 2', new_string: 'const b = 20' },
          { old_string: 'const b2 = 3', new_string: 'const b2 = 30' },
        ],
      },
      ctx,
    );
    expect(out).toContain('state-changing');
    expect(out).toContain('ask_user');
    expect(out).toContain('confirm:true');
    expect(out).toContain('2 replacements');
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf-8')).toContain('const b = 2;');
  });

  it('refuses an edit with no replacement at all', async () => {
    const { ctx } = makeWorkspace();
    const out = await runEditFile({ path: 'src/b.ts', confirm: true }, ctx);
    expect(out).toContain('no replacement given');
  });

  it('deny-first still applies to the multi-pair form', async () => {
    const { ctx } = makeWorkspace();
    const out = await runEditFile(
      { path: '../escape.txt', replacements: [{ old_string: 'a', new_string: 'b' }], confirm: true },
      ctx,
    );
    expect(out).toContain('denied');
  });
});
