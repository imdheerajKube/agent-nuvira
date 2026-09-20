/**
 * Bounded, dependency-free line diff (`src/tools/unified-diff.ts`).
 *
 * `edit_file` reports what it changed with a real unified diff, so the model
 * (and the dashboard) can see the exact edit without paying a re-read — the
 * same affordance Freebuff's `str_replace` gets from the `diff` package, but
 * WITHOUT adding a dependency: Myers' O(ND) greedy algorithm on lines.
 *
 * Bounds are deliberate and enforced here, not by the caller:
 * - `MAX_DIFF_LINES` caps the combined line count (a 50k-line file is not
 *   diffed — the caller falls back to a per-replacement summary).
 * - `MAX_DIFF_OPS` caps the edit distance; a pathological pair aborts to null
 *   rather than burning CPU.
 *
 * Pure and synchronous: no fs, no state. Every failure mode returns `null`
 * (never throws), so a diff can never break an edit that already succeeded.
 */

/** Combined (old + new) line count above which diffing is skipped. */
const MAX_DIFF_LINES = 4_000;
/** Edit-distance cap; a bigger change is summarized, not diffed. */
const MAX_DIFF_OPS = 2_000;

export type DiffOpType = 'eq' | 'del' | 'ins';

export interface DiffOp {
  type: DiffOpType;
  line: string;
}

/**
 * Shortest edit script between two arrays of lines (Myers greedy).
 * Returns `null` when the inputs exceed the bounds — callers must handle it.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n + m > MAX_DIFF_LINES) return null;

  // `v` is indexed by diagonal k in [-max, max], shifted by `offset`.
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    if (d > MAX_DIFF_OPS) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + offset;
      let x: number;
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
        x = v[ki + 1];
      } else {
        x = v[ki - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[ki] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }
  return null;
}

/** Walk the trace back into a forward-ordered edit script. */
function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): DiffOp[] {
  let x = a.length;
  let y = b.length;
  const ops: DiffOp[] = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const ki = k + offset;
    let prevK: number;
    if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    // Common suffix of this segment (walked backwards).
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', line: a[x - 1] });
      x -= 1;
      y -= 1;
    }

    if (d > 0) {
      if (x === prevX) {
        // A vertical move is an insertion of b[y-1].
        ops.push({ type: 'ins', line: b[y - 1] });
        y -= 1;
      } else {
        // A horizontal move is a deletion of a[x-1].
        ops.push({ type: 'del', line: a[x - 1] });
        x -= 1;
      }
    }
  }

  ops.reverse();
  return ops;
}

export interface UnifiedDiffOptions {
  /** File path shown in the `---`/`+++` headers. */
  path: string;
  /** Lines of unchanged context around each hunk (default 3). */
  context?: number;
}

/**
 * Render a unified diff (with `---`/`+++`, `@@` hunk headers, and context)
 * for two line arrays, or `null` when it exceeds the bounds.
 */
export function formatUnifiedDiff(
  oldLines: string[],
  newLines: string[],
  opts: UnifiedDiffOptions,
): string | null {
  const ops = diffLines(oldLines, newLines);
  if (ops === null) return null;
  if (ops.every((o) => o.type === 'eq')) return null; // no change → no diff

  const context = Math.max(0, opts.context ?? 3);
  const path = opts.path;

  // Group ops into hunks, splitting on runs of > 2*context unchanged lines.
  const hunks: Array<{ oldStart: number; oldLen: number; newStart: number; newLen: number; body: DiffOp[] }> = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < ops.length) {
    // Skip leading context beyond the previous hunk.
    if (ops[i].type === 'eq') {
      oldLine += 1;
      newLine += 1;
      i += 1;
      continue;
    }
    // Start of a change: back up for `context` preceding eq lines.
    let start = i;
    for (let back = 0; back < context && start > 0 && ops[start - 1].type === 'eq'; back += 1) {
      start -= 1;
    }
    let oldStart = oldLine - (i - start);
    let newStart = newLine - (i - start);

    // Extend to include `context` trailing eq lines after the last change.
    let end = i;
    let trailingEq = 0;
    while (end < ops.length) {
      if (ops[end].type === 'eq') {
        trailingEq += 1;
        if (trailingEq > context * 2) break;
      } else {
        trailingEq = 0;
      }
      end += 1;
    }
    // Trim the extra eq beyond `context` at the tail.
    let tail = end;
    let keep = 0;
    while (tail > start && ops[tail - 1].type === 'eq' && keep < context) {
      tail -= 1;
      keep += 1;
    }

    const body = ops.slice(start, tail);
    const oldLen = body.filter((o) => o.type !== 'ins').length;
    const newLen = body.filter((o) => o.type !== 'del').length;
    hunks.push({ oldStart, oldLen, newStart, newLen, body });

    // Advance cursors past this hunk.
    for (const o of body) {
      if (o.type !== 'ins') oldLine += 1;
      if (o.type !== 'del') newLine += 1;
    }
    i = tail;
  }

  if (hunks.length === 0) return null;

  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`);
    for (const o of h.body) {
      const prefix = o.type === 'eq' ? ' ' : o.type === 'del' ? '-' : '+';
      out.push(`${prefix}${o.line}`);
    }
  }
  return out.join('\n');
}
