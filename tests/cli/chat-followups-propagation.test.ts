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
      generateTools: vi.fn(async () => ({
        content: `Hello!\n\n${JSON.stringify({ tool: 'suggest_followups', arguments: { followups: [{ prompt: 'Text next one' }] } })}`,
        toolCalls: [],
      })),
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
});
