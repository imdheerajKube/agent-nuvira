/**
 * F2 — Code search helper tests (`src/utils/code-search.ts`).
 *
 * Uses a small fixture tree + the REAL bundled ripgrep binary (@vscode/ripgrep)
 * plus the pure-JS fallback — both engines must agree on what they find.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { searchCode, resolveRipgrepBinary } from '../../src/utils/code-search.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'code-search-test-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'src', 'nested'));
  mkdirSync(join(dir, 'node_modules'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'src', 'main.ts'), [
    'const greeting = "hello world";',
    'function hello(name: string) { return `hello ${name}`; }',
    'const other = 42;',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'src', 'nested', 'util.ts'), 'export const hello = 1;\nconst other = 2;\n');
  writeFileSync(join(dir, 'README.md'), '# hello project\nWelcome.\n');
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'const hello = "should be ignored";\n');
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'const hello = "should be ignored too";\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveRipgrepBinary', () => {
  it('resolves a runnable ripgrep binary (bundled or PATH)', () => {
    const binary = resolveRipgrepBinary();
    expect(binary).toBeTruthy();
  });
});

describe('searchCode — ripgrep engine', () => {
  it('finds matches with file:line:column + text, excluding default-ignored dirs', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'ripgrep' });
    expect(res.engine).toBe('ripgrep');
    expect(res.error).toBeUndefined();
    // One match object per LINE: main.ts line1 ("hello world") + line2
    // (function hello) = 2, nested/util.ts 1, README.md 1 = 4. node_modules
    // and dist are excluded by the default ignore list.
    expect(res.matches.length).toBe(4);
    expect(res.matches.some((m) => m.file === 'node_modules/dep.js')).toBe(false);
    expect(res.matches.some((m) => m.file === 'dist/bundle.js')).toBe(false);

    const main = res.matches.find((m) => m.file === 'src/main.ts')!;
    expect(main).toBeDefined();
    expect(main.line).toBe(1);
    expect(main.column).toBeGreaterThan(0);
    expect(main.text).toContain('hello');
    expect(main.matchText).toBe('hello');
  });

  it('respects include globs', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'ripgrep', globs: ['src/**'] });
    expect(res.matches.every((m) => m.file.startsWith('src/'))).toBe(true);
    expect(res.matches.length).toBe(3); // main.ts x2 + nested/util.ts x1
  });

  it('respects exclude globs', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'ripgrep', globs: ['!**/*.ts'] });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0].file).toBe('README.md');
  });

  it('respects case sensitivity', async () => {
    const sensitive = await searchCode('HELLO', { cwd: dir, engine: 'ripgrep', caseSensitive: true });
    expect(sensitive.matches.length).toBe(0);
    const insensitive = await searchCode('HELLO', { cwd: dir, engine: 'ripgrep' });
    expect(insensitive.matches.length).toBeGreaterThan(0);
  });

  it('respects whole-word matching', async () => {
    const whole = await searchCode('hell', { cwd: dir, engine: 'ripgrep', wholeWord: true });
    expect(whole.matches.length).toBe(0);
    const partial = await searchCode('hell', { cwd: dir, engine: 'ripgrep' });
    expect(partial.matches.length).toBeGreaterThan(0);
  });

  it('truncates at maxResults', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'ripgrep', maxResults: 2 });
    expect(res.matches.length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('returns an error for an invalid regex instead of throwing', async () => {
    const res = await searchCode('[', { cwd: dir, engine: 'ripgrep' });
    expect(res.matches.length).toBe(0);
    expect(res.error).toBeTruthy();
  });
});

describe('searchCode — fs fallback engine', () => {
  it('finds the same matches as ripgrep', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'fs' });
    expect(res.engine).toBe('fs');
    expect(res.matches.length).toBe(4); // one match per line (first per line)
    expect(res.matches.some((m) => m.file === 'node_modules/dep.js')).toBe(false);
    expect(res.matches.some((m) => m.file === 'dist/bundle.js')).toBe(false);
  });

  it('respects include/exclude globs', async () => {
    const included = await searchCode('hello', { cwd: dir, engine: 'fs', globs: ['src/**'] });
    expect(included.matches.every((m) => m.file.startsWith('src/'))).toBe(true);
    const excluded = await searchCode('hello', { cwd: dir, engine: 'fs', globs: ['!**/*.ts'] });
    expect(excluded.matches.length).toBe(1);
    expect(excluded.matches[0].file).toBe('README.md');
  });

  it('respects case sensitivity and whole-word', async () => {
    const sensitive = await searchCode('HELLO', { cwd: dir, engine: 'fs', caseSensitive: true });
    expect(sensitive.matches.length).toBe(0);
    const whole = await searchCode('hell', { cwd: dir, engine: 'fs', wholeWord: true });
    expect(whole.matches.length).toBe(0);
  });

  it('treats an invalid regex as a literal (no throw)', async () => {
    // '[' is an invalid regex AND appears in no fixture file, so the literal
    // fallback also finds nothing.
    const res = await searchCode('[', { cwd: dir, engine: 'fs' });
    expect(res.matches.length).toBe(0);
    expect(res.error).toBeUndefined();
  });

  it('truncates at maxResults', async () => {
    const res = await searchCode('hello', { cwd: dir, engine: 'fs', maxResults: 2 });
    expect(res.matches.length).toBe(2);
    expect(res.truncated).toBe(true);
  });
});

describe('searchCode — auto engine', () => {
  it('uses ripgrep when a binary is available', async () => {
    const res = await searchCode('hello', { cwd: dir });
    expect(res.engine).toBe('ripgrep');
    expect(res.matches.length).toBe(4);
  });

  it('degrades to the fs engine when ripgrep cannot run the pattern', async () => {
    const res = await searchCode('[', { cwd: dir });
    // rg rejects the invalid regex → auto falls back to the fs walker, which
    // treats it as a literal → 0 matches, no error, never a throw.
    expect(res.engine).toBe('fs');
    expect(res.error).toBeUndefined();
  });
});
