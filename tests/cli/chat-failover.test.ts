/**
 * Chat command — E3b tool-loop auto-failover confirmation tests.
 *
 * Regression tests for `routing.promptOnFailover` on the chat tool-loop path
 * (`buildToolCallModel`'s auto-mode failover walk — the E3b successor to the
 * deleted single-shot `generateAutoWithFailover`): when a provider fails
 * mid-call, Auto mode walks the ranked candidates. With promptOnFailover
 * enabled the CLI must ASK before auto-switching to the next candidate;
 * choosing 'manual' surfaces the original error instead of silently
 * switching (single-shot has no interactive recovery, so the CLI exits with
 * the failure — matching non-auto behavior). A non-interactive stdin skips
 * the prompt entirely (piped/CI safety).
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
import { resolveProvider } from '../../src/cli/router.js';

const mockedShouldConfirm = vi.mocked(shouldConfirmFailover);
const mockedPromptChoice = vi.mocked(promptFailoverChoice);

describe('tool-loop auto failover — promptOnFailover confirmation', () => {
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
   * Build a ChatCommand wired to an auto-mode tool-loop failover walk:
   * - the session provider (groq) throws on generate,
   * - routeMessageAuto returns gemini (ranked next) whose generate succeeds.
   * Returns the command, the session, and the generation mock.
   */
  function setupCommand(): {
    cmd: ChatCommand;
    session: { type: string; provider: { name: string; generate: ReturnType<typeof vi.fn> }; model: string };
    generateMock: ReturnType<typeof vi.fn>;
  } {
    const generateMock = vi.fn()
      .mockRejectedValueOnce(new Error('429: quota exceeded'))
      .mockResolvedValueOnce('hello from gemini');
    const cmd = new ChatCommand() as any;
    cmd.routeMessageAuto = vi.fn().mockResolvedValue({
      type: 'gemini',
      provider: { name: 'Gemini', generate: generateMock },
      model: 'gemini-2.0-flash',
      ranked: ['gemini'],
      complexity: 'simple',
      score: 0.85,
    });
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generate: generateMock },
      model: 'llama-3.3-70b-versatile',
    };
    return { cmd, session, generateMock };
  }

  it('silently fails over to the next candidate when promptOnFailover is off (default)', async () => {
    const { cmd, session, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(false);

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    const result = await callModel([{ role: 'user', content: 'explain this' }], []);

    expect(result.content).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2); // groq failed → gemini answered
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });

  it('asks before switching and adopts the next candidate when the user confirms', async () => {
    const { cmd, session, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(true);
    mockedPromptChoice.mockResolvedValue('switch');

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    const result = await callModel([{ role: 'user', content: 'explain this' }], []);

    expect(result.content).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Prompt shown once, with the failed provider and the next candidate
    expect(mockedPromptChoice).toHaveBeenCalledTimes(1);
    expect(mockedPromptChoice.mock.calls[0][0]).toBe('Groq');
    expect(mockedPromptChoice.mock.calls[0][1]).toBe('Gemini');
  });

  it('surfaces the original error instead of switching when the user picks manual', async () => {
    const { cmd, session, generateMock } = setupCommand();
    mockedShouldConfirm.mockReturnValue(true);
    mockedPromptChoice.mockResolvedValue('manual');

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    await expect(callModel([{ role: 'user', content: 'explain this' }], []))
      .rejects.toThrow('429: quota exceeded');
    // The gemini candidate was never attempted — 'manual' aborts the walk.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(mockedPromptChoice).toHaveBeenCalledTimes(1);
  });

  it('skips the prompt entirely when stdin is not a TTY (CI / piped safety)', async () => {
    const { cmd, session, generateMock } = setupCommand();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    mockedShouldConfirm.mockReturnValue(true);

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    const result = await callModel([{ role: 'user', content: 'explain this' }], []);

    // Even with promptOnFailover on, a non-interactive stdin falls through to
    // silent auto-failover (the pre-existing safe behavior) instead of
    // blocking forever on an inquirer prompt.
    expect(result.content).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });

  it('does not prompt when there is no next candidate to switch to', async () => {
    const generateMock = vi.fn().mockRejectedValue(new Error('boom'));
    const cmd = new ChatCommand() as any;
    cmd.routeMessageAuto = vi.fn().mockResolvedValue(null);
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generate: generateMock },
      model: 'llama-3.3-70b-versatile',
    };
    mockedShouldConfirm.mockReturnValue(true);

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    await expect(callModel([{ role: 'user', content: 'explain this' }], []))
      .rejects.toThrow('boom');
    // No ranked candidates remain → nothing to offer, so no prompt.
    expect(mockedPromptChoice).not.toHaveBeenCalled();
  });

  it('S3: salvages the model answer from a tool-call 400 failed_generation (Groq-style)', async () => {
    // The observed failure: Groq rejected the CALL because the model emitted
    // an Anthropic-style <function=…> tag in its content — and the COMPLETE
    // essay sat in the error's failed_generation field, thrown away. The
    // salvage path must recover the content AND the followups.
    const essayWire = 'The elephant is a very big animal. \\nIt has a long trunk.'; // JSON-escaped newline
    const errorBody =
      `{"error":{"message":"Failed to call a function.","type":"invalid_request_error","code":"tool_use_failed",` +
      `"failed_generation":"${essayWire}\\n\\n<function=suggest_followups [{\\"prompt\\": \\"What do elephants eat?\\", \\"label\\": \\"Elephant Diet\\"}]</function>"}}`;
    const generateTools = vi.fn().mockRejectedValue(new Error(`Tool-calling API error (400): ${errorBody}`));
    const cmd = new ChatCommand() as any;
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generateTools, generate: vi.fn(), generateStream: vi.fn() },
      model: 'llama-3.3-70b-versatile',
    };
    const callModel = (cmd as any).buildToolCallModel('essay', session, {}, { auto: false });
    const result = await callModel(
      [{ role: 'user', content: 'essay' }],
      [{ name: 'suggest_followups', description: '', parameters: {} }],
    );

    // The essay is delivered (decoded), the tag is stripped, and the
    // followups are recovered as a tool call for the loop to execute.
    expect(result.content).toBe('The elephant is a very big animal. \nIt has a long trunk.');
    expect(result.content).not.toContain('<function');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('suggest_followups');
    const args = result.toolCalls[0].arguments as { followups: Array<{ prompt: string; label?: string }> };
    expect(args.followups[0].prompt).toBe('What do elephants eat?');
    expect(args.followups[0].label).toBe('Elephant Diet');
    expect(generateTools).toHaveBeenCalledTimes(1); // salvaged — no failover walk
  });

  it('S3: does NOT salvage a rejected REAL tool call (only suggest_followups)', async () => {
    // A 400 whose intended call is a real pipeline tool (build) must surface
    // the error — the prose around it is "I'll build…", not the deliverable.
    const errorBody =
      `{"error":{"code":"tool_use_failed","failed_generation":"I will implement the login form. <function=build [{\\"goal\\": \\"login\\"}]</function>"}}`;
    const generateTools = vi.fn().mockRejectedValue(new Error(`Tool-calling API error (400): ${errorBody}`));
    const cmd = new ChatCommand() as any;
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generateTools, generate: vi.fn(), generateStream: vi.fn() },
      model: 'llama-3.3-70b-versatile',
    };
    const callModel = (cmd as any).buildToolCallModel('build login', session, {}, { auto: false });
    await expect(
      callModel([{ role: 'user', content: 'build login' }], [{ name: 'build', description: '', parameters: {} }]),
    ).rejects.toThrow(/Tool-calling API error \(400\)/);
    expect(generateTools).toHaveBeenCalledTimes(1);
  });

  /**
   * A model that cannot do native tool calling must NOT kill the turn.
   *
   * Live regression (reproduced through the fixed router): Groq answered
   *   400 "`tool calling` is not supported with this model"
   * and the WHOLE turn died — the user got "I couldn't complete that request"
   * for a perfectly ordinary question. The loop already ships a transport that
   * needs no provider tool support, so it must fall through to it.
   */
  it('falls through to the JSON transport when the model rejects native tool calling', async () => {
    const generateTools = vi.fn().mockRejectedValue(
      new Error(
        'Tool-calling API error (400): {"error":{"message":"`tool calling` is not supported with this model","type":"invalid_request_error","param":"tool calling"}}',
      ),
    );
    // The JSON transport asks the same model a flattened prompt; it answers in
    // prose with no tool block, which ends the turn cleanly.
    const generate = vi.fn().mockResolvedValue('Division: 20101 ÷ 2 = 10050 remainder 1.');
    const cmd = new ChatCommand() as any;
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generateTools, generate, generateStream: undefined },
      model: 'groq/compound',
    };

    const callModel = (cmd as any).buildToolCallModel('teach division', session, {}, { auto: false });
    const result = await callModel(
      [{ role: 'user', content: 'teach division' }],
      [{ name: 'suggest_followups', description: '', parameters: {} }],
    );

    expect(result.content).toBe('Division: 20101 ÷ 2 = 10050 remainder 1.');
    expect(generateTools).toHaveBeenCalledTimes(1); // tried native first
    expect(generate).toHaveBeenCalledTimes(1); // then the JSON transport
    // The attempted model is recorded, so the trace names it instead of "unknown".
    expect(session.model).toBe('groq/compound');
  });

  /**
   * The PINNED path (an explicit provider/model — what the dashboard console and
   * the gateway chat engine run on) has its own fallback walk, and it used to
   * hand the fallback provider the PRIMARY's model id: a pinned `gemini`
   * /`gemini-3.1-flash-lite` turn that failed tried `groq` with
   * `model: 'gemini-3.1-flash-lite'`, which 404s "model not found". Every
   * fallback candidate then failed for a reason unrelated to the outage and the
   * turn ended as "the language model was unavailable" while healthy providers
   * sat right there. The auto path never had this bug (it passes the
   * candidate's own model), which is exactly why only the pinned surfaces looked
   * dead.
   */
  it('non-auto fallback calls the fallback provider with ITS OWN model, not the primary id', async () => {
    const attempts: Array<{ name: string; model?: string }> = [];
    const generate = vi.fn().mockImplementation(function (
      this: { name: string },
      _prompt: string,
      opts?: { model?: string },
    ) {
      attempts.push({ name: this.name, model: opts?.model });
      if (this.name === 'Groq') return Promise.reject(new Error('429 rate limit exceeded'));
      return Promise.resolve('answered by the fallback provider');
    });

    const cmd = new ChatCommand() as any;
    cmd.configManager = {
      getAll: () => ({
        fallback: { enabled: true, providers: ['gemini'], maxAttempts: 3, retryDelayMs: 0 },
        providers: { gemini: { model: 'gemini-2.0-flash' } },
      }),
      hasRequiredCredentials: (p: string) => p === 'gemini',
      getProviderConfig: (p: string) => ({ type: p, config: {} }),
    };
    vi.mocked(resolveProvider).mockImplementation(((_cm: any, type: string) => ({
      type,
      provider: {
        name: type === 'groq' ? 'Groq' : 'Gemini',
        isAvailable: vi.fn().mockResolvedValue(true),
        generate,
      },
    })) as any);

    const session = {
      type: 'groq',
      provider: { name: 'Groq', generate },
      model: 'llama-3.3-70b-versatile',
    };
    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: false });
    const result = await callModel([{ role: 'user', content: 'explain this' }], []);

    expect(result.content).toBe('answered by the fallback provider');
    const fallbackAttempt = attempts.find((a) => a.name === 'Gemini');
    expect(fallbackAttempt).toBeDefined();
    expect(fallbackAttempt!.model).toBe('gemini-2.0-flash');
    expect(fallbackAttempt!.model).not.toBe('llama-3.3-70b-versatile');
  });

  it('does not waste the walk on a fallback provider the user has no credential for', async () => {
    const attempts: string[] = [];
    const generate = vi.fn().mockImplementation(function (this: { name: string }) {
      attempts.push(this.name);
      return Promise.reject(new Error('429 rate limit exceeded'));
    });

    const cmd = new ChatCommand() as any;
    cmd.configManager = {
      // `nim` is in the explicit chain but has NO key: it must be skipped, not
      // attempted (an unauthenticated endpoint costs a full connection timeout
      // before the next candidate is tried).
      getAll: () => ({
        fallback: { enabled: true, providers: ['nim', 'gemini'], maxAttempts: 3, retryDelayMs: 0 },
        providers: { gemini: { model: 'gemini-2.0-flash' } },
      }),
      hasRequiredCredentials: (p: string) => p === 'gemini',
      getProviderConfig: (p: string) => ({ type: p, config: {} }),
    };
    vi.mocked(resolveProvider).mockImplementation(((_cm: any, type: string) => ({
      type,
      provider: { name: type === 'groq' ? 'Groq' : type === 'nim' ? 'NIM' : 'Gemini', isAvailable: vi.fn().mockResolvedValue(true), generate },
    })) as any);

    const session = { type: 'groq', provider: { name: 'Groq', generate }, model: 'llama-3.3-70b-versatile' };
    const callModel = (cmd as any).buildToolCallModel('q', session, {}, { auto: false });
    await expect(callModel([{ role: 'user', content: 'q' }], [])).rejects.toThrow(/429/);

    expect(attempts).not.toContain('NIM');
    expect(attempts).toContain('Gemini');
  });

  it('aggressive: passes the prior software ask into the failover walk (intent-aware, no tiny-local landing)', async () => {
    const { cmd, session, generateMock } = setupCommand();

    const callModel = (cmd as any).buildToolCallModel(
      'yes',
      session,
      {},
      { auto: true },
      undefined,
      undefined,
      'build the macOS app',
    );
    const result = await callModel([{ role: 'user', content: 'yes' }], []);

    expect(result.content).toBe('hello from gemini');
    expect(generateMock).toHaveBeenCalledTimes(2);
    // The walk must route on the prior software ask, not the bare "yes", so
    // the router's agentic capability floor applies on the failover too.
    // C3 — it also carries the origin provider it is failing over FROM.
    const call = cmd.routeMessageAuto.mock.calls[0] as unknown[];
    expect(call[2]).toMatchObject({ routingText: 'build the macOS app', fallbackFrom: 'groq' });
  });

  it('warns clearly when even the agentic floor leaves only a weak model', async () => {
    const generateMock = vi.fn()
      .mockRejectedValueOnce(new Error('429: quota exceeded'))
      .mockResolvedValueOnce('fabricated tool output');
    const cmd = new ChatCommand() as any;
    cmd.routeMessageAuto = vi.fn().mockResolvedValue({
      type: 'local',
      provider: { name: 'Local', generate: generateMock },
      model: 'qwen2.5:0.5b',
      ranked: ['local'],
      complexity: 'simple',
      score: 0.5,
    });
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generate: generateMock },
      model: 'llama-3.3-70b-versatile',
    };

    const callModel = (cmd as any).buildToolCallModel('explain this', session, {}, { auto: true });
    await callModel([{ role: 'user', content: 'explain this' }], []);

    expect(
      vi.mocked(logger.warn).mock.calls.some((c) => String(c[0]).includes('no agentic-capable model left')),
    ).toBe(true);
  });

  it('still fails over on a TRANSIENT error (transport switch is only for tool-incapability)', async () => {
    const generateTools = vi.fn().mockRejectedValue(new Error('429 rate limit exceeded'));
    const generate = vi.fn().mockResolvedValue('should not be reached on the same candidate');
    const cmd = new ChatCommand() as any;
    const session = {
      type: 'groq',
      provider: { name: 'Groq', generateTools, generate },
      model: 'llama-3.3-70b-versatile',
    };
    const callModel = (cmd as any).buildToolCallModel('q', session, {}, { auto: false });
    await expect(
      callModel([{ role: 'user', content: 'q' }], [{ name: 't', description: '', parameters: {} }]),
    ).rejects.toThrow(/429/);
  });

  /**
   * C1 — the failover walk must preserve the ORIGINAL software ask across MORE
   * THAN ONE failure hop. Regression: a single cloud provider dying mid-turn
   * re-routed on the bare message alone, so a software turn fell through to a
   * tiny local model that fabricated tool output. The prior-ask hint must be
   * carried on EVERY hop, not just the first.
   */
  it('C1: preserves the software ask across multiple failure hops', async () => {
    const attempts: string[] = [];
    const generate = vi.fn().mockImplementation(function (this: { name: string }) {
      attempts.push(this.name);
      if (this.name === 'OpenRouter') return Promise.resolve('answered after two hops');
      return Promise.reject(new Error('429: quota exceeded'));
    });

    const cmd = new ChatCommand() as any;
    // Two hops: gemini, then openrouter. The walk must route on the prior
    // software ask BOTH times — not just the first.
    const seq = [
      { type: 'gemini', provider: { name: 'Gemini', generate }, model: 'gemini-2.0-flash', ranked: ['gemini', 'openrouter'], complexity: 'simple', score: 0.8 },
      { type: 'openrouter', provider: { name: 'OpenRouter', generate }, model: 'some/model', ranked: ['openrouter'], complexity: 'simple', score: 0.7 },
    ];
    cmd.routeMessageAuto = vi.fn().mockImplementation(async () => seq.shift() ?? null);

    const session = {
      type: 'groq',
      provider: { name: 'Groq', generate },
      model: 'llama-3.3-70b-versatile',
    };
    const callModel = (cmd as any).buildToolCallModel(
      'yes',
      session,
      {},
      { auto: true },
      undefined,
      undefined,
      'build the macOS app',
    );
    const result = await callModel([{ role: 'user', content: 'yes' }], []);

    expect(result.content).toBe('answered after two hops');
    expect(attempts).toEqual(['Groq', 'Gemini', 'OpenRouter']);
    // Two hops, and the routing text is preserved on EVERY one.
    expect(cmd.routeMessageAuto).toHaveBeenCalledTimes(2);
    for (const call of cmd.routeMessageAuto.mock.calls) {
      expect(call[2]).toMatchObject({ routingText: 'build the macOS app' });
    }
  });
});
