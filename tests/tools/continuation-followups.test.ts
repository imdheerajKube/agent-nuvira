/**
 * A4 — the Continue / Retry affordance.
 *
 * A1/A3 make an unfinished run RECORD honestly; A4 is what lets the user act on
 * that record. An unfinished turn must offer a way back in, a concluded turn
 * must NOT (or the chips mean nothing), and the prompts must say "resume", not
 * "start over".
 */

import { describe, it, expect } from 'vitest';
import {
  withContinuationFollowups,
  CONTINUE_PROMPT,
  RETRY_PROMPT,
  MAX_FOLLOWUPS,
} from '../../src/tools/followup-utils.js';

describe('withContinuationFollowups', () => {
  it('leaves a CONCLUDED turn exactly as it was', () => {
    const base = [{ prompt: 'Add tests' }];
    expect(withContinuationFollowups(base, { unfinished: false })).toEqual(base);
    expect(withContinuationFollowups(base, {})).toEqual(base);
  });

  it('offers Continue first on an unfinished turn', () => {
    const out = withContinuationFollowups([{ prompt: 'Add tests' }], { unfinished: true });
    expect(out[0]?.label).toMatch(/Continue/);
    expect(out[0]?.prompt).toBe(CONTINUE_PROMPT);
  });

  it('adds Retry only when a tool actually ran', () => {
    const withTools = withContinuationFollowups([], { unfinished: true, hadTools: true });
    expect(withTools.map((f) => f.label).join(' ')).toMatch(/Retry/);

    const noTools = withContinuationFollowups([], { unfinished: true, hadTools: false });
    expect(noTools.map((f) => f.label).join(' ')).not.toMatch(/Retry/);
  });

  it('keeps the model suggestions within the cap', () => {
    const base = [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' }];
    const out = withContinuationFollowups(base, { unfinished: true, hadTools: true });
    expect(out.length).toBeLessThanOrEqual(MAX_FOLLOWUPS);
    // The affordance outranks the model's own suggestions.
    expect(out[0]?.prompt).toBe(CONTINUE_PROMPT);
  });

  it('does not duplicate an affordance the model already suggested', () => {
    const base = [{ prompt: 'Continue where it stopped' }];
    const out = withContinuationFollowups(base, { unfinished: true, hadTools: true });
    expect(out).toEqual(base);
  });

  it('says resume, not restart', () => {
    expect(CONTINUE_PROMPT).toMatch(/Do NOT restart/i);
    expect(CONTINUE_PROMPT).toMatch(/re-read/i);
    expect(RETRY_PROMPT).toMatch(/change the approach/i);
  });

  it('handles missing followups', () => {
    expect(withContinuationFollowups(undefined, { unfinished: true }).length).toBeGreaterThan(0);
    expect(withContinuationFollowups(null, { unfinished: false })).toEqual([]);
  });
});