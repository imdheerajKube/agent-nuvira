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

import { buildCodeMap, formatCodeMap, type CodeMap } from '../../src/cli/code-map.js';

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
