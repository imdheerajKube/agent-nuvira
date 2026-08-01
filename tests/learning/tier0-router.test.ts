/**
 * Tests for Tier0Router — deterministic, $0 routing for mechanical edits.
 *
 * Coverage:
 * - detectTier0Intent — remove-console, rename-symbol, dedupe-import,
 *   non-matching goals, rename requires the symbol present in artifacts
 * - applyTier0Transform — console removal, symbol rename, import dedupe
 * - tryTier0Route — end-to-end short-circuit with FileChange output,
 *   syntax-validation guard, no-op fallthrough, multi-file rename
 */
import { describe, it, expect } from 'vitest';
import type { Artifact } from '../../src/agents/agent.js';
import {
  detectTier0Intent,
  applyTier0Transform,
  tryTier0Route,
} from '../../src/learning/tier0-router.js';

function artifact(path: string, content: string): Artifact {
  return { path, content, description: `${path}` };
}

// ─── detectTier0Intent ──────────────────────────────────────────────────────

describe('detectTier0Intent', () => {
  it('detects remove-console intents', () => {
    const intent = detectTier0Intent('remove all console.log statements', [artifact('a.ts', '')]);
    expect(intent?.type).toBe('remove-console');
    expect(intent!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects "clean up debug logging" as remove-console', () => {
    const intent = detectTier0Intent('clean up debug logging in this file', [artifact('a.ts', '')]);
    expect(intent?.type).toBe('remove-console');
  });

  it('detects rename-symbol when the symbol exists in an artifact', () => {
    const intent = detectTier0Intent(
      'rename foo to bar',
      [artifact('a.ts', 'function foo() { return 1; }')],
    );
    expect(intent?.type).toBe('rename-symbol');
    expect(intent?.params).toEqual({ oldName: 'foo', newName: 'bar' });
  });

  it('rejects rename when the old symbol is absent from all artifacts', () => {
    const intent = detectTier0Intent(
      'rename foo to bar',
      [artifact('a.ts', 'function baz() { return 1; }')],
    );
    expect(intent).toBeNull();
  });

  it('rejects renaming a symbol to itself', () => {
    const intent = detectTier0Intent('rename foo to foo', [artifact('a.ts', 'foo')]);
    expect(intent).toBeNull();
  });

  it('detects dedupe-import intents', () => {
    const intent = detectTier0Intent('remove duplicate imports', [artifact('a.ts', '')]);
    expect(intent?.type).toBe('dedupe-import');
  });

  it('returns null for non-mechanical goals', () => {
    expect(detectTier0Intent('implement JWT authentication with refresh tokens', [artifact('a.ts', '')])).toBeNull();
    expect(detectTier0Intent('design a microservices architecture', [artifact('a.ts', '')])).toBeNull();
  });

  it('returns null for empty goals or empty artifacts', () => {
    expect(detectTier0Intent('', [artifact('a.ts', '')])).toBeNull();
    // detectTier0Intent alone doesn't need artifacts (only rename verifies
    // symbol presence) — the artifact guard lives in tryTier0Route
    expect(tryTier0Route('remove console.log statements', [])).toBeNull();
  });

  it('bails on rename when the symbol appears in a multi-line template literal', () => {
    const content = 'const tpl = `\\n  the color is here\\n  ${color}\\n`;\nconst color = "red";';
    const intent = detectTier0Intent('rename color to colour', [artifact('a.ts', content)]);
    expect(intent).not.toBeNull();
    const result = applyTier0Transform(intent!, artifact('a.ts', content));
    expect(result).toBeNull();
  });
});

// ─── applyTier0Transform ────────────────────────────────────────────────────

describe('applyTier0Transform', () => {
  it('removes standalone console.log lines', () => {
    const content = [
      'function add(a, b) {',
      '  console.log("adding", a, b);',
      '  return a + b;',
      '}',
    ].join('\n');
    const result = applyTier0Transform(
      { type: 'remove-console', confidence: 1, params: {}, description: '' },
      artifact('a.ts', content),
    );
    expect(result).not.toBeNull();
    expect(result!.newContent).not.toContain('console.log');
    expect(result!.newContent).toContain('return a + b;');
  });

  it('keeps console statements inside expressions (non-standalone)', () => {
    const content = 'const x = condition ? console.log("a") : 1;';
    const result = applyTier0Transform(
      { type: 'remove-console', confidence: 1, params: {}, description: '' },
      artifact('a.ts', content),
    );
    // The line isn't a standalone console.* statement — unchanged
    expect(result).toBeNull();
  });

  it('returns null when there are no console statements', () => {
    const result = applyTier0Transform(
      { type: 'remove-console', confidence: 1, params: {}, description: '' },
      artifact('a.ts', 'export const x = 1;'),
    );
    expect(result).toBeNull();
  });

  it('renames a symbol across all references', () => {
    const content = [
      'function foo() { return 1; }',
      'const val = foo();',
      'console.log(foo());',
    ].join('\n');
    const result = applyTier0Transform(
      { type: 'rename-symbol', confidence: 1, params: { oldName: 'foo', newName: 'bar' }, description: '' },
      artifact('a.ts', content),
    );
    expect(result).not.toBeNull();
    expect(result!.newContent).toContain('function bar()');
    expect(result!.newContent).toContain('const val = bar();');
    expect(result!.newContent).not.toContain('foo');
  });

  it('dedupes exactly-identical import lines', () => {
    const content = [
      'import { a } from "./mod";',
      'import { a } from "./mod";',
      'import { c } from "./other";',
    ].join('\n');
    const result = applyTier0Transform(
      { type: 'dedupe-import', confidence: 1, params: {}, description: '' },
      artifact('a.ts', content),
    );
    expect(result).not.toBeNull();
    const imports = result!.newContent.split('\n').filter((l) => l.includes('from "./mod"'));
    expect(imports).toHaveLength(1);
    expect(result!.newContent).toContain('from "./other"');
  });

  it('does NOT dedupe same-module imports with different bindings (would break refs)', () => {
    // Dropping `import { b } from "./mod"` would leave every `b` reference undefined
    const content = [
      'import { a } from "./mod";',
      'import { b } from "./mod";',
    ].join('\n');
    const result = applyTier0Transform(
      { type: 'dedupe-import', confidence: 1, params: {}, description: '' },
      artifact('a.ts', content),
    );
    expect(result).toBeNull();
  });

  it('returns null when imports are already unique', () => {
    const content = 'import { a } from "./mod";\nimport { c } from "./other";';
    const result = applyTier0Transform(
      { type: 'dedupe-import', confidence: 1, params: {}, description: '' },
      artifact('a.ts', content),
    );
    expect(result).toBeNull();
  });

  it('refuses to rename symbols that appear inside strings or comments', () => {
    const content = 'const label = "color";\n// color is the theme\nconst color = "red";';
    const result = applyTier0Transform(
      { type: 'rename-symbol', confidence: 1, params: { oldName: 'color', newName: 'colour' }, description: '' },
      artifact('a.ts', content),
    );
    // Word-boundary rename would corrupt the string/comment — conservative bail
    expect(result).toBeNull();
  });
});

// ─── tryTier0Route ──────────────────────────────────────────────────────────

describe('tryTier0Route', () => {
  it('returns FileChanges with a summary for a mechanical goal', () => {
    const result = tryTier0Route(
      'remove all console.log statements',
      [artifact('src/a.ts', 'export const x = 1;\nconsole.log("hi");')],
    );
    expect(result).not.toBeNull();
    expect(result!.changes.length).toBe(1);
    expect(result!.changes[0].status).toBe('modified');
    expect(result!.changes[0].path).toBe('src/a.ts');
    expect(result!.changes[0].newContent).not.toContain('console.log');
    expect(result!.summary).toContain('Tier-0');
    expect(result!.changeCount).toBe(1);
  });

  it('uses full-line dedupe safely end-to-end', () => {
    const result = tryTier0Route(
      'remove duplicate imports',
      [artifact('src/a.ts', 'import { a } from "./mod";\nimport { a } from "./mod";\nexport const x = a;')],
    );
    expect(result).not.toBeNull();
    expect(result!.changeCount).toBe(1);
    const modImports = result!.changes[0].newContent!.split('\n').filter((l) => l.includes('from "./mod"'));
    expect(modImports).toHaveLength(1);
  });

  it('renames a symbol across multiple files', () => {
    const result = tryTier0Route(
      'rename helper to compute',
      [
        artifact('src/a.ts', 'export function helper() { return 1; }'),
        artifact('src/b.ts', 'import { helper } from "./a";'),
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.changes).toHaveLength(2);
    for (const c of result!.changes) {
      expect(c.newContent).not.toContain('helper');
    }
  });

  it('bails out when a transformed file fails syntax validation', () => {
    // Input is already unbalanced; the rename keeps it broken, so tier-0 must
    // conservatively fall through to the LLM path rather than emit bad code.
    const result = tryTier0Route(
      'rename foo to bar',
      [artifact('a.js', 'function foo() {')],
    );
    expect(result).toBeNull();
  });

  it('returns null when the goal is not mechanical', () => {
    const result = tryTier0Route(
      'implement JWT authentication with refresh tokens',
      [artifact('a.ts', 'export const x = 1;')],
    );
    expect(result).toBeNull();
  });

  it('returns null when no file is actually changed', () => {
    const result = tryTier0Route(
      'remove all console.log statements',
      [artifact('a.ts', 'export const x = 1;')],
    );
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(tryTier0Route('', [artifact('a.ts', 'x')])).toBeNull();
    expect(tryTier0Route('remove console.log', [])).toBeNull();
  });
});
