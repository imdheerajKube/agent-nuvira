/**
 * Stage 2 — the repetition gate, through the REAL `ask_user` tool.
 *
 * The live failure, in order:
 *   1. the agent asked "may I run `node -c script.js`?" — four times, in four
 *      phrasings, in one turn;
 *   2. nothing counted the asks, so it could not notice;
 *   3. the user asked "why are you asking me this again and again?" and the turn
 *      answered with an edit plan.
 *
 * The Run Trace supplies (2); this test pins the gate that follows from it — the
 * second ask never reaches the user, and the model is handed the answer it
 * already has. Irreversible choices are the deliberate exception.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { RunTrace } from '../../src/learning/run-trace.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuvira-repeat-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function callAskUser(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = getTool('ask_user');
  if (!tool) throw new Error('ask_user not registered');
  return tool.run(args, ctx);
}

/** What a live turn actually asked, in the order it asked it. */
const FIRST = 'May I run `node -c script.js` to perform a syntax check?';
const SECOND = 'Run a JavaScript syntax check (`node -c script.js`)?';
const THIRD = 'Run a JavaScript syntax check (node -c script.js)?';

describe('ask_user — the repetition gate', () => {
  it('lets the FIRST ask through and records it with the answer', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Yes, run it', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, runTrace: trace, askUser };

    const result = await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result).toContain('User answered: Yes, run it');
    // Recorded, so the run now KNOWS it asked this.
    expect(trace.countAsks()).toBe(1);
    expect(trace.countShownAsks()).toBe(1);
  });

  it('REFUSES the second ask — differently worded, same question', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Yes, run it', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, runTrace: trace, askUser };

    await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    const second = await callAskUser({ question: SECOND, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);

    // The user is bothered ONCE — that is the whole point.
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(second).toContain('Not shown to the user');
    expect(second).toContain('already asked this once');
    expect(second).toContain('they answered "Yes, run it"');
    expect(second).toContain('Do NOT ask it again');
  });

  it('keeps refusing across a whole loop of rephrasings', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Yes', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, runTrace: trace, askUser };

    await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    await callAskUser({ question: SECOND, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    await callAskUser({ question: THIRD, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);

    // One prompt for four attempts — the live turn produced four.
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(trace.countShownAsks()).toBe(1);
    expect(trace.repeatedAskCount()).toBe(2);
  });

  it('still reaches the user for a repeated IRREVERSIBLE choice', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Keep both', index: 1 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, runTrace: trace, askUser };

    const q = {
      question: 'Do you want me to overwrite the existing kharig-nights.md?',
      choices: [{ label: 'Overwrite' }, { label: 'Keep both' }],
    };
    await callAskUser(q, ctx);
    await callAskUser(q, ctx);

    // A destructive choice is genuinely new each time it is put — never deduped.
    expect(askUser).toHaveBeenCalledTimes(2);
  });

  it('asks a genuinely NEW question even after a repeat was suppressed', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Node', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, runTrace: trace, askUser };

    await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    const fresh = await callAskUser(
      { question: 'Which runtime should I use?', choices: [{ label: 'Node' }, { label: 'Python' }] },
      ctx,
    );

    expect(askUser).toHaveBeenCalledTimes(2);
    expect(fresh).toContain('User answered: Node');
  });

  it('records an authorization-suppressed ask, so a re-ask is still refused', async () => {
    const trace = new RunTrace();
    const askUser = vi.fn(async () => ({ answer: 'Yes', index: 0 }));
    const ctx: ToolContext = {
      configManager: {},
      cwd: root,
      runTrace: trace,
      writesAuthorized: { authorized: true, reason: 'the request authorized this work' },
      askUser,
    };

    // G13 settles this one without showing the user…
    const first = await callAskUser(
      { question: 'Do you want me to create the full project structure?', choices: [{ label: 'Yes' }, { label: 'No' }] },
      ctx,
    );
    expect(first).toContain('Not shown to the user');
    // …and the SECOND attempt is caught by the repetition gate, not G13.
    const second = await callAskUser(
      { question: 'Should I create the full project structure now?', choices: [{ label: 'Yes' }, { label: 'No' }] },
      ctx,
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(second).toContain('already asked this once');
  });

  it('behaves exactly as before when no trace is present (back-compat)', async () => {
    const askUser = vi.fn(async () => ({ answer: 'Yes', index: 0 }));
    const ctx: ToolContext = { configManager: {}, cwd: root, askUser };
    await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    await callAskUser({ question: FIRST, choices: [{ label: 'Yes' }, { label: 'No' }] }, ctx);
    expect(askUser).toHaveBeenCalledTimes(2);
  });
});
