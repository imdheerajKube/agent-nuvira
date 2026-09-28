/**
 * Intent confirmation — the agent auditing its OWN reading of a repeatedly
 * failing ask.
 *
 * The critical property is the failure mode: a probe that cannot run (no model,
 * unreadable answer, an outage) must produce NO correction. Teaching the router
 * from a failed probe would encode an outage as a rule and make routing worse
 * exactly when the pool is down.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildIntentConfirmPrompt,
  confirmRoutedIntent,
  intentConfirmedNote,
  intentCorrectedNote,
  parseIntentConfirmReply,
} from '../../src/nlu/intent-confirm.js';
import { clearLearnings, listLearnings } from '../../src/nlu/learnings.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-intent-confirm-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  clearLearnings();
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const ASK = 'get me a plan for my kid to learn english';

describe('the audit prompt', () => {
  it('states the ask, the route, and the decision space — and forbids answering', () => {
    const prompt = buildIntentConfirmPrompt(ASK, 'pipeline');
    expect(prompt).toContain(ASK);
    expect(prompt).toContain('"coding-task"');
    expect(prompt).toMatch(/Do not answer the request/);
    expect(prompt).toContain('"intent"');
  });

  it('names the OTHER route when the ask was read as chat', () => {
    expect(buildIntentConfirmPrompt(ASK, 'chat')).toContain('"chat"');
  });
});

describe('parsing the verdict', () => {
  it('reads the JSON contract', () => {
    expect(parseIntentConfirmReply('{"intent":"coding-task","reason":"needs software"}')).toMatchObject({
      kind: 'pipeline',
      reason: 'needs software',
      understood: true,
    });
    expect(parseIntentConfirmReply('{"intent":"chat","reason":"it is advice"}')).toMatchObject({
      kind: 'chat',
      understood: true,
    });
  });

  it('reads a bare token or a short prose answer', () => {
    expect(parseIntentConfirmReply('coding-task')).toMatchObject({ kind: 'pipeline', understood: true });
    expect(parseIntentConfirmReply('The right route is chat for this one.')).toMatchObject({
      kind: 'chat',
      understood: true,
    });
  });

  it('gives NO verdict when the answer is unreadable or contradictory', () => {
    for (const raw of ['', '   ', 'I am not sure.', '{"intent":"maybe"}', 'chat or coding-task, hard to say']) {
      expect(parseIntentConfirmReply(raw).understood, raw).toBe(false);
    }
  });
});

describe('confirmRoutedIntent', () => {
  it('reports agreement and writes NO learning when the reading was right', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => '{"intent":"chat","reason":"advice, not software"}',
    });
    expect(result.agreed).toBe(true);
    expect(result.kind).toBe('chat');
    expect(result.reason).toBe('advice, not software');
    expect(listLearnings()).toHaveLength(0);
  });

  it('corrects the route AND records the learning when the reading was wrong', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => '{"intent":"coding-task","reason":"wants it built"}',
    });
    expect(result.agreed).toBe(false);
    expect(result.kind).toBe('pipeline');
    expect(result.learning).toBeDefined();

    const [learning] = listLearnings();
    expect(learning).toMatchObject({ from: 'chat', to: 'pipeline', source: 'intent-confirm' });
    expect(learning!.example).toBe(ASK);
  });

  it('a failed probe means NO correction — an outage must never become a rule', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => {
        throw new Error('429 rate limited');
      },
    });
    expect(result).toMatchObject({ agreed: true, kind: 'chat', failed: true });
    expect(listLearnings()).toHaveLength(0);
  });

  it('an unreadable answer means no correction either', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'pipeline',
      callLLM: async () => 'Sorry — as a large language model I cannot say.',
    });
    expect(result.agreed).toBe(true);
    expect(result.kind).toBe('pipeline');
    expect(result.failed).toBe(true);
    expect(listLearnings()).toHaveLength(0);
  });

  it('ACT on a correction the model did not justify, but never TEACH it', async () => {
    // WS1 (#23) — the gate, at the place it matters. `learnings.ts` promises a
    // learning is written only when a misreading was CONFIRMED; before this, a
    // correction with no reason counted as confirmed, so a rule nobody could
    // justify was persisted and silently re-routed every later ask that matched.
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => '{"intent":"coding-task"}',
    });

    // The turn still takes the better route — a PLAUSIBLE reading is useful.
    expect(result.kind).toBe('pipeline');
    expect(result.agreed).toBe(false);
    // ...and it is not written down as a permanent change to the router.
    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.finding.evidence).toEqual([]);
    expect(result.learning).toBeUndefined();
    expect(listLearnings()).toHaveLength(0);
  });

  it('promotes the correction and records it once the model justifies it', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => '{"intent":"coding-task","reason":"wants it built"}',
    });

    expect(result.finding.verdict).toBe('CONFIRMED');
    expect(result.finding.evidence).toEqual([
      {
        kind: 'observation',
        ref: 'wants it built',
        detail: 'stated reason from the probe model',
      },
    ]);
    expect(result.finding.outcome).toContain('corrected from chat to pipeline');
    expect(result.learning).toBeDefined();
    expect(listLearnings()).toHaveLength(1);
  });

  it('carries a finding even when the probe could not run', async () => {
    // "We could not establish a reading" is itself a fact about the turn, and a
    // report must be able to print it rather than infer it from a missing field.
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => {
        throw new Error('429 rate limited');
      },
    });

    expect(result.finding.verdict).toBe('PLAUSIBLE');
    expect(result.finding.outcome).toContain('the probe could not run');
    expect(result.finding.claim).toContain('is best served by');
  });

  it('does not record when recording is switched off', async () => {
    const result = await confirmRoutedIntent({
      ask: ASK,
      routed: 'chat',
      callLLM: async () => '{"intent":"coding-task"}',
      record: false,
    });
    expect(result.kind).toBe('pipeline');
    expect(result.learning).toBeUndefined();
    expect(listLearnings()).toHaveLength(0);
  });

  it('passes the prompt to the model (the ask is never sent without the audit frame)', async () => {
    const callLLM = vi.fn(async () => '{"intent":"chat"}');
    await confirmRoutedIntent({ ask: ASK, routed: 'chat', callLLM });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const [prompt] = callLLM.mock.calls[0]!;
    expect(prompt).toContain(ASK);
    expect(prompt).toContain('Reply with JSON only');
  });
});

describe('the sender-facing notes', () => {
  it('says a broken promise is not the problem when the reading was confirmed', () => {
    expect(intentConfirmedNote('pipeline')).toMatch(/building this is the right read/);
    expect(intentConfirmedNote('chat')).toMatch(/question to answer, not code to write/);
  });

  it('says what it is doing instead when the reading was corrected', () => {
    expect(intentCorrectedNote('pipeline', 'wants it built')).toMatch(/build pipeline/);
    expect(intentCorrectedNote('chat')).toMatch(/Answering it directly/);
  });
});
