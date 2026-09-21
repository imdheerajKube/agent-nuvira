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
