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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatCommand } from '../../src/cli/chat.js';
import { ConfigManager } from '../../src/config/manager.js';
import { deriveProjectId, resetWorkspaceStore } from '../../src/config/workspace.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

describe('ChatCommand — E3b tool-call turn', () => {
  let tempDir: string;
  let original: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-tool-loop-'));
    // Hermetic on BOTH env vars: BUFF_MEMORY_DIR (registry/cache) and
    // BUFF_CONFIG_DIR (workspace store) — the P4 recall tests seed prior work
    // through the store and must never touch the real ~/.buff registry.
    original = process.env.BUFF_MEMORY_DIR;
    originalConfigDir = process.env.BUFF_CONFIG_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    process.env.BUFF_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (original === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = original;
    if (originalConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
    else process.env.BUFF_CONFIG_DIR = originalConfigDir;
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
    );

    // Bounded — the loop returns the step-limit message instead of spinning.
    expect(out.content.length).toBeGreaterThan(0);
    expect((provider.generateTools as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(8);
  });
});

describe('ChatCommand — P4 project auto-recall (dashboard chat)', () => {
  // The first describe's beforeEach is scoped to ITS describe — this describe
  // needs its own hermetic env (fresh BUFF_MEMORY_DIR + BUFF_CONFIG_DIR per
  // test) so recall seeding never touches the real ~/.buff store/cache.
  let tempDir: string;
  let projDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-recall-'));
    origMemory = process.env.BUFF_MEMORY_DIR;
    origConfig = process.env.BUFF_CONFIG_DIR;
    process.env.BUFF_MEMORY_DIR = join(tempDir, 'memory');
    process.env.BUFF_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
    projDir = join(tempDir, 'proj');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    resetModelRegistry();
    resetWorkspaceStore();
    if (origMemory === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.BUFF_CONFIG_DIR;
    else process.env.BUFF_CONFIG_DIR = origConfig;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* noop */ }
    vi.restoreAllMocks();
  });

  /**
   * A provider that captures the tool-loop thread so the test can assert what
   * was actually sent to the model (the recall block must ride in the
   * messages, injected by answerOnce BEFORE runChatAnswer builds the thread).
   */
  function makeCapturingProvider() {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        calls.push({ messages });
        return { content: 'Recalled.', toolCalls: [] };
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    return { provider, calls };
  }

  /**
   * answerOnce resolves its own provider via getProvider — stub it so the
   * captured mock is used (never a real network call). Explicit provider +
   * model keep auto-routing off.
   */
  function stubGetProvider(provider: InferenceProvider) {
    return vi
      .spyOn(ChatCommand.prototype as unknown as { getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }> }, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
  }

  it('injects the recalled project context when a project is attached', async () => {
    // Seed prior work for the attached project: one workspace row is enough —
    // maybeAutoRecall returns non-null on the project row alone, and the
    // context block carries the last goal + run summary.
    const projectPath = projDir;
    new ConfigManager().getWorkspaceStore().recordRun({
      cwd: projectPath,
      goal: 'build the ecommerce checkout',
      summary: 'checkout flow implemented',
      sessionId: 'p4-s1',
      success: true,
    });

    const { provider, calls } = makeCapturingProvider();
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('continue the checkout work', {
      provider: 'groq',
      model: 'mock-model',
      projectPath,
    });

    expect(out.content).toBe('Recalled.');
    expect(calls.length).toBeGreaterThan(0);
    const thread = calls[0].messages;
    // The recall block is a real message in the thread (not a side effect):
    // [system] → [Project/recall context] → history → user ask.
    const recall = thread.find((m) => m.content.startsWith('[Recalled project context'));
    expect(recall).toBeDefined();
    expect(recall!.content).toContain('Last goal: build the ecommerce checkout');
    expect(recall!.content).toContain('checkout flow implemented');
    // Injected after the system prompt, before the user's ask.
    const sysIdx = thread.findIndex((m) => m.role === 'system');
    const recallIdx = thread.indexOf(recall!);
    const askIdx = thread.findIndex((m) => m.role === 'user' && m.content.includes('continue the checkout work'));
    expect(recallIdx).toBeGreaterThan(sysIdx);
    expect(recallIdx).toBeLessThan(askIdx);
  });

  it('injects NO recall when no project is attached (plain dashboard chat)', async () => {
    const { provider, calls } = makeCapturingProvider();
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('hello there', { provider: 'groq', model: 'mock-model' });

    expect(out.content).toBe('Recalled.');
    expect(calls.length).toBeGreaterThan(0);
    const thread = calls[0].messages;
    expect(thread.some((m) => m.content.includes('[Recalled project context]'))).toBe(false);
  });
});
