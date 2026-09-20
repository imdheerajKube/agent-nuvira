/**
 * P3 — Project context builder tests (DASHBOARD_FIRST_PLAN Phase 3).
 *
 * The bounded snapshot must: include the real code map + tree from the AST
 * engine, be DETERMINISTIC (sorted paths — readdir order is OS-dependent),
 * respect the size caps with a visible truncation footer, and reject
 * non-directories. Uses a temp fixture dir (no real project needed).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProjectContext, formatProjectText } from '../../src/web-dashboard/project-context.js';

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buff-project-ctx-'));
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    'export function main(): void {\n  console.log("hi");\n}\n\nexport class App {}\n',
  );
  writeFileSync(
    join(dir, 'src', 'utils', 'helper.ts'),
    'export interface Helper { id: string }\nexport const helper: Helper = { id: "x" };\n',
  );
  writeFileSync(join(dir, 'tests', 'index.test.ts'), 'import { main } from "../src/index";\nmain();\n');
  return dir;
}

describe('buildProjectContext', () => {
  it('builds a bounded snapshot with the code map + tree from the AST engine', () => {
    const dir = makeFixture();
    try {
      const bundle = buildProjectContext(dir);
      expect(bundle).toBeTruthy();
      expect(bundle!.fileCount).toBe(3);
      expect(bundle!.symbolCount).toBeGreaterThanOrEqual(3); // main + helpers
      expect(bundle!.name).toBe(bundle!.path.split(/[/\\]/).pop());

      // The tree lists the top-level dirs and files (paths are /-joined).
      expect(bundle!.fileTree).toContain('src/');
      expect(bundle!.fileTree).toContain('utils/');
      expect(bundle!.fileTree).toContain('index.ts');
      expect(bundle!.fileTree).toContain('tests/');

      // The map names the symbols with line numbers.
      expect(bundle!.codeMap).toContain('src/index.ts');
      expect(bundle!.codeMap).toContain('main');
      expect(bundle!.codeMap).toContain('src/utils/helper.ts');
      expect(bundle!.codeMap).toContain('line 1');
      expect(bundle!.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatProjectText assembles the injected [Project context] body', () => {
    const dir = makeFixture();
    try {
      const bundle = buildProjectContext(dir)!;
      const text = formatProjectText(bundle);
      expect(text).toContain(`Project: ${bundle.name}`);
      expect(text).toContain('## File tree');
      expect(text).toContain('## Symbol map');
      expect(text).toContain(`Files: ${bundle.fileCount}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic — same project yields identical output across builds', () => {
    const dir = makeFixture();
    try {
      const a = buildProjectContext(dir)!;
      const b = buildProjectContext(dir)!;
      expect(a.codeMap).toBe(b.codeMap);
      expect(a.fileTree).toBe(b.fileTree);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects the size caps with a truncation footer', () => {
    const dir = makeFixture();
    try {
      const bundle = buildProjectContext(dir, { maxFiles: 1, maxSymbols: 1 })!;
      expect(bundle.truncated).toBe(true);
      expect(bundle.fileTree).toContain('more file(s)');
      // The symbol cap kicks in: the map says "N more symbol(s)".
      expect(bundle.codeMap).toMatch(/more symbol\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes bounded GIT STATE (parity with the CLI ambient context)', () => {
    const dir = makeFixture();
    try {
      let gitAvailable = true;
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
      } catch {
        gitAvailable = false;
      }
      if (!gitAvailable) return;
      // A dirty file → the digest reports it.
      writeFileSync(join(dir, 'src', 'dirty.ts'), 'export const dirty = 1;\n');
      const bundle = buildProjectContext(dir)!;
      expect(bundle.gitState).toContain('## Git state');
      expect(bundle.gitState).toContain('uncommitted change');
      const text = formatProjectText(bundle);
      expect(text).toContain('## Git state');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing paths and non-directories', () => {
    expect(buildProjectContext('/no/such/dir/anywhere')).toBeNull();
    const dir = makeFixture();
    try {
      writeFileSync(join(dir, 'a-file.txt'), 'not a dir');
      expect(buildProjectContext(join(dir, 'a-file.txt'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
