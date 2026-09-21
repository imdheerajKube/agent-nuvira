/**
 * ADMIN GOVERNANCE on the PINNED chat path (chat, dashboard console, gateway).
 *
 * WHY THIS EXISTS
 *
 * The admin policy (provider/model allow+deny lists, the PII privacy hard-gate)
 * is enforced inside `autoRouter.resolve()`. An explicit provider/model pin —
 * what a user sets with `--provider`/`/model`, and what the dashboard console
 * and the gateway chat engine inherit from the active model — BYPASSES the
 * router entirely. So the pinned path was the one way to serve a provider the
 * policy rules out, and a failed pinned turn would silently continue on one:
 * a PII-classified task would leave a compliant local provider and land on a
 * low-privacy cloud provider the privacy gate forbids.
 *
 * A privacy policy any pin can bypass is not a policy. These tests pin the
 * enforcement, and that a configured policy stays inert when it does not apply.
 *
 * NOTE on the mock: the router module is mocked ONCE, and each test swaps the
 * fake provider's `generate` through the `mockProviders` holder. Calling
 * `mockImplementation` per test would leak into the next one (`clearAllMocks`
 * clears calls, not implementations) — which silently broke an unrelated
 * failover test in the sibling suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ChatCommand } from '../../src/cli/chat.js';
import { logger } from '../../src/utils/logger.js';

// ─── Module mocks ───────────────────────────────────────────────────────────

/** Per-type fake `generate` implementations, swapped by each test. */
const mockProviders: { generate: Record<string, ReturnType<typeof vi.fn>> } = { generate: {} };

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_cm: any, type: string) => ({
    type,
    provider: {
      name: type === 'local' ? 'Local' : type === 'groq' ? 'Groq' : 'Gemini',
      isAvailable: vi.fn().mockResolvedValue(true),
      // Late-bound: resolves the CURRENT per-type fake at call time.
      generate: (...args: unknown[]) => (mockProviders.generate[type] ?? vi.fn())(...args),
    },
  })),
}));

vi.mock('../../src/inference/model-validator.js', () => ({
  resolveWorkingModel: vi.fn((_p: any, _t: string, desired: string) => Promise.resolve(desired)),
}));

const PII_TASK = 'rotate the api_key in production';
const PII_POLICY = { piiPatterns: ['api[_-]?key'], minPrivacyForPii: 1.0 };

/** ConfigManager-shaped stub carrying a governance policy. */
function stubConfig(governance: unknown, providers: Record<string, unknown> = {}, fallbackProviders: string[] = []) {
  return {
    getAll: () => ({
      routing: { governance },
      fallback: { enabled: true, providers: fallbackProviders, maxAttempts: 3, retryDelayMs: 0 },
      providers,
    }),
    hasRequiredCredentials: () => true,
    getProviderConfig: (p: string) => ({ type: p, config: {} }),
  };
}

describe('pinned chat path honors admin governance', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    mockProviders.generate = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('refuses a pinned provider the policy rules out, BEFORE any network call', async () => {
    const generate = vi.fn();
    mockProviders.generate.gemini = generate;
    const cmd = new ChatCommand() as any;
    cmd.configManager = stubConfig({ denyProviders: ['gemini'] });

    const session = { type: 'gemini', provider: { name: 'Gemini', generate }, model: 'gemini-2.0-flash' };
    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: false });

    await expect(callModel([{ role: 'user', content: 'explain this' }], [])).rejects.toThrow(/Governance policy/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('never leaks a PII task to a low-privacy provider when the pinned one fails', async () => {
    const geminiGenerate = vi.fn().mockResolvedValue('should never be reached');
    const localGenerate = vi.fn().mockRejectedValue(new Error('429 rate limit exceeded'));
    mockProviders.generate.gemini = geminiGenerate;
    mockProviders.generate.local = localGenerate;
    const cmd = new ChatCommand() as any;
    // The PINNED provider is `local` (privacy 1.0 → permitted); the only
    // fallback is a cloud provider the privacy gate forbids.
    cmd.configManager = stubConfig(PII_POLICY, { gemini: { model: 'gemini-2.0-flash' } }, ['gemini']);

    const session = { type: 'local', provider: { name: 'Local', generate: localGenerate }, model: 'gemma4:e4b' };
    const callModel = (cmd as any).buildToolCallModel(PII_TASK, session, {}, { auto: false });

    await expect(callModel([{ role: 'user', content: PII_TASK }], [])).rejects.toThrow(/Governance policy/);
    // The cloud provider was never even asked — that is the leak being closed.
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it('names the policy in the user-facing message instead of blaming the model', async () => {
    // `toUserFacingGenerationError` classifies POLICY_BLOCK by name, so a blocked
    // turn reports the rule rather than "the language model was unavailable".
    const { toUserFacingGenerationError } = await import('../../src/inference/tool-call-utils.js');
    const msg = toUserFacingGenerationError(
      new Error("Governance policy: 'gemini' is on the admin denyProviders list"),
    );
    expect(msg).toMatch(/admin denyProviders list/);
    expect(msg).not.toMatch(/unavailable/i);
  });

  it('does not interfere with an ordinary failover when the policy does not apply', async () => {
    // A policy is configured but says nothing about this task or these
    // providers — the pinned walk must behave exactly as it did before.
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValue('answered by the fallback provider');
    mockProviders.generate.groq = generate;
    mockProviders.generate.gemini = generate;
    const cmd = new ChatCommand() as any;
    cmd.configManager = stubConfig(
      { denyProviders: ['nim'], piiPatterns: ['api[_-]?key'] },
      { gemini: { model: 'gemini-2.0-flash' } },
      ['gemini'],
    );

    const session = { type: 'groq', provider: { name: 'Groq', generate }, model: 'llama-3.3-70b-versatile' };
    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: false });

    const result = await callModel([{ role: 'user', content: 'explain this' }], []);
    expect(result.content).toBe('answered by the fallback provider');
  });
});
