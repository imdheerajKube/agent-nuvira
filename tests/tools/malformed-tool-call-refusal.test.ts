/**
 * What the model is TOLD when a tool call arrives without usable arguments.
 *
 * The refusal is the only feedback the model gets in that step, so its remedy is
 * the whole recovery path. It used to have exactly one — "split the payload into
 * pieces" — and that is what a live assessment turn obeyed: a 9 KB write was cut
 * at 4,096 tokens, the model fragmented the report, and the deliverable on disk
 * ended at §1 (trace-1793853385112-sf2exl).
 *
 * When the cap has been RAISED, re-sending the same call is the shorter path to
 * the document the user wanted, so that is what the refusal offers first and
 * splitting is the fallback.
 */

import { describe, expect, it } from 'vitest';

import { malformedToolCallRefusal } from '../../src/tools/tool-loop.js';

describe('malformedToolCallRefusal', () => {
  it('names the cap-raise and asks for the SAME call once when the budget was raised', () => {
    const text = malformedToolCallRefusal(
      { name: 'write_file', argumentsError: 'unparseable' },
      { finishReason: 'length', attempt: 1, budgetAfter: 8192 },
    );

    expect(text).toContain('Re-send the SAME call once');
    expect(text).toContain('8192 tokens');
    // Fragmentation is still available — as the fallback, not the instruction.
    expect(text).toContain('If it is cut again');
  });

  it('falls back to the sectioned instruction when no budget was raised', () => {
    const text = malformedToolCallRefusal({ name: 'write_file', argumentsError: 'unparseable' }, {});

    expect(text).toContain('Send the payload in PIECES');
    expect(text).not.toContain('Re-send the SAME call once');
  });

  it('is Error-prefixed so the call is never counted as one that ran', () => {
    const text = malformedToolCallRefusal({ name: 'edit_file', argumentsError: 'empty' }, {});
    expect(text.startsWith('Error: edit_file: NOT run')).toBe(true);
  });
});
