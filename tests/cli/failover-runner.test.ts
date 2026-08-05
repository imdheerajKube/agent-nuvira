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

import { runSingleShotAuto } from '../../src/cli/failover-runner.js';
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldConfirm.mockReturnValue(false);
    mockResolveProvider.mockImplementation((_cm: unknown, type: string) => ({
      type,
      provider: makeProvider(type),
    }));
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
    expect(recordFailure).toHaveBeenCalledWith('groq', 'groq-model', expect.any(Error));
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

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });
});
