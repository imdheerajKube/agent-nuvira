/**
 * End-to-end chat-level regression test — the full auto-routing repair +
 * failover flow observed in production:
 *
 *   stale gemini pin (gemini-2.0-flash-exp, retired by Google) → model-health
 *   REPAIR to a registry-verified model (gemini-2.5-flash) → gemini FAILS at
 *   generation → auto failover to local → local's stale pin (llama2) is also
 *   repaired (gemma4:e4b) → the answer comes from local. Crucially, the
 *   repairs are LEARNED once in the Model Availability Registry, so the next
 *   message repairs SILENTLY — the "model X is not available" warning never
 *   repeats (the recursion that made auto routing look broken).
 *
 * Driven through the REAL ChatCommand.execute() single-shot path (exactly what
 * `buff chat "<prompt>" --provider auto --model auto` runs): real
 * routeMessageAuto, real runSingleShotAuto (failover walk), real
 * resolveWorkingModel (repair + registry teaching + silent fast-path), real
 * generateWithContext, real failure bookkeeping, and the real Model
 * Availability Registry (isolated to a temp BUFF_MEMORY_DIR). Only the
 * plumbing is mocked: resolveProvider, the auto-router decision (stale pins),
 * the background model probe, and the active-model-state file read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { logger } from '../../src/utils/logger.js';
import type { InferenceProvider } from '../../src/inference/interface.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { clearModelListCache } from '../../src/inference/model-validator.js';
import { setVectorBackendOverride, resetVectorBackendSelection } from '../../src/memory/vector-store.js';

// ─── Module-level mocks (plumbing only) ─────────────────────────────────────

const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockRouterResolve = vi.hoisted(() => vi.fn());

// The stale pins Auto routing "resolves" — the user's real config pinned
// gemini to the retired gemini-2.0-flash-exp and local to llama2.
const mockResolveModel = vi.hoisted(() =>
  vi.fn((provider: string) =>
    provider === 'gemini' ? 'gemini-2.0-flash-exp' : provider === 'local' ? 'llama2' : 'default',
  ),
);

// Fake providers:
// - gemini lists only LIVE models (the retired pin is absent from the list —
//   exactly the user's "gemini-2.0-flash-exp is not available" probe result)
//   and FAILS at generation with a NETWORK error (transient: keeps
//   gemini-2.5-flash verified, so the next message takes the silent-repair
//   path rather than the predictive-block path).
// - local lists gemma4:e4b and answers successfully.
const geminiGenerate = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('fetch failed: Gemini API unreachable')));
const localGenerate = vi.hoisted(() => vi.fn().mockResolvedValue('local answer'));

const fakeGemini = {
  name: 'Fake Gemini',
  listModels: async () => [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', tags: ['chat'] },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', tags: ['chat'] },
  ],
  isAvailable: async () => true,
  generate: geminiGenerate,
  getInfo: () => 'Fake Gemini',
} as unknown as InferenceProvider;

const fakeLocal = {
  name: 'Fake Local',
  listModels: async () => [{ id: 'gemma4:e4b', name: 'Gemma 4', provider: 'local', tags: ['chat'] }],
  isAvailable: async () => true,
  generate: localGenerate,
  getInfo: () => 'Fake Local',
} as unknown as InferenceProvider;

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    isAutoModel: actual.isAutoModel,
    isAutoProvider: actual.isAutoProvider,
    getAutoRouter: () => ({
      resolve: (...args: unknown[]) => mockRouterResolve(...args),
      resolveModel: (...args: unknown[]) => mockResolveModel(...args),
    }),
  };
});

// Background probe — the pre-seeded registry never triggers it, but a stray
// probe must never touch the network in tests.
vi.mock('../../src/inference/model-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inference/model-probe.js')>();
  return {
    ...actual,
    refreshModelRegistry: vi.fn().mockResolvedValue({
      providersProbed: [], modelsListed: 0, verified: 0, unavailable: 0, skipped: 0, errors: 0,
    }),
    spotCheckModel: vi.fn().mockResolvedValue('verified'),
  };
});

// execute() applies the persisted active-model state file — keep it a
// passthrough so the test's explicit --provider auto --model auto win.
vi.mock('../../src/cli/model.js', () => ({
  applyActiveModel: (options: { provider?: string; model?: string }) => options,
}));

// The real generateWithContext runs in this test (its spinner is the only
// ora consumer) — silence the spinner so test output stays clean.
vi.mock('ora', () => {
  const spinner = {
    start: function () { return spinner; },
    stop: () => {},
    fail: () => {},
    succeed: () => {},
  };
  return { default: () => spinner };
});

// ─── Test setup ─────────────────────────────────────────────────────────────

describe('ChatCommand E2E — stale pin → silent repair → gemini failure → local failover', () => {
  let tempDir: string;
  let configTempDir: string;
  let originalMemoryDir: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    geminiGenerate.mockClear();
    localGenerate.mockClear();

    // Isolate BOTH the memory dir (registry / ledger / routing history) and the
    // CONFIG dir: without the latter, ConfigManager would read the machine's
    // real buffconfig — a multi-key gemini config there would make the
    // failover runner's M2.3 key rotation call generate() once per key and
    // break the exact call-count assertions. An empty config dir → defaults.
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-e2e-'));
    configTempDir = mkdtempSync(join(tmpdir(), 'buff-chat-e2e-cfg-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    originalConfigDir = process.env.BUFF_CONFIG_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    process.env.BUFF_CONFIG_DIR = configTempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
    clearModelListCache();

    // The registry ALREADY knows the replacement models work — verified in a
    // prior session (the "(verified working)" state from the user's log) —
    // while the PINNED models are stale/untracked. This is what makes repair
    // teach the registry once and stay SILENT on every later route.
    getModelRegistry().markVerified('gemini', 'gemini-2.5-flash', 'telemetry');
    getModelRegistry().markVerified('local', 'gemma4:e4b', 'telemetry');

    // Router: the auto decision always picks gemini (with its stale pin);
    // local is ranked next for failover.
    mockResolveProvider.mockImplementation((_cm: unknown, type?: string) => ({
      type: type || 'gemini',
      provider: type === 'local' ? fakeLocal : fakeGemini,
    }));
    mockRouterResolve.mockReturnValue({
      agentType: 'chat', provider: 'gemini', model: 'gemini-2.0-flash-exp',
      complexity: 'simple', taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
      escalationApplied: false, taskType: 'chat', score: 0.8,
      weights: {}, ranked: [{ provider: 'local', score: 0.5, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' }],
      fallbackChain: [], explanation: 'test', routedBy: 'heuristic',
    });
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    if (originalConfigDir === undefined) {
      delete process.env.BUFF_CONFIG_DIR;
    } else {
      process.env.BUFF_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configTempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Run one single-shot auto message through the REAL CLI entry point —
   * `buff chat "<prompt>" --provider auto --model auto`. Returns the response
   * the CLI would print (captured from its console.log for THIS message).
   *
   * NOTE: execute() registers a process SIGINT handler (with process.exit(0))
   * that is never removed on the single-shot early-return path; each call
   * leaks one handler onto the vitest worker. Harmless here (workers are
   * per-file, no SIGINT is sent), just known.
   */
  async function runAutoChatMessage(prompt: string): Promise<string> {
    const logSpy = console.log as any;
    const startIndex = logSpy.mock.calls.length;
    const cmd = new ChatCommand() as any;
    await cmd.execute(prompt, { provider: 'auto', model: 'auto' });
    const printed = logSpy.mock.calls
      .slice(startIndex)
      .map((c: unknown[]) => String(c[0]))
      .find((line) => line.includes('local answer'));
    return printed?.trim() ?? '';
  }

  /** The model-health repair warnings ("model X is not available on Y"). */
  const repairWarnings = (): string[] =>
    (logger.warn as any).mock.calls.map((c: unknown[]) => String(c[0])).filter((w) => w.includes('is not available on'));

  it('repairs the stale gemini pin, fails over to local on gemini failure, and lands on the repaired local model', async () => {
    const result = await runAutoChatMessage('explain how auto routing picks a provider');

    // The answer comes from LOCAL after gemini failed at generation.
    expect(result).toContain('local answer');
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    expect(localGenerate).toHaveBeenCalledTimes(1);

    // gemini was attempted with the REPAIRED model (stale pin swapped out)…
    expect((geminiGenerate.mock.calls[0][1] as { model?: string })?.model).toBe('gemini-2.5-flash');
    // …and local answered with ITS repaired model.
    expect((localGenerate.mock.calls[0][1] as { model?: string })?.model).toBe('gemma4:e4b');

    // The failover was explicit and telemetry-correct.
    const successLogs = (logger.success as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(successLogs.some((s) => s.includes('Auto failover: answered from Fake Local'))).toBe(true);

    // Repair warnings: exactly ONE per stale pin (the learning event) — the
    // header route, the prompt route, and the failover route re-picked the
    // dead pin but only the FIRST route warned.
    const warnings = repairWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("'gemini-2.0-flash-exp'") && w.includes('gemini-2.5-flash'))).toBe(true);
    expect(warnings.some((w) => w.includes("'llama2'") && w.includes('gemma4:e4b'))).toBe(true);

    // The registry LEARNED both stale pins are dead (this is what makes the
    // next message silent).
    const registry = getModelRegistry();
    expect(registry.getEntry('gemini', 'gemini-2.0-flash-exp')?.status).toBe('unavailable');
    expect(registry.getEntry('local', 'llama2')?.status).toBe('unavailable');
  });

  it('does not repeat the repair warnings on the next message — repairs are learned once', async () => {
    // Message 1: learns both stale pins (exactly 2 repair warnings).
    const first = await runAutoChatMessage('explain how auto routing picks a provider');
    expect(first).toContain('local answer');
    expect(repairWarnings()).toHaveLength(2);
    expect(geminiGenerate).toHaveBeenCalledTimes(1);

    // Message 2: a FRESH chat session (new ChatCommand, shared registry) —
    // the pins are now known-dead, so repair is SILENT. Zero warnings repeat.
    const second = await runAutoChatMessage('explain context-fit routing');
    expect(second).toContain('local answer');
    expect(repairWarnings()).toHaveLength(2); // still only the 2 learning warnings

    // gemini is still attempted once per message (silently repaired to the
    // verified model) and still fails over to local — never a re-warned retry
    // loop. Failover warning fires exactly once per message too.
    expect(geminiGenerate).toHaveBeenCalledTimes(2);
    expect(localGenerate).toHaveBeenCalledTimes(2);
    const failoverWarnings = (logger.warn as any).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((w) => w.includes('trying the next auto candidate'));
    expect(failoverWarnings).toHaveLength(2);

    // The silent repair in message 2 still used the verified models.
    expect((geminiGenerate.mock.calls[1][1] as { model?: string })?.model).toBe('gemini-2.5-flash');
    expect((localGenerate.mock.calls[1][1] as { model?: string })?.model).toBe('gemma4:e4b');
  });
});
