/**
 * ChatCommand.answerOnce — configured-default parity between surfaces.
 *
 * The dashboard chat console (`ChatConsole.answer` → `answerOnce(message, {})`)
 * and the gateway chat engine call answerOnce with NO provider and NO model.
 * The CLI's interactive chat resolves its mode from the CONFIG (the shipped
 * `defaultProvider: "auto"`), so it walks every ranked candidate on failure.
 *
 * Live regression this pins (2026-09-20): because auto mode was only ever
 * enabled by an EXPLICIT 'auto' (flag or `nuvira model switch` state), the
 * dashboard silently resolved ONE concrete provider and ran with `auto: false`.
 * The non-auto path only walks `fallback.providers` (which ships empty), so a
 * single provider 400 ended the whole turn with the canned "the language model
 * was unavailable" line — while the CLI answered the identical prompt, because
 * the CLI got auto routing. Same engine, same config, two different modes.
 *
 * The active-model state is pinned to "nothing set" so this test does not
 * depend on the developer's `~/.nuvira/active-model.json`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/model.js')>();
  return {
    ...actual,
    // `nuvira model switch` state is absent → the caller's options are untouched.
    applyActiveModel: (options: { provider?: string; model?: string }) => options,
  };
});

/**
 * The no-model PIPELINE fallback, as a spy.
 *
 * Mocked so this file can WITNESS whether a refused turn was re-dispatched: the
 * fallback keys on `generationFailed`, which an isolation refusal also sets, so
 * before the `refused` guard the whole pipeline ran the ask — in the real tree —
 * and the refusal was never mentioned to the operator. A spy on the import is not
 * enough here (ESM bindings are read-only), hence a module mock.
 */
const mockRunPipelineTool = vi.hoisted(() => vi.fn(async () => ({ success: true, result: { summary: 'pipeline ran' } })));
vi.mock('../../src/tools/pipeline-tool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/pipeline-tool.js')>();
  return { ...actual, runPipelineTool: mockRunPipelineTool };
});

import { ChatCommand } from '../../src/cli/chat.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

/** A git-free directory (a fresh `mkdtemp` has no repository above it either). */
function nonGitDir(): string {
  return mkdtempSync(join(tmpdir(), 'buff-refusal-'));
}

describe('ChatCommand.answerOnce — no explicit provider/model honors defaultProvider', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-answer-once-parity-'));
    // Hermetic: a fresh config dir still defaults to `defaultProvider: 'auto'`.
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

  function mockProvider(): InferenceProvider {
    return {
      name: 'Mock',
      generateTools: vi.fn(async () => ({ content: 'Answered.', toolCalls: [] })),
      generate: vi.fn().mockResolvedValue('Answered.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
  }

  type Proto = { getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }>; routeMessageAuto: (m: string) => Promise<{ type: string; provider: InferenceProvider; model?: string }> };

  it("engages auto routing when the caller passes neither provider nor model", async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto')
      .mockResolvedValue({ type: 'gemini', provider, model: 'mock-model' });

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {});

    // The AUTO branch resolves the initial provider with NO hint, then routes
    // per message. Both of the next two assertions are the regression pins:
    // before the fix routeMessageAuto was never called (auto mode off) and the
    // turn was reported against the CONCRETE default provider (groq).
    const initial = getProvider.mock.calls[0]?.[0] as { provider?: string; model?: string } | undefined;
    expect(initial?.provider).toBeUndefined();
    expect(initial?.model).toBeUndefined();
    expect(routeMessageAuto).toHaveBeenCalledWith('hello there');
    expect(out.content).toBe('Answered.');
    expect(out.provider).toBe('gemini');
  });

  it('still pins an explicit provider/model (no auto routing)', async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto');

    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce('hello there', {
      provider: 'groq',
      model: 'mock-model',
    });

    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq', model: 'mock-model' }));
    expect(routeMessageAuto).not.toHaveBeenCalled();
    expect(out.content).toBe('Answered.');
    expect(out.provider).toBe('groq');
  });

  it('E2 — a pinned ask re-dispatched into the pipeline SAYS SO instead of flipping engines silently', async () => {
    // Falling back to the multi-agent pipeline when the chat loop generated
    // nothing is legitimate — but it changes the EXECUTION MODEL, so it must be
    // disclosed. Silence here is the same defect as an unattended auto-pick
    // reported as the user's own choice: the user is owed the reason, and the
    // fact that their pin is the pair carried over.
    const provider = mockProvider();
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto');
    vi.spyOn(ChatCommand.prototype as unknown as { runChatAnswer: Function }, 'runChatAnswer').mockResolvedValue({
      content: '',
      followups: [],
      generationFailed: true,
      toolCalls: [],
      successfulToolCalls: [],
    });
    mockRunPipelineTool.mockClear();

    const progress: string[] = [];
    const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce(
      'write a file called e2-probe.txt saying hi',
      { provider: 'groq', model: 'mock-model', onProgress: (m: string) => progress.push(m) },
    );

    // The engine change happened…
    expect(mockRunPipelineTool).toHaveBeenCalledTimes(1);
    expect(String(out.content)).toBe('pipeline ran');
    // …and was not silent: the pin is still pinned, and the reader is told.
    expect(routeMessageAuto).not.toHaveBeenCalled();
    const line = progress.find((m) => m.includes('multi-agent pipeline instead'));
    expect(line).toBeTruthy();
    expect(line).toContain('the same pinned pair');
  });

  it('WS5 — REFUSES a turn it cannot isolate, and never re-dispatches it to the pipeline', async () => {
    const provider = mockProvider();
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider').mockResolvedValue({ type: 'groq', provider });
    vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto').mockResolvedValue({
      type: 'gemini',
      provider,
      model: 'mock-model',
    });
    mockRunPipelineTool.mockClear();
    const dir = nonGitDir();
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      // A WRITE ask on purpose: those are the asks the rules dispatch to the
      // pipeline, which is exactly the fallback that must not fire. A message the
      // rules ignore would prove nothing.
      const out = await (new ChatCommand() as unknown as { answerOnce: Function }).answerOnce(
        'write a file called refusal-probe.txt saying hi',
        { worktree: true },
      );
      // Failed, and failed by REFUSING — so no surface renders it as an answer.
      expect(out.generationFailed).toBe(true);
      expect(out.refused).toBe(true);
      // The reason reaches the reader instead of being replaced by the fallback's
      // outcome (the live run printed a three-task pipeline board and no reason).
      expect(String(out.content)).toContain('Isolation was requested');
      expect(String(out.content)).toContain('Nothing ran');
      // THE WITNESS: the pipeline never ran, so nothing was written anywhere —
      // least of all into the real tree the operator asked to protect.
      expect(mockRunPipelineTool).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The CLI's OWN entry point — `ChatCommand.execute`.
 *
 * Everything above proves `answerOnce` honours the configured default. But
 * `answerOnce` is the DASHBOARD/GATEWAY path; `execute` is a SEPARATE
 * implementation, and it is the one the CLI actually runs — `-t/--task`
 * dispatches into it, `chat "<task>"` is it, and the REPL is it. It was the one
 * that drifted.
 *
 * Live, measured 2026-10-06, on a config whose `defaultProvider` is `auto`
 * (the shipped default): `nuvira -t "<task>"` logged `autoMode:false,
 * providerOption:undefined, type:"groq"` and appended ZERO rows to
 * routing-history. Because `autoMode` was false it took the non-auto path, and
 * `resolveProvider(config, undefined)` resolved `defaultProvider: "auto"`
 * through `rankAvailableProviders()` to ONE concrete provider. Everything
 * downstream of the auto router was skipped on the product's most common entry
 * point: no `routeMessageAuto` (so no routing-history row auditing which model
 * served the turn, no routing cache, and no capability gate), no pin
 * pre-flight, and `model explain` — which DOES use the auto router — predicting
 * a model the runtime never used (D4).
 */
describe('ChatCommand.execute — the CLI entry honours the configured default too', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-execute-parity-'));
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

  function mockProvider(): InferenceProvider {
    return {
      name: 'Mock',
      generateTools: vi.fn(async () => ({ content: 'Answered.', toolCalls: [] })),
      generate: vi.fn().mockResolvedValue('Answered.'),
      isAvailable: vi.fn().mockResolvedValue(true),
      getInfo: () => 'Mock',
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as InferenceProvider;
  }

  type Proto = {
    getProvider: (o?: unknown) => Promise<{ type: string; provider: InferenceProvider }>;
    routeMessageAuto: (m: string) => Promise<unknown>;
    runChatAnswer: (...args: unknown[]) => Promise<unknown>;
  };

  it('engages auto routing with neither -p nor -m, and hands the routed pair to the engine', async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto')
      .mockResolvedValue({ type: 'gemini', provider, model: 'mock-model', complexity: 'moderate', ranked: [], score: 0 });
    const runChatAnswer = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'runChatAnswer')
      .mockResolvedValue({ content: 'Answered.', followups: [] });

    await (new ChatCommand() as unknown as { execute: Function }).execute('hello there', {});

    // The regression pin: before the fix `execute` never called this, because
    // `autoMode` came only from `-p/-m`/`model switch` and not from the config.
    expect(routeMessageAuto).toHaveBeenCalled();
    // The AUTO branch resolves the initial provider with NO hint (no concrete
    // pin is smuggled in through `resolveProvider`'s own ranking).
    expect(getProvider.mock.calls[0]?.[0]).toEqual({});
    // …and the pair the router chose is what the engine is told to run on.
    expect(runChatAnswer.mock.calls[0]?.[2]).toMatchObject({ type: 'gemini', model: 'mock-model' });
  });

  it('a pin still pins: no auto routing, and the pinned pair reaches the engine', async () => {
    const provider = mockProvider();
    const getProvider = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'getProvider')
      .mockResolvedValue({ type: 'groq', provider });
    const routeMessageAuto = vi.spyOn(ChatCommand.prototype as unknown as Proto, 'routeMessageAuto');
    const runChatAnswer = vi
      .spyOn(ChatCommand.prototype as unknown as Proto, 'runChatAnswer')
      .mockResolvedValue({ content: 'Answered.', followups: [] });

    await (new ChatCommand() as unknown as { execute: Function }).execute('hello there', {
      provider: 'groq',
      model: 'mock-model',
    });

    expect(routeMessageAuto).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq', model: 'mock-model' }));
    expect(runChatAnswer.mock.calls[0]?.[2]).toMatchObject({ type: 'groq', model: 'mock-model' });
  });
});
