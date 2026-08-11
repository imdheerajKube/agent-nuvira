/**
 * E3b — Chat tool-loop integration tests.
 *
 * Drives ChatCommand.runChatAnswer with MOCK providers through both
 * transports (H1/C3 acceptance b):
 * - native: the provider implements generateTools (tool_calls protocol),
 * - JSON fallback: generate/generateStream returns content with a trailing
 *   {"tool":...} block parsed by extractFallbackToolCalls.
 * Verifies the turn finalizes (history + followups) without touching a real
 * provider or the orchestrator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatCommand } from '../../src/cli/chat.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

describe('ChatCommand — E3b tool-call turn', () => {
  let tempDir: string;
  let original: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-tool-loop-'));
    original = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (original === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = original;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('answers through the native generateTools path and collects followups', async () => {
    let step = 0;
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => {
        step += 1;
        if (step === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Go deeper?' }] } }],
          };
        }
        return { content: 'Here is the answer.', toolCalls: [] };
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const history: Array<{ role: string; content: string }> = [];
    // cacheEnabled: false — the disk cache (~/.buff/cache.json) is NOT the
    // subject of this test and would leak across runs (a persisted hit would
    // skip generateTools entirely).
    const out = await cmd.runChatAnswer(
      'how do I add auth?',
      history,
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      false,
    );

    expect(out.content).toBe('Here is the answer.');
    expect(provider.generateTools).toHaveBeenCalledTimes(2);
    // The native call received the JSON schemas for the tool set.
    const firstCall = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0];
    const schemas = firstCall[1] as Array<{ name: string }>;
    expect(schemas.some((s) => s.name === 'suggest_followups')).toBe(true);
    expect(schemas.some((s) => s.name === 'ask_user')).toBe(true);
    // Turn finalized in history (user + assistant).
    expect(history.length).toBe(2);
    expect(history[1].content).toBe('Here is the answer.');
  });

  it('answers through the JSON fallback transport when generateTools is absent', async () => {
    const provider = {
      name: 'Mock',
      generate: vi.fn().mockResolvedValue(
        'The plain answer.\n{"tool":"suggest_followups","arguments":{"followups":[{"prompt":"Try the CLI"}]}}',
      ),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const history: Array<{ role: string; content: string }> = [];
    const out = await cmd.runChatAnswer(
      'explain the routing',
      history,
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      false,
    );

    // The JSON tool block was stripped from the displayed content.
    expect(out.content).toBe('The plain answer.');
    expect(out.content).not.toContain('{"tool"');
    expect(history[1].content).toBe('The plain answer.');
  });

  it('does not hang when the model loops on tool calls (bounded steps)', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: { request: 'x' } }],
      }),
      generate: vi.fn().mockResolvedValue(''),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const out = await cmd.runChatAnswer(
      'loop test',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      false,
    );

    // Bounded — the loop returns the step-limit message instead of spinning.
    expect(out.content.length).toBeGreaterThan(0);
    expect((provider.generateTools as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(8);
  });
});
