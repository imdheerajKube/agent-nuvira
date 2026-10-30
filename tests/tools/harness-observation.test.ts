/**
 * THE OBSERVATION CONTRACT — a gate is a fact the model may judge, not a step it
 * must add.
 *
 * Gates are derived mechanically: a regex over the ask, a static import scan, a
 * filename convention. That derivation is right for most tasks and wrong for some,
 * and the measured failures went both ways — a run that ignored a real README row,
 * and a run refused an ending because a test the suite actually ran reached its
 * modules through `importlib` where a static scan could not see it. So the loop
 * states what it noticed, gives the model the right to say why it does not apply,
 * and RECORDS that answer. These tests pin the three properties that make the
 * difference between an observation and a cage: the invitation is present, the
 * answer is recorded without parsing, and the gate still speaks at most once.
 */

import { describe, it, expect } from 'vitest';

import {
  OBSERVATION_CONTRACT,
  createHarnessDirectiveSink,
  harnessDirective,
} from '../../src/tools/harness-directive.js';

describe('harness directives are observations', () => {
  it('carries the standing invitation: judge it, disagree with a reason', () => {
    const sink = createHarnessDirectiveSink();
    const thread: ReturnType<typeof harnessDirective>[] = [];
    expect(sink.push(thread, 'docs', 'There is no README.')).toBe(true);

    const content = String(thread[0].content);
    expect(content).toContain('[harness] There is no README.');
    expect(content).toContain('not an order');
    expect(content).toContain('does not apply to THIS request');
    expect(content).toContain('will not speak again this turn');
    // Executed evidence outranks a derived fact — the rule the 2026-10-27 run lost.
    expect(content).toContain('outranks the real output of a command you ran');
  });

  it('records the model’s answer verbatim, so a dismissal is on the record', () => {
    const sink = createHarnessDirectiveSink();
    sink.push([], 'docs', 'There is no README.');
    sink.answerLast('  This is a library patch; a README is not part of the ask.  ', 3);

    const [entry] = sink.observations();
    expect(entry.gate).toBe('docs');
    expect(entry.directive).toBe('There is no README.');
    expect(entry.answer).toBe('This is a library patch; a README is not part of the ask.');
    expect(entry.step).toBe(3);
  });

  it('records an ACTION as an answer — a silent fix is not a silent gate', () => {
    const sink = createHarnessDirectiveSink();
    sink.push([], 'completion', 'README.md is named by the ask and absent.');
    sink.answerLast('called write_file', 4);
    expect(sink.observations()[0].answer).toBe('called write_file');
  });

  it('answers each directive once, newest first — never retroactively', () => {
    const sink = createHarnessDirectiveSink();
    sink.push([], 'plan-depth', 'Step 2 bundles four named features.');
    sink.answerLast('Split into four steps.');
    sink.push([], 'completion', 'One requirement row is unmet.');
    sink.answerLast('Closing it now.');

    const log = sink.observations();
    expect(log.map((o) => [o.gate, o.answer])).toEqual([
      ['plan-depth', 'Split into four steps.'],
      ['completion', 'Closing it now.'],
    ]);
    // A third response cannot overwrite the newer answer.
    sink.answerLast('Unrelated final answer.');
    expect(sink.observations()[1].answer).toBe('Closing it now.');
  });

  it('still speaks at most once per gate — the invitation is not a licence to nag', () => {
    const sink = createHarnessDirectiveSink();
    const thread: ReturnType<typeof harnessDirective>[] = [];
    expect(sink.push(thread, 'docs', 'There is no README.')).toBe(true);
    expect(sink.push(thread, 'docs', 'There is still no README.')).toBe(false);
    expect(thread).toHaveLength(1);
    expect(sink.observations()).toHaveLength(1);
    expect(sink.deliveredGates()).toEqual(['docs']);
  });

  it('keeps the contract bounded — it is paid for on every gate', () => {
    expect(OBSERVATION_CONTRACT.length).toBeLessThan(420);
  });
});
