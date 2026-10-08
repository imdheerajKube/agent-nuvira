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
import { recordDecision } from '../../src/learning/decision-log.js';
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
    // through the store and must never touch the real ~/.nuvira registry.
    original = process.env.NUVIRA_MEMORY_DIR;
    originalConfigDir = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (original === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = original;
    if (originalConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = originalConfigDir;
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
    // cacheEnabled: false — the disk cache (~/.nuvira/cache.json) is NOT the
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

  it('records a reasoning trace for the chat turn (Trace-tab visibility)', async () => {
    const { listTraces } = await import('../../src/learning/reasoning-trace.js');
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'The traced answer.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer(
      'write a song in hindi',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
    );

    const traces = listTraces(5);
    const chatTrace = traces.find((t) => t.source === 'chat');
    expect(chatTrace).toBeDefined();
    expect(chatTrace!.goal).toContain('write a song in hindi');
    expect(chatTrace!.endedAt).toBeDefined();
    expect(chatTrace!.steps.length).toBeGreaterThanOrEqual(1);
    expect(chatTrace!.steps[0].agentType).toBe('chat');
    expect(chatTrace!.steps[0].provider).toBe('groq');
    expect(chatTrace!.steps[0].model).toBe('mock-model');
    expect(chatTrace!.steps[0].success).toBe(true);
  });

  it('P5 — a picked followup reaches the model WITH the continuation marker (raw text stays in history)', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Continuing from the plan.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('Continuing from the plan.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'Philippines or Vietnam in December?' },
      { role: 'assistant', content: 'Here are both options with budgets.' },
    ];
    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer(
      'Draft a 7-day Vietnam itinerary',
      history,
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      undefined,
      { continuation: true },
    );

    // The model-facing thread carries the marker...
    const sent = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMsg = sent.filter((m) => m.role === 'user').pop();
    expect(userMsg?.content).toContain('CONTINUATION');
    // ...and the previous turn is threaded alongside it.
    expect(sent.some((m) => m.role === 'assistant' && m.content.includes('both options with budgets'))).toBe(true);
    // History keeps the RAW text — the marker must never accumulate there.
    expect(history.filter((h) => h.role === 'user').map((h) => h.content)).toEqual([
      'Philippines or Vietnam in December?',
      'Draft a 7-day Vietnam itinerary',
    ]);
  });

  it('P5 — an ordinary message is NOT marked as a continuation', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Sure.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('Sure.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer(
      'hello there',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
    );
    const sent = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMsg = sent.filter((m) => m.role === 'user').pop();
    expect(userMsg?.content).not.toContain('CONTINUATION');
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

    // BOUNDED — the loop returns instead of spinning forever. The hard cap is
    // maxSteps + the auto-continuation budget (16 + 2 x 8 = 32), plus at most
    // ONE step for each bounded nudge the loop spends (here the self-diagnosis
    // nudge, which fires once when the model keeps re-running the same failing
    // call). Still a hard bound, never an infinite loop.
    expect(out.content.length).toBeGreaterThan(0);
    expect((provider.generateTools as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(33);
  });
});

describe('ChatCommand — P4 project auto-recall (dashboard chat)', () => {
  // The first describe's beforeEach is scoped to ITS describe — this describe
  // needs its own hermetic env (fresh BUFF_MEMORY_DIR + BUFF_CONFIG_DIR per
  // test) so recall seeding never touches the real ~/.nuvira store/cache.
  let tempDir: string;
  let projDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;
  let origDecisionLog: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-recall-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    origDecisionLog = process.env.NUVIRA_DECISION_LOG;
    delete process.env.NUVIRA_DECISION_LOG;
    process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
    projDir = join(tempDir, 'proj');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    resetModelRegistry();
    resetWorkspaceStore();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    if (origDecisionLog === undefined) delete process.env.NUVIRA_DECISION_LOG;
    else process.env.NUVIRA_DECISION_LOG = origDecisionLog;
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

  it('injects this project’s related recorded decisions as an advisory block', async () => {
    // A later ask that mentions the same subject must be shown what was already
    // decided, so the same question is not re-asked. The block is ADVISORY: it is
    // ordinary context, and it never suppresses an `ask_user` (the tool stays on
    // the wire below).
    const projectPath = projDir;
    recordDecision({
      question: 'Which database should the service use?',
      answer: 'Postgres',
      source: 'ask_user',
      dir: projectPath,
    });
    process.env.NUVIRA_DECISION_LOG = 'on'; // a test runner is otherwise inert

    const { provider, calls } = makeCapturingProvider();
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    await cmd.answerOnce('add an index to the service database', {
      provider: 'groq',
      model: 'mock-model',
      projectPath,
    });

    const thread = calls[0].messages;
    const block = thread.find((m) => m.content.startsWith('[Previously decided'));
    expect(block).toBeDefined();
    expect(block!.content).toContain('Which database should the service use?');
    expect(block!.content).toContain('Postgres');
    // It rides in BEFORE the user's ask, with the other context blocks.
    const blockIdx = thread.indexOf(block!);
    const askIdx = thread.findIndex(
      (m) => m.role === 'user' && m.content.includes('add an index to the service database'),
    );
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(askIdx);
    // Advisory, not a suppression: `ask_user` remains exposed on the wire.
    const schemas = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{
      name: string;
    }>;
    expect(schemas.some((s) => s.name === 'ask_user')).toBe(true);

    // A later ask with NO shared significant token gets no block at all.
    await cmd.answerOnce('write a haiku about the sea', {
      provider: 'groq',
      model: 'mock-model',
      projectPath,
    });
    const secondThread = calls[calls.length - 1].messages;
    expect(secondThread.some((m) => m.content.startsWith('[Previously decided'))).toBe(false);
  });

  it('the system prompt tells a weak model that general writing needs no folder', async () => {
    // The regression (dashboard chat): after one "attach a project folder"
    // refusal, a small model carried the refusal into a plain writing ask —
    // "write an essay" came back as instructions for moving a project folder
    // plus "I don't have the capability to create files in a workspace". The
    // prompt now forbids that outright, so the failure mode is guarded by a test
    // rather than only by the workspace guard that stopped firing.
    const { provider, calls } = makeCapturingProvider();
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    await cmd.answerOnce('write an essay on elephants for class 4', {
      provider: 'groq',
      model: 'mock-model',
    });

    const system = calls[0].messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content)
      .join('\n');
    expect(system).toContain('do NOT need a project folder');
    expect(system).toContain('Never say you cannot create or write files');
    expect(system).toContain('never tell them to move files into a directory');
  });

  it('a rejected answer is reported as a FAILURE, never as a successful turn', async () => {
    // Live evidence (dashboard chat): the bubble read "The model wrote its own
    // working notes instead of an answer…" while `generationFailed` was FALSE,
    // so the surface offered no retry and queued nothing — the honest line was
    // reported to every caller as the turn's answer.
    const leak = [
      "The user wants to know how the router picks a model.",
      '',
      "I should read the auto-router first.",
    ].join('\n');
    const provider = {
      name: 'Mock',
      // Every candidate narrates, so the walk cannot rescue the turn.
      generateTools: vi.fn(async () => ({ content: leak, toolCalls: [] })),
      generate: vi.fn().mockResolvedValue(leak),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('explain how the router picks a model', {
      provider: 'groq',
      model: 'mock-model',
    });

    expect(out.content).not.toContain('The user wants to know how the router');
    expect(out.content).not.toContain('language model was unavailable');
    expect(out.generationFailed).toBe(true);
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

describe('ChatCommand — P4 answer token streaming (dashboard typewriter)', () => {
  // Same hermetic env as the P4 recall describe (BUFF_MEMORY_DIR +
  // BUFF_CONFIG_DIR per test) — the engine must never touch the real ~/.nuvira.
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-stream-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    resetWorkspaceStore();
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* noop */ }
    vi.restoreAllMocks();
  });

  function stubGetProvider(provider: InferenceProvider) {
    return vi
      .spyOn(ChatCommand.prototype as unknown as { getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }> }, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
  }

  it('streams answer tokens live when the provider supports generateToolsStream', async () => {
    const tokens: string[] = [];
    const provider = {
      name: 'Mock',
      generateToolsStream: vi.fn(async (_m: unknown, _t: unknown, _o: unknown, onToken: (t: string) => void) => {
        for (const t of ['Hello', ' there', '!']) onToken(t);
        return { content: 'Hello there!', toolCalls: [] };
      }),
      generateTools: vi.fn().mockResolvedValue({ content: 'must not be used', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('hi', {
      provider: 'groq',
      model: 'mock-model',
      onToken: (t) => tokens.push(t),
    });

    expect(out.content).toBe('Hello there!');
    // Every token reached the sink, in order (the typewriter).
    expect(tokens).toEqual(['Hello', ' there', '!']);
    expect(provider.generateToolsStream).toHaveBeenCalledTimes(1);
    // The streaming path is preferred over the one-shot.
    expect(provider.generateTools).not.toHaveBeenCalled();
  });

  it('degrades to one-shot generateTools delivered as a single token chunk', async () => {
    const tokens: string[] = [];
    const provider = {
      name: 'Mock',
      // No generateToolsStream — the one-shot path must still deliver the
      // whole content through the token channel so the GUI shows it (at once,
      // today's behavior) instead of nothing.
      generateTools: vi.fn().mockResolvedValue({ content: 'Whole answer at once.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('hi again', {
      provider: 'groq',
      model: 'mock-model',
      onToken: (t) => tokens.push(t),
    });

    expect(out.content).toBe('Whole answer at once.');
    expect(tokens).toEqual(['Whole answer at once.']);
  });

  it('does NOT stream when no onToken sink is wired (CLI path unchanged)', async () => {
    const provider = {
      name: 'Mock',
      generateToolsStream: vi.fn(async (_m: unknown, _t: unknown, _o: unknown, onToken: (t: string) => void) => {
        onToken('leaked');
        return { content: 'plain', toolCalls: [] };
      }),
      generateTools: vi.fn().mockResolvedValue({ content: 'plain', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('hi', { provider: 'groq', model: 'mock-model' });

    expect(out.content).toBe('plain');
    // Without a sink the engine takes the one-shot path (no stream involved).
    expect(provider.generateToolsStream).not.toHaveBeenCalled();
    expect(provider.generateTools).toHaveBeenCalledTimes(1);
  });

  it('never spends a model call when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'must not run', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('hi', {
      provider: 'groq',
      model: 'mock-model',
      signal: controller.signal,
    });

    expect(out.cancelled).toBe(true);
    // The loop's pre-step check fired before ANY model call.
    expect(provider.generateTools).not.toHaveBeenCalled();
  });

  it('stops at the next loop boundary when the signal aborts mid-turn', async () => {
    const controller = new AbortController();
    const provider = {
      name: 'Mock',
      generateTools: vi.fn(async () => {
        // The user hit Cancel during the first model call: the in-flight
        // request aborts and the loop must NOT request another step.
        controller.abort();
        return { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'zz-no-such-file.ts' } }] };
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
    stubGetProvider(provider);

    const cmd = new ChatCommand() as unknown as { answerOnce: Function };
    const out = await cmd.answerOnce('stop me', {
      provider: 'groq',
      model: 'mock-model',
      signal: controller.signal,
    });

    expect(out.cancelled).toBe(true);
    // One model call only — the boundary check stopped the second.
    expect(provider.generateTools).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a reply that is the model\'s own reasoning, instead of delivering it', async () => {
    // Verbatim opening from ~/.nuvira/gateway/inbox.json — the model narrated
    // its thinking and the loop shipped it to a WhatsApp sender as the answer.
    // A quality failure never THROWS on its own, so the loop must reject it
    // here (which is what makes the failover walk try the next candidate).
    const REASONING_REPLY = [
      'The user said "Hi" via WhatsApp.',
      'According to the instructions:',
      '- Deliver answer DIRECTLY.',
      '- End with `suggest_followups`.',
      '',
      'Since it\'s a simple "Hi", I should respond with a friendly greeting.',
    ].join('\n');
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: REASONING_REPLY, toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const history: Array<{ role: string; content: string }> = [];
    const out = await cmd.runChatAnswer(
      'Hi',
      history,
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      // No failover candidates in this harness, so the walk exhausts and the
      // turn must surface as a FAILURE rather than a successful answer.
      { auto: false },
    );

    // The thinking is NOT the answer…
    expect(out.content ?? '').not.toContain('The user said');
    expect(out.content ?? '').not.toContain('According to the instructions');
    // …and the turn is marked failed (so it is never cached as a success).
    expect(out.generationFailed).toBe(true);
    // Nothing was written to history as an answer.
    expect(history.some((t) => t.role === 'assistant')).toBe(false);
  });

  it('still accepts a real answer that merely mentions the user', async () => {
    // The guard must not burn good replies: `user` is a table in this codebase.
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({
        content: 'The user table now has an index — your request is implemented.',
        toolCalls: [],
      }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    const history: Array<{ role: string; content: string }> = [];
    const out = await cmd.runChatAnswer(
      'did the migration run?',
      history,
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
    );
    expect(out.content).toBe('The user table now has an index — your request is implemented.');
    expect(out.generationFailed).toBeFalsy();
  });

  // ── G3 + G4 — working-state memory (cross-turn + regression) ──────────────

  it('G4 — injects the project working state into the model-facing thread', async () => {
    const { recordWorkingState } = await import('../../src/learning/working-state.js');
    // Seed a ledger for the turn's project (runChatAnswer defaults to cwd).
    recordWorkingState(process.cwd(), {
      filesTouched: ['script.js', 'style.css'],
      unverifiedEdit: true,
      userMessage: 'still same issue with the dropdowns',
    });

    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Acknowledged.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer('continue', [], { type: 'groq', provider, model: 'mock-model' }, {}, false, {
      auto: false,
    });

    const sent = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const block = sent.find((m) => m.content.includes('Working state'));
    expect(block).toBeDefined();
    expect(block!.content).toContain('script.js');
    expect(block!.content).toContain('NEVER verified');
    expect(block!.content).toContain('dropdowns');
  });

  it('session 3 — channel policy rides in the STABLE layer, never the user turn', async () => {
    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Delivered directly.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer(
      '[Origin: WhatsApp chat 91…]\n\nwrite a haiku',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
      undefined,
      { systemPolicy: 'RESPONSE FORMAT (non-negotiable for messaging app replies):' },
    );

    const sent = (provider.generateTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const system = sent.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const users = sent.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    // The policy is part of the stable layer...
    expect(system).toContain('RESPONSE FORMAT (non-negotiable');
    // ...and NOT re-injected into the ask.
    expect(users).not.toContain('RESPONSE FORMAT (non-negotiable');
    expect(users).toContain('write a haiku');
  });

  it('G3 — records a user regression report to the ledger', async () => {
    const { getWorkingState, clearWorkingState } = await import('../../src/learning/working-state.js');
    clearWorkingState(process.cwd());

    const provider = {
      name: 'Mock',
      generateTools: vi.fn().mockResolvedValue({ content: 'Looking into it.', toolCalls: [] }),
      generate: vi.fn().mockResolvedValue('unused'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;

    const cmd = new ChatCommand() as unknown as { runChatAnswer: Function };
    await cmd.runChatAnswer(
      'still same issue — the converter dropdowns are empty',
      [],
      { type: 'groq', provider, model: 'mock-model' },
      {},
      false,
      { auto: false },
    );

    const state = getWorkingState(process.cwd());
    expect(state).not.toBeNull();
    expect(state!.corrections).toBeGreaterThanOrEqual(1);
    expect(state!.openIssues.some((i) => i.includes('dropdowns'))).toBe(true);
  });
});
