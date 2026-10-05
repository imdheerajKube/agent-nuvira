/**
 * Intent-aware escalation for bare continuations.
 *
 * A short affirmation ("yes", "do it") carries no routing signal, so the
 * follow-up to real software work would be scored as a trivial ask. The helper
 * hands routing the PREVIOUS software ask instead — but only in that exact case.
 */

import { describe, it, expect } from 'vitest';
import {
  isBareContinuation,
  continuationSoftwareText,
} from '../../src/learning/continuation-intent.js';

const SOFTWARE_ASK = 'fix the failing login test in src/auth.ts';

describe('isBareContinuation', () => {
  it('recognizes short, task-free affirmations', () => {
    for (const m of ['yes', 'Yes.', 'yep', 'ok', 'sure', 'go ahead', 'do it', 'proceed', 'continue', 'fix it']) {
      expect(isBareContinuation(m), m).toBe(true);
    }
  });

  it('does NOT treat a message that names its own task as a bare continuation', () => {
    for (const m of ['yes, but make the header red', 'no, use Postgres instead', 'what is the capital of France', '']) {
      expect(isBareContinuation(m), m).toBe(false);
    }
    // A long message is never "bare", even if it starts with yes.
    expect(isBareContinuation('yes'.padEnd(60, 'x'))).toBe(false);
  });
});

describe('continuationSoftwareText', () => {
  it('returns the previous software ask for a bare continuation', () => {
    const history = [
      { role: 'user', content: SOFTWARE_ASK },
      { role: 'assistant', content: 'Shall I apply the fix?' },
    ];
    expect(continuationSoftwareText('yes', history)).toBe(SOFTWARE_ASK);
  });

  it('does NOT escalate a bare continuation in a creative/chit-chat conversation', () => {
    const history = [
      { role: 'user', content: 'write a short poem about rain' },
      { role: 'assistant', content: 'Here is a poem…' },
    ];
    expect(continuationSoftwareText('yes', history)).toBeNull();
  });

  it('does nothing when the message is not a bare continuation', () => {
    const history = [{ role: 'user', content: SOFTWARE_ASK }];
    expect(continuationSoftwareText('yes, but make it red', history)).toBeNull();
    expect(continuationSoftwareText('add unit tests for the auth module', history)).toBeNull();
  });

  it('does nothing without a prior USER turn', () => {
    expect(continuationSoftwareText('yes', [])).toBeNull();
    expect(continuationSoftwareText('yes', undefined)).toBeNull();
    expect(continuationSoftwareText('yes', [{ role: 'assistant', content: 'anything else?' }])).toBeNull();
  });

  it('uses only the MOST RECENT user turn — it never resurrects an older code ask', () => {
    const history = [
      { role: 'user', content: SOFTWARE_ASK },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'write a short poem about rain' },
      { role: 'assistant', content: 'here you go' },
    ];
    expect(continuationSoftwareText('yes', history)).toBeNull();
  });
});
