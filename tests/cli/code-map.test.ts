/**
 * `nuvira code-map` (revamp row 11) — symbol-map builder tests.
 *
 * Exercises buildCodeMap + formatCodeMap against a hermetic temp project:
 *   - finds symbols (functions, classes, methods) with line numbers
 *   - skips ignored dirs (node_modules) and unknown extensions
 *   - never throws on unreadable content
 *   - human + JSON renderings are deterministic
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodeMap,
  buildCodeMapCached,
  clearCodeMapCache,
  countSourceFiles,
  formatCodeMap,
  formatCodeMapBrief,
  type CodeMap,
} from '../../src/cli/code-map.js';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'buff-codemap-'));
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'auth', 'middleware.ts'),
    'export function verifyToken(token: string): boolean {\n' +
      '  return token.length > 0;\n' +
      '}\n' +
      '\n' +
      'export class JwtMiddleware {\n' +
      '  constructor(private secret: string) {}\n' +
      '  verify(req: any): boolean {\n' +
      '    return verifyToken(req.token);\n' +
      '  }\n' +
      '}\n',
  );
  writeFileSync(join(root, 'src', 'util.py'), 'def helper():\n    return 1\n');
  writeFileSync(join(root, 'node_modules', 'x', 'ignored.ts'), 'export const ignored = 1;\n');
  writeFileSync(join(root, 'README.md'), 'not source\n');
  return root;
}

describe('code-map — buildCodeMap', () => {
  it('finds functions, classes and methods with 1-based line numbers', () => {
    const root = makeProject();
    try {
      const map = buildCodeMap(root);
      expect(map.totalFiles).toBe(3); // all files (node_modules excluded, README.md now counted)
      const middleware = map.files.find((f) => f.path === 'src/auth/middleware.ts');
      expect(middleware).toBeDefined();
      const names = middleware!.symbols.map((s) => `${s.type}:${s.name}:${s.line}`);
      // function verifyToken on line 1, class JwtMiddleware on line 5,
      // constructor method on line 6 (1-based lines — Session 47 engine fix
      // also recovered exported top-level functions that the generic `name(`
      // pattern used to shadow).
      expect(names).toContain('function:verifyToken:1');
      expect(names).toContain('class:JwtMiddleware:5');
      expect(names).toContain('method:constructor:6');
      const py = map.files.find((f) => f.path === 'src/util.py');
      expect(py?.symbols.some((s) => s.type === 'function' && s.name === 'helper' && s.line === 1)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never throws on unreadable/unsupported content', () => {
    const root = makeProject();
    try {
      // Binary-looking content in a source file must not break the map.
      writeFileSync(join(root, 'src', 'broken.ts'), '\u0000\u0001\u0002binary');
      const map: CodeMap = buildCodeMap(root);
      expect(map.totalFiles).toBeGreaterThanOrEqual(2);
      expect(map.totalSymbols).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A map is OF THE SOURCE. Generated and minified files are not mapped, and the
   * output says so, rather than silently looking like the file is not there.
   *
   * MEASURED (2026-10-16): mapping the dashboard's own committed 1.5 MB bundle
   * took 64 s in `analyzeStructure` (93% of it converting positions), and the
   * dashboard builds this map SYNCHRONOUSLY while answering a chat request — so
   * those 64 s were 64 s of "Could not reach the dashboard server." for whoever
   * had attached the project.
   */
  it('does not map generated/minified files, and says so', () => {
    const root = makeProject();
    try {
      // A bundle: one enormous line (the shape that wedged the dashboard).
      writeFileSync(join(root, 'src', 'bundle.js'), 'var a=1;'.repeat(60_000));
      // A generated file: oversized whatever its line shape.
      writeFileSync(join(root, 'src', 'big.ts'), 'export const x = 1;\n'.repeat(30_000));

      const map = buildCodeMap(root);
      const mapped = map.files.map((f) => f.path);
      expect(map.skipped).toContain('src/bundle.js');
      expect(map.skipped).toContain('src/big.ts');
      expect(mapped).not.toContain('src/bundle.js');
      expect(mapped).not.toContain('src/big.ts');
      // They still COUNT as project files (they are there) — only unmapped.
      expect(map.totalFiles).toBeGreaterThanOrEqual(5);
      // The source next to them is unaffected.
      expect(mapped).toContain('src/auth/middleware.ts');
      expect(map.totalSymbols).toBeGreaterThan(0);

      const text = formatCodeMap(map);
      expect(text).toContain('2 generated/oversized file(s) not mapped');
      expect(text).not.toContain('src/bundle.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('formatCodeMap renders a deterministic human-readable tree', () => {
    const root = makeProject();
    try {
      const text = formatCodeMap(buildCodeMap(root));
      expect(text).toContain('📦 Code Map —');
      expect(text).toContain('3 file(s)');
      expect(text).toContain('src/auth/middleware.ts');
      expect(text).toContain('verifyToken');
      expect(text).toContain('(1:1)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The bounded pre-check: "can we afford a map?" must not cost a map.
 *
 * MEASURED (2026-10-16): walking this repository's 1 568 source files is ~10 ms;
 * PARSING them through the AST engine is 4 440 ms. The ambient context asks the
 * count first, so a project past the map budget is never paid for at all.
 */
describe('code-map — countSourceFiles', () => {
  it('counts only mapped source files, not docs or dependencies', () => {
    const root = makeProject();
    try {
      // middleware.ts + util.py (README.md and node_modules are not source).
      expect(countSourceFiles(root)).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns 0 for a directory that cannot be walked', () => {
    expect(countSourceFiles(join(tmpdir(), 'nuvira-no-such-dir-9999'))).toBe(0);
  });
});

/**
 * The memo. Before it, every caller paid the full walk + parse again: 4 440 ms
 * per call on this repository's 1 568 files, which a per-turn context build
 * cannot afford.
 */
describe('code-map — buildCodeMapCached', () => {
  it('serves the SAME map for an unchanged tree (no second parse)', () => {
    clearCodeMapCache();
    const root = makeProject();
    try {
      const first = buildCodeMapCached(root);
      const second = buildCodeMapCached(root);
      expect(second).toBe(first); // identity, not equality: nothing was rebuilt
      expect(second.totalSymbols).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      clearCodeMapCache();
    }
  });

  it('rebuilds when the tree changed', async () => {
    clearCodeMapCache();
    const root = makeProject();
    try {
      const first = buildCodeMapCached(root);
      // A new file AND a touched file — the signature moves on either.
      writeFileSync(join(root, 'src', 'added.ts'), 'export function added(): number {\n  return 1;\n}\n');
      await new Promise((r) => setTimeout(r, 10)); // let the mtime move
      const second = buildCodeMapCached(root);
      expect(second).not.toBe(first);
      expect(second.files.map((f) => f.path)).toContain('src/added.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
      clearCodeMapCache();
    }
  });
});

/**
 * The prompt-sized rendering: one line per file, capped, and every cap STATED.
 * A cap nobody can see reads as "this file has no symbols".
 */
describe('code-map — formatCodeMapBrief', () => {
  it('lists files with their symbols and line numbers, compactly', () => {
    const root = makeProject();
    try {
      const brief = formatCodeMapBrief(buildCodeMap(root));
      expect(brief).toContain('## Symbol map');
      expect(brief).toContain('src/auth/middleware.ts');
      expect(brief).toContain('verifyToken[function@1]');
      expect(brief).toContain('JwtMiddleware[class@5]');
      // No icons and no per-symbol lines: this is a model-facing digest, not the
      // human tree `formatCodeMap` prints.
      expect(brief).not.toContain('📦');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('states every cap it applies', () => {
    const root = mkdtempSync(join(tmpdir(), 'buff-codemap-caps-'));
    try {
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(root, `f${i}.ts`), 'export function a(): number { return 1; }\nexport function b(): number { return 2; }\n');
      }
      const brief = formatCodeMapBrief(buildCodeMap(root), { maxFiles: 2, maxSymbolsPerFile: 1 });
      expect(brief).toContain('3 more file(s) not listed');
      expect(brief).toContain('…+1 more');
      // Only two files were listed (a file line carries symbols in brackets;
      // the summary and the "more files" note carry none).
      expect(brief.split('\n').filter((l) => /^ {2}\S.*\[/.test(l))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
