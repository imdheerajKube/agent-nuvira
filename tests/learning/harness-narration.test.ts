/**
 * Bundle 39 — harness-narration detection.
 *
 * The detector flags an answer that reuses a DISTINCTIVE token from the
 * harness's own text (a hyphenated compound or a ≥10-char word). No phrase list.
 */

import { describe, it, expect } from 'vitest';
import { detectHarnessNarration } from '../../src/learning/harness-narration.js';

describe('detectHarnessNarration', () => {
  it('flags an answer that quotes the harness vocabulary', () => {
    const harness = [
      'Error: run_terminal: "wc -w NOTES.md" is state-changing and needs explicit confirmation',
    ];
    const answer =
      'Note on method: the earlier command was blocked as state-changing (a guard misfire on a read-only check).';
    const v = detectHarnessNarration(answer, harness);
    expect(v.narrated).toBe(true);
    expect(v.matches).toContain('state-changing');
  });

  it('does NOT flag an answer that talks about the work, not the harness', () => {
    const harness = [
      'Error: run_terminal: "wc -w NOTES.md" is state-changing and needs explicit confirmation',
    ];
    const answer = 'NOTES.md is created with the Introduction section, and I appended Design next.';
    expect(detectHarnessNarration(answer, harness).narrated).toBe(false);
  });

  it('is inert with no harness text', () => {
    expect(detectHarnessNarration('state-changing permission gate', []).narrated).toBe(false);
    expect(detectHarnessNarration('state-changing permission gate', [null, undefined]).narrated).toBe(false);
  });

  it('ignores short common words (no accidental matches)', () => {
    const v = detectHarnessNarration('the file is written and verified', ['the file is written']);
    expect(v.narrated).toBe(false);
  });
});
