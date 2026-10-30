/**
 * Output caps — a truncated result must say WHAT it lost and WHAT TO DO instead.
 *
 * The measured failure this pins (2026-10-25 Cline head-to-head): `run_terminal`
 * returned 6 000 chars while Cline returned 48 000, so a failing suite showed its
 * first few failures and not its verdict. The model's response was to run the
 * command again with a different filter — the waste guard's own comment records
 * `npm test` run four times in one turn. Raising the window removes most of the
 * reason; the notice removes the rest, because it names the narrowing command
 * instead of leaving the model to guess.
 */

import { describe, it, expect } from 'vitest';
import {
  READ_OUTPUT_CAP,
  SEARCH_OUTPUT_CAP,
  TERMINAL_OUTPUT_CAP,
  windowOutput,
} from '../../src/tools/output-caps.js';

const big = (n: number): string => 'x'.repeat(n);

describe('output caps — the numbers', () => {
  it('gives a command a window big enough to include its verdict', () => {
    expect(TERMINAL_OUTPUT_CAP).toBe(24_000);
    // Cline keeps 48 K; we keep half of that and both ends.
    expect(TERMINAL_OUTPUT_CAP).toBeGreaterThanOrEqual(20_000);
    expect(SEARCH_OUTPUT_CAP).toBeGreaterThanOrEqual(20_000);
    expect(READ_OUTPUT_CAP).toBeGreaterThanOrEqual(TERMINAL_OUTPUT_CAP);
  });
});

describe('windowOutput', () => {
  it('passes a result that fits through untouched', () => {
    const out = windowOutput('hello', 100);
    expect(out).toEqual({ text: 'hello', omittedChars: 0, truncated: false });
  });

  it('normalises CRLF so a Windows command reads the same', () => {
    expect(windowOutput('a\r\nb', 100).text).toBe('a\nb');
  });

  it('keeps BOTH ends and never exceeds the cap by more than the notice', () => {
    const out = windowOutput(big(100_000), 24_000);
    expect(out.truncated).toBe(true);
    expect(out.omittedChars).toBeGreaterThan(0);
    // The kept body is exactly the cap…
    expect(out.text.length).toBeGreaterThanOrEqual(24_000);
    // …and the notice is bounded (not a second copy of the output).
    expect(out.text.length).toBeLessThan(24_000 + 500);
    // Head and tail are both present: the first lines say what ran, the last
    // lines carry the verdict.
    expect(out.text.startsWith('x')).toBe(true);
    expect(out.text.endsWith('x')).toBe(true);
  });

  it('names what it dropped, from which tool, and how to narrow instead of re-running', () => {
    const out = windowOutput(big(50_000), 10_000, { tool: 'run_terminal' });
    expect(out.text).toContain('characters omitted');
    expect(out.text).toContain("from run_terminal's output");
    expect(out.text).toContain('kept the first');
    expect(out.text).toContain('do NOT re-run this command to see more');
    expect(out.text).toContain('grep -n');
    expect(out.text).toContain('sed -n');
    // The omitted count is the arithmetic truth, not a guess.
    expect(out.text).toContain((50_000 - 10_000).toLocaleString('en-US'));
  });

  it('accepts a tool-specific hint (a file read has no command to narrow)', () => {
    const out = windowOutput(big(100_000), 10_000, {
      tool: 'read_file',
      hint: 'page it with offset/limit',
    });
    expect(out.text).toContain('page it with offset/limit');
    expect(out.text).not.toContain('do NOT re-run this command');
  });

  it('treats a non-positive cap as "no truncation" rather than emitting an empty result', () => {
    expect(windowOutput('abc', 0).text).toBe('abc');
  });
});
