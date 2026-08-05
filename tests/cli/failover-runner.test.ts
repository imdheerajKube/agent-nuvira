/**
 * SingleShotAutoRunner — unit tests for the shared single-shot auto-failover
 * walk (Nuvira-Router M0.2 Stage B).
 *
 * Covers the walk semantics extracted from chat's generateAutoWithFailover:
 * candidate order, availability skipping, per-attempt failure telemetry,
 * prompt-on-failover (manual decline vs silent switch, TTY guard), audit
 * re-record on non-first winners, and last-error throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSingleShotAuto } from '../../src/cli/failover-runner.js';
import { getQuotaLedger, resetQuotaLedger, accountIdForKey } from '../../src/learning/quota-ledger.js';
import type { ConfigManager } from '../../src/config/manager.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockShouldConfirm = vi.hoisted(() => vi.fn(() => false));
const mockPromptChoice = vi.hoisted(() => vi.fn(() => 'manual'));
const mockResolveModel = vi.hoisted(() => vi.fn((type: string) => `${type}-model`));
const mockResolveWorkingModel = vi.hoisted(() => vi.fn(async (_p: unknown, _t: string, desired: string) => desired));
const mockRecordDecision = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: mockResolveProvider,
}));

vi.mock('../../src/cli/failover-prompt.js', () => ({
  shouldConfirmFailover: mockShouldConfirm,
  promptFailoverChoice: mockPromptChoice,
}));

vi.mock('../../src/learning/auto-router.js', () => ({
  getAutoRouter: () => ({ resolveModel: mockResolveModel }),
}));

vi.mock('../../src/inference/model-validator.js', () => ({
  resolveWorkingModel: mockResolveWorkingModel,
}));

vi.mock('../../src/learning/routing-history.js', () => ({
  recordRoutingDecision: mockRecordDecision,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProvider(name: string, available = true) {
  return { name, isAvailable: vi.fn(async () => available) };
}

function makeConfigManager(): ConfigManager {
  return { getAll: () => ({}) } as unknown as ConfigManager;
}

/** Config manager whose provider carries TWO keys (M2.3 multi-account). */
function makeMultiKeyConfigManager(): ConfigManager {
  return {
    getAll: () => ({}),
    getProviderConfig: () => ({ config: { apiKey: 'key-1', apiKeys: ['key-2'] } }),
  } as unknown as ConfigManager;
}

function baseRoute() {
  return {
    type: 'groq',
    provider: makeProvider('Groq'),
    model: 'groq-model',
    ranked: ['nim', 'gemini'],
    complexity: 'medium',
    score: 0.9,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SingleShotAutoRunner — runSingleShotAuto', () => {
  let runnerTempDir: string;
  let runnerOrigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldConfirm.mockReturnValue(false);
    mockResolveProvider.mockImplementation((_cm: unknown, type: string) => ({
      type,
      provider: makeProvider(type),
    }));
    // Isolate the quota ledger (the runner reads/park accounts since M2.3) so
    // rotation tests never touch the real user ledger.
    runnerOrigDir = process.env.BUFF_MEMORY_DIR;
    runnerTempDir = mkdtempSync(join(tmpdir(), 'buff-failover-runner-'));
    process.env.BUFF_MEMORY_DIR = runnerTempDir;
    resetQuotaLedger();
  });

  it('returns the first candidate result without failover telemetry', async () => {
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string) => 'answer');
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 'write a test',
      configManager: makeConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer');
    expect(generate).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it('fails over to the next candidate, recording the failure + audit re-record', async () => {
    const generate = vi.fn(async (_p: unknown, type: string, _m: string) => {
      if (type === 'groq') throw new Error('401 Unauthorized');
      return `answer-${type}`;
    });
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 'write a test',
      configManager: makeConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer-nim');
    // M2.3: the 4th arg is the attempted key — undefined when keyless.
    expect(recordFailure).toHaveBeenCalledWith('groq', 'groq-model', expect.any(Error), undefined);
    // Non-first winner → audit re-record with the actual provider.
    expect(mockRecordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'chat', provider: 'nim', model: 'nim-model' }),
    );
  });

  it('skips unavailable candidates without telemetry and continues', async () => {
    mockResolveProvider.mockImplementation((_cm: unknown, type: string) => ({
      type,
      provider: makeProvider(type, type !== 'groq'), // groq unavailable
    }));
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string) => 'answer');
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer');
    expect(recordFailure).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('throws the last error when every candidate fails, recording each attempt', async () => {
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string) => {
      throw new Error('boom');
    });
    const recordFailure = vi.fn();

    await expect(
      runSingleShotAuto({
        action: 'chat',
        task: 't',
        configManager: makeConfigManager(),
        route: vi.fn(async () => baseRoute()),
        generate,
        recordFailure,
      }),
    ).rejects.toThrow('boom');

    expect(recordFailure).toHaveBeenCalledTimes(3); // groq, nim, gemini
  });

  it('all candidates unavailable: throws the default error, records nothing', async () => {
    mockResolveProvider.mockImplementation((_cm: unknown, type: string) => ({
      type,
      provider: makeProvider(type, false), // every candidate unavailable
    }));
    const generate = vi.fn();
    const recordFailure = vi.fn();

    await expect(
      runSingleShotAuto({
        action: 'chat',
        task: 't',
        configManager: makeConfigManager(),
        route: vi.fn(async () => baseRoute()),
        generate,
        recordFailure,
      }),
    ).rejects.toThrow(/No auto-routed provider succeeded/);

    // Unavailable skips are NOT failures — no telemetry, no generation.
    expect(generate).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('non-TTY: never prompts, fails over silently even when confirmation is enabled', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockShouldConfirm.mockReturnValue(true);
    const generate = vi.fn(async (_p: unknown, type: string, _m: string) => {
      if (type === 'groq') throw new Error('429 rate limit');
      return `answer-${type}`;
    });
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer-nim');
    expect(mockPromptChoice).not.toHaveBeenCalled();
  });

  it('TTY + promptOnFailover: manual choice rethrows the original error', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockShouldConfirm.mockReturnValue(true);
    mockPromptChoice.mockReturnValue('manual');
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string) => {
      throw new Error('auth exploded');
    });
    const recordFailure = vi.fn();

    await expect(
      runSingleShotAuto({
        action: 'chat',
        task: 't',
        configManager: makeConfigManager(),
        route: vi.fn(async () => baseRoute()),
        generate,
        recordFailure,
      }),
    ).rejects.toThrow('auth exploded');

    // Only the first candidate was attempted before the manual decline.
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(mockPromptChoice).toHaveBeenCalled();
  });

  it('TTY + promptOnFailover: switch choice continues to the next candidate', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockShouldConfirm.mockReturnValue(true);
    mockPromptChoice.mockReturnValue('switch');
    const generate = vi.fn(async (_p: unknown, type: string, _m: string) => {
      if (type === 'groq') throw new Error('auth exploded');
      return `answer-${type}`;
    });
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer-nim');
    expect(mockPromptChoice).toHaveBeenCalled();
  });

  it('rotates to the next key of the SAME provider before switching providers (M2.3)', async () => {
    // key-1 rate-limited → the runner must retry with key-2, park key-1's
    // account, and succeed WITHOUT ever touching a different provider.
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string, key?: string) => {
      if (key === 'key-1') throw new Error('429 rate limit exceeded');
      return `answer-with-${key}`;
    });
    const recordFailure = vi.fn();

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeMultiKeyConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure,
    });

    expect(result).toBe('answer-with-key-2');
    // Both keys attempted: key-1 failed, key-2 succeeded.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(1, expect.anything(), 'groq', 'groq-model', 'key-1');
    expect(generate).toHaveBeenNthCalledWith(2, expect.anything(), 'groq', 'groq-model', 'key-2');
    // The dead account is parked so the next run skips key-1 predictively.
    expect(recordFailure).toHaveBeenCalledWith('groq', 'groq-model', expect.any(Error), 'key-1');
    expect(getQuotaLedger().isAccountParked('groq', accountIdForKey('key-1'))).toBe(true);
    expect(getQuotaLedger().isAccountParked('groq', accountIdForKey('key-2'))).toBe(false);
  });

  it('skips an already-parked account on the next run (predictive rotation)', async () => {
    const ledger = getQuotaLedger();
    ledger.parkAccount('groq', accountIdForKey('key-1'), Date.now() + 60_000, 'rate-limit');
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string, key?: string) => `ok-${key}`);

    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeMultiKeyConfigManager(),
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure: vi.fn(),
    });

    expect(result).toBe('ok-key-2');
    // Only the non-parked key was attempted.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.anything(), 'groq', 'groq-model', 'key-2');
  });

  it('keeps the single-attempt behavior when no keys are configured (M2.3 no-op)', async () => {
    const generate = vi.fn(async (_p: unknown, _t: string, _m: string, key?: string) => {
      expect(key).toBeUndefined();
      return 'answer';
    });
    const result = await runSingleShotAuto({
      action: 'chat',
      task: 't',
      configManager: makeConfigManager(), // no getProviderConfig → no keys
      route: vi.fn(async () => baseRoute()),
      generate,
      recordFailure: vi.fn(),
    });
    expect(result).toBe('answer');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    resetQuotaLedger();
    if (runnerOrigDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = runnerOrigDir;
    }
    rmSync(runnerTempDir, { recursive: true, force: true });
  });
});
