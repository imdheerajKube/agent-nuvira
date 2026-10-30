/**
 * answerOnce must return the model's suggest_followups to the caller.
 *
 * Both the CLI (renderFollowups) and the dashboard (chips) render followups
 * from `answerOnce().followups`. If the loop collects them but answerOnce
 * drops them, no surface shows anything — a silent regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/model.js')>();
  return { ...actual, applyActiveModel: (options: { provider?: string; model?: string }) => options };
});

import { ChatCommand } from '../../src/cli/chat.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

type Proto = {
  getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }>;
  routeMessageAuto: (m: string) => Promise<{ type: string; provider: InferenceProvider; model?: string }>;
};

describe('answerOnce — suggest_followups reach the caller', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-followups-propagate-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('recovers followups written as TEXT (no native tool call) and strips the JSON', async () => {
    const provider = {
      name: 'Mock',
      // The model wrote the tool JSON in its content instead of a native call.
      // The SECOND answer is a plain one: a mock that repeats the same content
      // forever is salvaged into the same followup tool every step and runs to
      // the step ceiling, which would mix the continuation chips into a test
      // about followup PROPAGATION.
      generateTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: `Hello!\n\n${JSON.stringify({ tool: 'suggest_followups', arguments: { followups: [{ prompt: 'Text next one' }] } })}`,
          toolCalls: [],
        })
        .mockResolvedValue({ content: 'Hello!', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('Hello!'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'gemini',
      provider,
      model: 'mock-model',
    });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {});

    expect(out.followups.map((f: { prompt: string }) => f.prompt)).toEqual(['Text next one']);
    expect(out.content).not.toContain('"tool"');
  });

  /**
   * The shape the model writes BY HAND — our tool's name as the arguments key.
   * Live: a dashboard chat (gemini-3.1-flash-lite, 2026-09-22) ended 13 of its
   * 16 assistant turns with this block. The reader got the raw JSON in the
   * bubble AND no followups reached the caller, so no chips ever appeared.
   * Both halves are asserted here: the text is clean and the suggestions
   * survive as data.
   */
  it('recovers a name-keyed suggest_followups payload written as text', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => ({
        content:
          'The project is ready.\n\n---\n' +
          '{"suggest_followups":[' +
          '{"label":"Verify tab switching","prompt":"The tab switching is now working correctly."},' +
          '{"label":"Finalize project","prompt":"I am happy with the features."}]}',
        toolCalls: [],
      })),
      generate: vi.fn().mockResolvedValue('The project is ready.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'gemini',
      provider,
      model: 'gemini-3.1-flash-lite',
    });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce(
      'enhance the calculator',
      {},
    );

    expect(out.content).not.toContain('suggest_followups');
    expect(out.content).not.toContain('"followups"');
    expect(out.followups.map((f: { prompt: string }) => f.prompt)).toEqual([
      'The tab switching is now working correctly.',
      'I am happy with the features.',
    ]);
  });

  it('returns the collected followups when the model co-emits answer + followup call', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => ({
        content: 'Here is the answer.',
        toolCalls: [
          {
            id: 'c1',
            name: 'suggest_followups',
            arguments: { followups: [{ prompt: 'Go deeper on A' }, { prompt: 'Do B next' }] },
          },
        ],
      })),
      generate: vi.fn().mockResolvedValue('Here is the answer.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'gemini',
      provider,
      model: 'mock-model',
    });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {});

    expect(out.content).toContain('Here is the answer.');
    expect(out.followups.map((f: { prompt: string }) => f.prompt)).toEqual(['Go deeper on A', 'Do B next']);
  });

  /**
   * The reported case (2026-10-14): `nuvira execute "hi"` on a weak local model
   * reported 0 tool calls, wrote its three options as PROSE, and offered the user
   * only the generic menu. Every surface's followups come from this one boundary,
   * so recovering them here is what makes the CLI menu, the dashboard chips and
   * the gateway's list agree instead of each recovering its own.
   */
  it('recovers the options a weak model wrote as a PROSE list', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => ({
        content: [
          "It seems like you've shared a lot of information here, but it's not clear what you're asking.",
          '',
          'Would you like me to:',
          '  1. Fix the factorial performance issue by adding a limit?',
          '  2. Replace the new Function evaluation with a safer alternative?',
          '  3. Run the existing test suite to see if these bugs are triggering failures?',
        ].join('\n'),
        toolCalls: [],
      })),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'local', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'local',
      provider,
      model: 'deepseek-coder:latest',
    });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hi', {});

    expect(out.followups.map((f: { prompt: string }) => f.prompt)).toEqual([
      'Fix the factorial performance issue by adding a limit?',
      'Replace the new Function evaluation with a safer alternative?',
      'Run the existing test suite to see if these bugs are triggering failures?',
    ]);
    // The answer itself is untouched — the list is recovered, not rewritten.
    expect(out.content).toContain('Would you like me to:');
  });

  /**
   * The other half of the reported experience: for a plain turn the console was
   * preceded by a warmup announcement, a checkpoint line, a resume-probe line with
   * its why-not detail and the debug-log path. Those are diagnostics — they now
   * travel on the DEBUG channel, so the answer is the output and `--debug` is the
   * diagnosis.
   */
  it('keeps checkpoint/resume diagnostics off the console for a plain turn', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => ({ content: 'A plain answer.', toolCalls: [] })),
      generate: vi.fn().mockResolvedValue('A plain answer.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'gemini',
      provider,
      model: 'mock-model',
    });

    // `resume` is what opens the record (and produces the notice).
    await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hi', { resume: true });

    const infoLines = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const debugLines = debugSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const diagnostic = /no record for this ask|resume probe|checkpointing this run|debug log written/;
    expect(infoLines.some((l) => diagnostic.test(l))).toBe(false);
    expect(debugLines.some((l) => diagnostic.test(l))).toBe(true);
  });
});
