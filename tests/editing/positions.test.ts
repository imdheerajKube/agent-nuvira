/**
 * `editing/types.ts` — position conversion.
 *
 * `offsetToPosition` is the hot loop of every structural analysis (a code map
 * converts two positions per symbol it finds), so two properties are pinned here:
 *
 * 1. CORRECTNESS — it must agree with the plain "count the lines in the prefix"
 *    definition for every offset, including the edges: 0, negative, exactly on a
 *    `\n`, the end of the file, and past the end. Verified differentially,
 *    against that definition implemented inline.
 * 2. IT STAYS A SEARCH, NOT A SCAN. The measured failure: `analyzeStructure`
 *    over a 1.5 MB one-line bundle took 64 s, 93% of it inside this function
 *    (`code.slice(0, offset).split('\n')` per position). The dashboard builds a
 *    project map synchronously while answering a request, so those 64 s were 64 s
 *    in which it answered nothing — which reaches the user as "Could not reach
 *    the dashboard server." The guard below uses the same SHAPE that broke it (a
 *    large body with one enormous line) and fails by an order of magnitude if the
 *    per-call scan comes back.
 */

import { describe, it, expect } from 'vitest';
import { offsetToPosition, positionToOffset, type SourcePosition } from '../../src/editing/types.js';

/** The definition the implementation must agree with, written plainly. */
function referencePosition(code: string, offset: number): SourcePosition {
  if (offset <= 0) return { line: 1, column: 1 };
  const before = code.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Deterministic PRNG — the same bodies and offsets on every machine. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('offsetToPosition', () => {
  it('agrees with the plain definition on the edges', () => {
    const code = 'first\nsecond\nthird';
    expect(offsetToPosition(code, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition(code, -5)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition(code, 5)).toEqual(referencePosition(code, 5)); // on the \n
    expect(offsetToPosition(code, 6)).toEqual({ line: 2, column: 1 }); // just after it
    expect(offsetToPosition(code, code.length)).toEqual(referencePosition(code, code.length));
    // Past the end: the old arithmetic clamped (slice stopped at the end), so the
    // last line and its end column are still the answer.
    expect(offsetToPosition(code, code.length + 50)).toEqual(referencePosition(code, code.length + 50));
    expect(offsetToPosition('', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition('', 7)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition('\n', 1)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition('a\r\nb', 3)).toEqual({ line: 2, column: 1 }); // CRLF
  });

  it('agrees with the plain definition on randomized multi-line bodies', () => {
    const rand = makeRandom(7);
    const alphabet = ['a', 'b', ' ', '\n', '\n', '\t', 'é', '𝄞', '\r'];
    for (let body = 0; body < 25; body += 1) {
      let code = '';
      const length = 1 + Math.floor(rand() * 500);
      for (let i = 0; i < length; i += 1) code += alphabet[Math.floor(rand() * alphabet.length)];
      // Interleave bodies so the single-entry cache is exercised across files,
      // and re-query the same file — the result must not depend on call order.
      for (let i = 0; i < 40; i += 1) {
        const offset = Math.floor(rand() * (code.length + 20)) - 5;
        expect(offsetToPosition(code, offset)).toEqual(referencePosition(code, offset));
      }
    }
  });

  it('round-trips with positionToOffset', () => {
    const code = 'one\ntwo\nthree\n';
    for (let offset = 1; offset <= code.length; offset += 1) {
      const pos = offsetToPosition(code, offset);
      expect(positionToOffset(code, pos)).toBe(offset);
    }
  });

  it('converts positions in a large ONE-LINE body without scanning it per call', () => {
    // The shape that broke the dashboard: one very long line, many positions.
    const code = 'x'.repeat(1_500_000);
    const rand = makeRandom(99);
    const offsets: number[] = [];
    for (let i = 0; i < 15_000; i += 1) offsets.push(Math.floor(rand() * code.length));

    const started = Date.now();
    let lines = 0;
    for (const offset of offsets) lines += offsetToPosition(code, offset).line;
    const elapsed = Date.now() - started;

    expect(lines).toBe(offsets.length); // every offset is on line 1
    // 15k calls over a 1.5 MB body: ~30 ms here, ~10 s with the per-call scan.
    expect(elapsed).toBeLessThan(1500);
    // …and the answers are still the plain definition's.
    for (let i = 0; i < 200; i += 1) {
      const offset = offsets[i * 7];
      expect(offsetToPosition(code, offset)).toEqual(referencePosition(code, offset));
    }
  });
});
