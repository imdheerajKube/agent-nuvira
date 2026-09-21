/**
 * ask_user renderer — the NON-INTERACTIVE contract.
 *
 * A scripted/piped run reached `ask_user` on step 4 of a real task and hung until
 * it was killed: inquirer rendered its arrow-key list and blocked on stdin with
 * no TTY attached. That is indistinguishable from "the agent is stuck", and it
 * makes the CLI unusable in CI, in a pipe, and in any headless harness.
 *
 * These tests pin the rule: with no TTY the renderer must resolve (never prompt),
 * return a usable default, and tell the model plainly that no human was reached.
 * With a TTY the interactive inquirer path must be preserved untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const inquirerPrompt = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: inquirerPrompt } }));

import { renderAskUser } from '../../src/tools/ask-user.js';

const CHOICES = [
  { label: 'Update implementation', description: 'Replace the current logic' },
  { label: 'Cancel', description: 'Do nothing and stop' },
];

describe('renderAskUser — non-interactive (no TTY)', () => {
  const original = process.stdin.isTTY;

  beforeEach(() => {
    // Piped / CI / headless shape.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    inquirerPrompt.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  });

  it('resolves instead of prompting, with the first choice as the default', async () => {
    const answer = await renderAskUser('Apply this change?', CHOICES, false);

    expect(inquirerPrompt).not.toHaveBeenCalled();
    expect(answer.answer).toBe('Update implementation');
    expect(answer.index).toBe(0);
  });

  it('tells the model to DISCLOSE the question + assumption, not to silently decide', async () => {
    const answer = await renderAskUser('Apply this change?', CHOICES, false);

    const custom = String(answer.custom);
    expect(custom).toBeTruthy();
    // The old contract told the model "do not ask again; proceed" — which made
    // a one-shot run present a decision the user never made (live: "I have
    // selected Python/Qt") and, worse, made the model echo the internal note
    // back ("no interactive user attached — defaulting to Beginner"). The
    // gateway instead REPLIES with the question and states the option it is
    // going with, so the user can correct it. The CLI now asks for the same
    // disclosure.
    expect(custom).toMatch(/assumption/i);
    expect(custom).toMatch(/question/i);
    expect(custom).toMatch(/do not mention this internal note/i);
    expect(custom.toLowerCase()).not.toContain('do not ask again');
  });

  it('shows the question and every choice on the visible output (gateway parity)', async () => {
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(' '));
    });
    try {
      await renderAskUser('Apply this change?', CHOICES, false);
    } finally {
      spy.mockRestore();
    }
    const out = printed.join('\n');
    // The human running a piped command must SEE what was asked and which
    // option was assumed — previously only an internal logger line carried it.
    expect(out).toContain('Apply this change?');
    expect(out).toContain('1. Update implementation');
    expect(out).toContain('2. Cancel');
    expect(out).toContain('proceeding with 1. "Update implementation"');
  });

  it('handles multi-select without prompting', async () => {
    const answer = await renderAskUser('Which apply?', CHOICES, true);

    expect(inquirerPrompt).not.toHaveBeenCalled();
    expect(answer.answer).toEqual(['Update implementation']);
    expect(answer.index).toEqual([0]);
  });

  it('does not crash when no choices were supplied', async () => {
    const answer = await renderAskUser('Anything?', [], false);
    expect(answer.answer).toBe('skip');
    expect(inquirerPrompt).not.toHaveBeenCalled();
  });
});

describe('renderAskUser — interactive (TTY)', () => {
  const original = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  });

  it('prompts with inquirer and maps the label back to its index', async () => {
    inquirerPrompt.mockResolvedValue({ answer: 'Cancel' });

    const answer = await renderAskUser('Apply this change?', CHOICES, false);

    expect(inquirerPrompt).toHaveBeenCalledTimes(1);
    expect(answer.answer).toBe('Cancel');
    expect(answer.index).toBe(1);
    // An interactive answer carries no \"no user\" notice.
    expect(answer.custom).toBeUndefined();
  });
});
