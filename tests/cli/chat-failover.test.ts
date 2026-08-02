/**
 * Chat command — single-shot auto-failover confirmation tests.
 *
 * Regression tests for `routing.promptOnFailover` on the SINGLE-SHOT path
 * (`buff chat "prompt"` with Auto routing): when a provider fails mid-call,
 * Auto mode walks the ranked candidates. With promptOnFailover enabled the
 * CLI must ASK before auto-switching to the next candidate; choosing 'manual'
 * surfaces the original error instead of silently switching (single-shot has
 * no interactive recovery, so the CLI exits with the failure — matching
 * non-auto behavior).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ChatCommand } from '../../src/cli/chat.js';
import { logger } from '../../src/utils/logger.js';

// ─── Module mocks ───────────────────────────────────────────────────────────

// Mock the failover-prompt module so we can flip the config gate and the
// user's choice deterministically.
vi.mock('../../src/cli/failover-prompt.js', () => ({
  shouldConfirmFailover: vi.fn().mockReturnValue(false),
  promptFailoverChoice: vi.fn().mockResolvedValue('switch'),
}));

// Mock the auto router's model resolver (real one reads machine config).
vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    getAutoRouter: () => ({
      resolve: vi.fn(),
      resolveModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
    }),
  };
});

// Mock the router so candidates resolve to fake providers.
vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_cm: any, type: string) => ({
    type,
    provider: {
      name: type === 'groq' ? 'Groq' : 'Gemini',
      isAvailable: vi.fn().mockResolvedValue(true),
    },
  })),
}));

// Mock the model-health layer to keep the resolved model unchanged.
vi.mock('../../src/inference/model-validator.js', () => ({
  resolveWorkingModel: vi.fn((_provider: any, _type: string, desired: string) => Promise.resolve(desired)),
}));

// ─── Test setup ─────────────────────────────────────────────────────────────

import { shouldConfirmFailover, promptFailoverChoice } from '../../src/cli/failover-prompt.js';

const mockedShouldConfirm = vi.mocked(shouldConfirmFailover);
const mockedPromptChoice = vi.mocked(promptFailoverChoice);

describe('generateAutoWithFailover — single-shot failover confirmation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    mockedShouldConfirm.mockReturnValue(false);
    mockedPromptChoice.mockResolvedValue('switch');
    // The failover prompt is gated on an interactive stdin (a prompt in CI /
    // piped input would block forever) — most tests here exercise the prompt,
    // so simulate an interactive terminal by default.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Restore the real (non-TTY) stdin for the next test.
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  });

  /**
   * Build a ChatCommand wired to a single-shot auto failover:
   * - routeMessageAuto returns groq as the first pick with gemini ranked next
   * - groq's generation throws (quota exhausted), gemini's succeeds
   * Returns the command plus the mocked generateWithContext.
   */
  function setupCommand(): {
    cmd: ChatCommand;
    generateMock: ReturnType<typeof vi.fn>;
  } {
    const cmd = new ChatCommand() as any;
    cmd.routeMessageAuto = vi.fn().mockResolvedValue({
      type: 'groq',
      provider: { name: 'Groq', isAvailable: vi.fn().mockResolvedValue(true) },
      model: 'llama-3.3-70b-versatile',
      ranked: ['gemini'],
      complexity: 'simple',
      score: 0.85,
    });
    const generateMock = vi.fn()
      .mockRejectedValueOnce(new Error('429: quota exceeded'))
      .mockResolvedValueOnce('hello from gemini');
    cmd.generateWithContext = generateMock;
    return { cmd, generateMock };
  }

  it('silently fails over to the next candidate when promptOnFailover is off (default)', async () => {
    const { cmd, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(false);

    const result = await cmd.generateAutoWithFailover('explain this', 'explain this', {}, true);

    expect(result).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2); // groq failed → gemini answered
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });

  it('asks before switching and adopts the next candidate when the user confirms', async () => {
    const { cmd, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(true);
    mockedPromptChoice.mockResolvedValue('switch');

    const result = await cmd.generateAutoWithFailover('explain this', 'explain this', {}, true);

    expect(result).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Prompt shown once, with the failed provider and the next candidate
    expect(mockedPromptChoice).toHaveBeenCalledTimes(1);
    expect(mockedPromptChoice.mock.calls[0][0]).toBe('groq');
    expect(mockedPromptChoice.mock.calls[0][1]).toBe('Gemini');
  });

  it('surfaces the original error instead of switching when the user picks manual', async () => {
    const { cmd, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(true);
    mockedPromptChoice.mockResolvedValue('manual');

    await expect(cmd.generateAutoWithFailover('explain this', 'explain this', {}, true))
      .rejects.toThrow('429: quota exceeded');
    // The gemini candidate was never attempted — 'manual' aborts the walk.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(mockedPromptChoice).toHaveBeenCalledTimes(1);
  });

  it('skips the prompt entirely when stdin is not a TTY (CI / piped safety)', async () => {
    const { cmd, generateMock } = setupCommand();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    mockedShouldConfirm.mockReturnValue(true);

    const result = await cmd.generateAutoWithFailover('explain this', 'explain this', {}, true);

    // Even with promptOnFailover on, a non-interactive stdin falls through to
    // silent auto-failover (the pre-existing safe behavior) instead of
    // blocking forever on an inquirer prompt.
    expect(result).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });

  it('does not prompt when there is no next candidate to switch to', async () => {
    const cmd = new ChatCommand() as any;
    cmd.routeMessageAuto = vi.fn().mockResolvedValue({
      type: 'groq',
      provider: { name: 'Groq', isAvailable: vi.fn().mockResolvedValue(true) },
      model: 'llama-3.3-70b-versatile',
      ranked: [],
      complexity: 'simple',
      score: 0.85,
    });
    const generateMock = vi.fn().mockRejectedValue(new Error('boom'));
    cmd.generateWithContext = generateMock;
    mockedShouldConfirm.mockReturnValue(true);

    await expect(cmd.generateAutoWithFailover('explain this', 'explain this', {}, true))
      .rejects.toThrow('boom');
    // No ranked candidates remain → nothing to offer, so no prompt.
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });
});
