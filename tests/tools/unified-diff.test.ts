/**
 * Unit tests for the bounded unified-diff module.
 *
 * The strongest check is the RECONSTRUCTION property: applying the edit
 * script to `a` must reproduce `b` exactly. That catches any backtracking
 * bug in the Myers implementation far better than eyeballing a hunk.
 */

import { describe, it, expect } from 'vitest';

import { diffLines, formatUnifiedDiff } from '../../src/tools/unified-diff.js';

/** Rebuild `b` from `a` + the edit script; throws if the script is inconsistent. */
function applyOps(a: string[], ops: ReturnType<typeof diffLines>): string[] {
  if (!ops) throw new Error('null ops');
  const out: string[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.type === 'eq') {
      if (a[i] !== op.line) throw new Error(`eq mismatch at ${i}: ${a[i]} !== ${op.line}`);
      out.push(op.line);
      i += 1;
    } else if (op.type === 'del') {
      if (a[i] !== op.line) throw new Error(`del mismatch at ${i}: ${a[i]} !== ${op.line}`);
      i += 1;
    } else {
      out.push(op.line);
    }
  }
  if (i !== a.length) throw new Error(`consumed ${i} of ${a.length} source lines`);
  return out;
}

describe('diffLines — reconstruction property', () => {
  const cases: Array<[string[], string[]]> = [
    [[], []],
    [['a'], ['a']],
    [['a'], ['b']],
    [['a', 'b', 'c'], ['a', 'x', 'c']],
    [['a', 'c'], ['a', 'b', 'c']],
    [['a', 'b', 'c'], ['a', 'c']],
    [['a', 'b', 'c', 'd'], ['a', 'd']],
    [['x', 'a', 'b', 'y'], ['x', 'y']],
    [['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'X', 'd', 'e', 'Z']],
    [['one', 'two', 'three'], ['one', 'three']],
    [[], ['a', 'b']],
    [['a', 'b'], []],
    [['same', 'same', 'same'], ['same', 'same']],
  ];

  for (const [a, b] of cases) {
    it(`reconstructs [${a.join(',')}] → [${b.join(',')}]`, () => {
      const ops = diffLines(a, b);
      expect(ops).not.toBeNull();
      expect(applyOps(a, ops)).toEqual(b);
    });
  }

  it('reconstructs a randomized batch deterministically', () => {
    // Deterministic PRNG so the test is reproducible.
    let seed = 123456789;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 200; trial++) {
      const a = Array.from({ length: rand(30) }, () => String.fromCharCode(97 + rand(5)));
      const b = Array.from({ length: rand(30) }, () => String.fromCharCode(97 + rand(5)));
      const ops = diffLines(a, b);
      expect(ops, `trial ${trial}`).not.toBeNull();
      expect(applyOps(a, ops), `trial ${trial}`).toEqual(b);
    }
  });
});

describe('formatUnifiedDiff', () => {
  it('returns null when nothing changed', () => {
    expect(formatUnifiedDiff(['a', 'b'], ['a', 'b'], { path: 'f.ts' })).toBeNull();
  });

  it('renders a replace hunk with headers and +/- lines', () => {
    const diff = formatUnifiedDiff(['a', 'b', 'c'], ['a', 'x', 'c'], { path: 'f.ts' });
    expect(diff).toContain('--- f.ts');
    expect(diff).toContain('+++ f.ts');
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('-b');
    expect(diff).toContain('+x');
    expect(diff).toContain(' a'); // context line
  });

  it('renders pure insertions and deletions', () => {
    const ins = formatUnifiedDiff(['a', 'c'], ['a', 'b', 'c'], { path: 'f.ts' });
    expect(ins).toContain('+b');
    expect(ins).not.toContain('-b');
    const del = formatUnifiedDiff(['a', 'b', 'c'], ['a', 'c'], { path: 'f.ts' });
    expect(del).toContain('-b');
  });

  it('splits distant changes into separate hunks', () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[2] = 'CHANGED-A';
    newLines[37] = 'CHANGED-B';
    const diff = formatUnifiedDiff(oldLines, newLines, { path: 'f.ts' });
    expect(diff).not.toBeNull();
    const hunkCount = (diff!.match(/^@@/gm) ?? []).length;
    expect(hunkCount).toBe(2);
    expect(diff).toContain('-line2');
    expect(diff).toContain('+CHANGED-A');
    expect(diff).toContain('-line37');
    expect(diff).toContain('+CHANGED-B');
  });

  it('skips diffing when the inputs exceed the size bound (returns null)', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`);
    const big2 = [...big, ...Array.from({ length: 3000 }, (_, i) => `m${i}`)];
    expect(formatUnifiedDiff(big, big2, { path: 'big.ts' })).toBeNull();
  });
});
