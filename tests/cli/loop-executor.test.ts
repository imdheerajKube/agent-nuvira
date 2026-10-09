/**
 * Loop executor tests (`tests/cli/loop-executor.test.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 1.1: `runToolLoop` as the
 * executor behind `nuvira execute` dispatch. Driven with a scripted provider
 * stub (vi.doMock of the provider router) — no network, no TTY. Asserts the
 * telemetry contract (toolCalls, erroredTools, bounded, durationMs,
 * engineExplanation) the Phase 0 arm comparison relies on, plus failure
 * degradation (never throws).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

/** A scripted provider: queued native tool responses and/or fallback texts. */
function scriptedProvider(opts: {
  native?: boolean;
  responses?: ToolCallResponse[];
  fallbackText?: string[];
  generateError?: Error;
}): InferenceProvider {
  let nativeIdx = 0;
  let fallbackIdx = 0;
  return {
    name: 'Scripted',
    async generate(): Promise<string> {
      throw new Error('generate() should not be reached when generateStream exists');
    },
    async generateStream(_prompt: string, _options: unknown, onToken?: (t: string) => void): Promise<string> {
      if (opts.generateError) throw opts.generateError;
      const text = opts.fallbackText?.[fallbackIdx++] ?? 'no more scripted output';
      // The executor collects the streamed chunks — the token sink must fire
      // (real streaming providers push tokens through it).
      onToken?.(text);
      return text;
    },
    ...(opts.native
      ? {
          async generateTools(_messages: ToolMessage[], _tools: ToolSchema[]): Promise<ToolCallResponse> {
            return opts.responses?.[nativeIdx++] ?? { content: 'done', toolCalls: [] };
          },
        }
      : {}),
  } as InferenceProvider;
}

describe('loop executor — happy path (native transport)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('runs tools and returns the final answer with full telemetry', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [
        { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
        { content: 'The directory has src/ and tests/.', toolCalls: [] },
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('list the project files', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });

    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('The directory has src/ and tests/.');
    expect(result.toolCalls).toEqual(['list_dir']);
    expect(result.erroredTools).toEqual([]);
    expect(result.bounded).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.provider).toBe('scripted');
    expect(typeof result.engineExplanation).toBe('string');
  });

  it('captures errored tools from tool:called events', async () => {
    const provider = scriptedProvider({
      native: true,
      responses: [
        // read_file on a nonexistent path errors → the loop feeds the error
        // back; the next step answers without tools.
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'definitely-missing-file.xyz' } }] },
        { content: 'The file does not exist.', toolCalls: [] },
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('read the missing file', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.erroredTools).toContain('read_file');
    expect(result.toolCalls).toContain('read_file');
  });
});

describe('loop executor — JSON fallback transport', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('parses the fallback JSON tool block and continues the turn', async () => {
    const provider = scriptedProvider({
      fallbackText: [
        'I will check.\n{"tool":"list_dir","arguments":{"path":"."}}',
        'Found src/ and tests/.',
      ],
    });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('what is in this project?', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('Found src/ and tests/.');
    expect(result.toolCalls).toEqual(['list_dir']);
  });
});

describe('loop executor — failure semantics', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.doUnmock('../../src/learning/provider-fallback.js');
    vi.resetModules();
  });

  it('a provider failure returns a shape-complete failed result (never throws)', async () => {
    const provider = scriptedProvider({ fallbackText: ['x'], generateError: new Error('provider down') });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    // No fallback is configured here, so the pinned run has nothing else to
    // walk — this test is about the failure SHAPE, not provider fan-out (the
    // real chain derives from whatever providers the machine has keys for).
    vi.doMock('../../src/learning/provider-fallback.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/provider-fallback.js')>()),
      getProviderFallback: () => ({ getFallbackChain: () => [] }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do something', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result).toHaveProperty('generationFailed');
    expect(result).toHaveProperty('toolCalls');
    expect(result).toHaveProperty('durationMs');
    expect(result.provider).toBe('scripted');
  });
});

describe('loop executor — engine decision echo', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('engineExplanation reflects the tier decision for a local provider', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'done', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'local', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('x', new ConfigManager(), {
      provider: 'local',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.engineExplanation).toContain('local');
  });
});

describe('loop executor — ambient project context', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('completes with skipProjectContext=false on a non-project cwd (best-effort builder)', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'ok', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('hi', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: false,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('ok');
  });
});

describe('loop executor — loop-side skill match hint (Phase 3.2)', () => {
  let memDir = '';
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    envBackup.NUVIRA_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
    memDir = mkdtempSync(join(tmpdir(), 'buff-exec-hint-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
  });

  afterEach(() => {
    if (envBackup.NUVIRA_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = envBackup.NUVIRA_MEMORY_DIR;
    rmSync(memDir, { recursive: true, force: true });
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('a matching goal does not break the turn and the hint stays out of the final answer', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'done', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    // A capability-skill goal (the bundled batch is seeded into the fresh store).
    const result = await runLoopExecutor('assess the code quality of this project and give recommendations', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('done');
  });

  it('skipSkillHint bypasses the hint path entirely (hint-free comparison)', async () => {
    const provider = scriptedProvider({ native: true, responses: [{ content: 'ok', toolCalls: [] }] });
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('assess the code quality of this project and give recommendations', new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('ok');
  });
});

describe('loop executor — mid-turn failover (T1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    for (const m of [
      '../../src/cli/router.js',
      '../../src/learning/auto-router.js',
      '../../src/learning/resilient-call.js',
      '../../src/inference/model-validator.js',
      '../../src/learning/failure-bookkeeping.js',
      '../../src/learning/provider-fallback.js',
    ]) {
      vi.doUnmock(m);
    }
    vi.resetModules();
  });

  it('fails over to the next candidate after a mid-step 429 and records the failure', async () => {
    const primary: InferenceProvider = {
      name: 'Primary',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        throw new Error('should not be reached');
      },
      async generateTools(): Promise<ToolCallResponse> {
        throw new Error('429 rate limit exceeded for model primary-model');
      },
    } as unknown as InferenceProvider;
    const backup: InferenceProvider = {
      name: 'Backup',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        return 'backup answer';
      },
      async generateTools(): Promise<ToolCallResponse> {
        return { content: 'backup answer', toolCalls: [] };
      },
    } as unknown as InferenceProvider;

    const recordFailure = vi.fn();
    const recordSuccess = vi.fn();

    vi.doMock('../../src/learning/auto-router.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/auto-router.js')>()),
      getAutoRouter: () => ({
        resolve: async () => ({ provider: 'primary', model: 'primary-model', fallbackChain: [] }),
        resolveModel: () => 'resolved-model',
      }),
    }));
    vi.doMock('../../src/learning/resilient-call.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/resilient-call.js')>()),
      buildDeepFailoverPool: () => [
        { provider: 'primary', model: 'primary-model' },
        { provider: 'backup', model: 'backup-model' },
      ],
      createFailoverExclusionFilter: () => () => false,
    }));
    vi.doMock('../../src/inference/model-validator.js', async (orig) => ({
      ...(await orig<typeof import('../../src/inference/model-validator.js')>()),
      resolveWorkingModel: async (_p: unknown, _t: string, desired?: string) => desired ?? 'resolved',
    }));
    vi.doMock('../../src/learning/failure-bookkeeping.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/failure-bookkeeping.js')>()),
      recordActionFailure: (...args: unknown[]) => recordFailure(...args),
    }));
    vi.doMock('../../src/learning/provider-fallback.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/provider-fallback.js')>()),
      recordRegistrySuccess: (...args: unknown[]) => recordSuccess(...args),
    }));
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: (_cm: unknown, type: string) => ({
        type,
        provider: type === 'primary' ? primary : backup,
      }),
    }));

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do the thing', new ConfigManager(), {
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('backup answer');
    expect(result.provider).toBe('backup');
    // The 429 was written through the SHARED bookkeeping — learned, not lost.
    expect(recordFailure).toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledWith('backup', 'backup-model', 'execute');
  });
});

/**
 * Pinned-provider failover. `--provider X` used to collapse the candidate pool
 * to that single provider, so X's first bad step (a 429 on a free tier) killed
 * the turn even though a fallback chain was configured. The pin now contributes
 * the config-declared fallback chain as well — but only a failure another
 * provider could plausibly answer justifies leaving an explicit choice.
 */
describe('loop executor — pinned-provider failover (config fallback chain)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    for (const m of [
      '../../src/cli/router.js',
      '../../src/learning/auto-router.js',
      '../../src/inference/model-validator.js',
      '../../src/learning/failure-bookkeeping.js',
      '../../src/learning/provider-fallback.js',
      '../../src/learning/model-selection.js',
    ]) {
      vi.doUnmock(m);
    }
    vi.resetModules();
  });

  /**
   * A pinned provider that fails with `failure` + a healthy fallback sibling.
   *
   * `pinnedAvailable` is the reachability-probe sequence: one entry per
   * `isAvailable()` call, the last entry repeating once the sequence runs out.
   */
  function mockPinnedPair(
    failure: Error,
    opts?: { pinnedAvailable?: boolean[]; fallbackAvailable?: boolean[] },
  ): {
    recordFailure: ReturnType<typeof vi.fn>;
    fallbackCalls: { n: number };
    isAvailable: ReturnType<typeof vi.fn>;
    fallbackIsAvailable: ReturnType<typeof vi.fn>;
  } {
    const recordFailure = vi.fn();
    const fallbackCalls = { n: 0 };
    const availability = opts?.pinnedAvailable ?? [true];
    let probe = 0;
    const isAvailable = vi.fn(async () => availability[Math.min(probe++, availability.length - 1)]);
    const pinned: InferenceProvider = {
      name: 'Pinned',
      isAvailable,
      async generate(): Promise<string> {
        throw new Error('should not be reached');
      },
      async generateTools(): Promise<ToolCallResponse> {
        throw failure;
      },
    } as unknown as InferenceProvider;
    const fallbackAvailability = opts?.fallbackAvailable ?? [true];
    let fallbackProbe = 0;
    const fallbackIsAvailable = vi.fn(async () =>
      fallbackAvailability[Math.min(fallbackProbe++, fallbackAvailability.length - 1)],
    );
    const fallback: InferenceProvider = {
      name: 'Fallback',
      isAvailable: fallbackIsAvailable,
      async generate(): Promise<string> {
        return 'fallback answer';
      },
      async generateTools(): Promise<ToolCallResponse> {
        fallbackCalls.n += 1;
        return { content: 'fallback answer', toolCalls: [] };
      },
    } as unknown as InferenceProvider;

    vi.doMock('../../src/learning/auto-router.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/auto-router.js')>()),
      getAutoRouter: () => ({ resolveModel: () => 'resolved-model' }),
    }));
    vi.doMock('../../src/inference/model-validator.js', async (orig) => ({
      ...(await orig<typeof import('../../src/inference/model-validator.js')>()),
      resolveWorkingModel: async (_p: unknown, _t: string, desired?: string) => desired ?? 'resolved',
    }));
    vi.doMock('../../src/learning/failure-bookkeeping.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/failure-bookkeeping.js')>()),
      recordActionFailure: (...args: unknown[]) => recordFailure(...args),
    }));
    vi.doMock('../../src/learning/provider-fallback.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/provider-fallback.js')>()),
      recordRegistrySuccess: () => undefined,
      // The config-declared chain: the pinned provider followed by its fallback.
      getProviderFallback: () => ({ getFallbackChain: () => ['pinned', 'fallback'] }),
    }));
    // The chain is credential-filtered (an explicit fallback entry with no key
    // must not cost a connection timeout), so the fake provider ids need a
    // credential verdict of their own.
    vi.doMock('../../src/learning/model-selection.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/model-selection.js')>()),
      hasCredentials: () => true,
    }));
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: (_cm: unknown, type: string) => ({
        type,
        provider: type === 'pinned' ? pinned : fallback,
      }),
    }));
    return { recordFailure, fallbackCalls, isAvailable, fallbackIsAvailable };
  }

  it('walks the config fallback chain when a pinned provider hits a 429', async () => {
    const { recordFailure, fallbackCalls } = mockPinnedPair(new Error('429 rate limit exceeded'));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do the thing', new ConfigManager(), {
      provider: 'pinned',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('fallback answer');
    expect(result.provider).toBe('fallback');
    expect(fallbackCalls.n).toBe(1);
    // The pinned provider's failure was still learned (parked), not lost.
    expect(recordFailure).toHaveBeenCalled();
  });

  it('does NOT leave an explicitly pinned provider on a non-retryable auth error', async () => {
    const { fallbackCalls } = mockPinnedPair(new Error('401 unauthorized invalid api key'));
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do the thing', new ConfigManager(), {
      provider: 'pinned',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    // No silent provider switch: the pin's real verdict is surfaced instead.
    expect(fallbackCalls.n).toBe(0);
    expect(result.provider).toBe('pinned');
  });

  it('A2 — strict mode refuses to walk to the fallback even on a RETRYABLE failure', async () => {
    // The live `cal` Android run: `NUVIRA_STRICT_MODEL=1` with a pinned model
    // that kept timing out still fell through to groq then gemini (5 times).
    // A retryable failure is exactly what used to justify leaving the pin.
    const { recordFailure, fallbackCalls } = mockPinnedPair(new Error('429 rate limit exceeded'));
    const prev = process.env.NUVIRA_STRICT_MODEL;
    process.env.NUVIRA_STRICT_MODEL = '1';
    try {
      const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
      // A DISTINCT goal on purpose: the failover test above uses `do the thing`,
      // and sharing it would serve this turn from the answer cache (same goal →
      // cached reply) instead of exercising the strict path at all.
      const result = await runLoopExecutor('restrict this run to the pinned model', new ConfigManager(), {
        provider: 'pinned',
        skipProjectContext: true,
        skipSkillHint: true,
        quiet: true,
      });

      // No substitution: the pinned model ran or the step failed, exactly as asked.
      expect(fallbackCalls.n).toBe(0);
      expect(result.provider).toBe('pinned');
      expect(result.generationFailed).toBe(true);
      // Strict mode still books the failure, so the router is not blinded.
      expect(recordFailure).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.NUVIRA_STRICT_MODEL;
      else process.env.NUVIRA_STRICT_MODEL = prev;
    }
  });

  // ─── The reachability probe is not a failed call (measured 2026-10-09) ────
  // Live (trace-1791551810613-mnn84h): 27 clean steps on the user's PINNED
  // `deepseek/deepseek-flash`, then ONE probe miss moved the last 6 steps of the
  // turn to `openrouter/apodex/apodex-1.1-mini:free` with no failure booked. The
  // probe is a single `GET /models` with a 3s timeout, so a hiccup spent the
  // user's own choice for them, silently.
  it('ATTEMPTS the pinned model even when a reachability probe would say it is down', async () => {
    // The pin's probe answers `false` — and is never consulted, because a probe
    // is not a call. The 429 below (a REAL failure) is what walks the turn on.
    const { isAvailable, recordFailure, fallbackCalls } = mockPinnedPair(
      new Error('429 rate limit exceeded'),
      { pinnedAvailable: [false] },
    );
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('never probe the pinned model', new ConfigManager(), {
      provider: 'pinned',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    expect(isAvailable).not.toHaveBeenCalled();
    // It left the pin for a real reason, and that reason was recorded.
    expect(recordFailure).toHaveBeenCalled();
    expect(fallbackCalls.n).toBe(1);
    expect(result.provider).toBe('fallback');
  });

  it('re-probes a FALLBACK candidate, so one hiccup does not skip a healthy provider', async () => {
    // First probe says down, the re-probe says up → the fallback serves the step.
    const { fallbackIsAvailable, fallbackCalls } = mockPinnedPair(
      new Error('429 rate limit exceeded'),
      { fallbackAvailable: [false, true] },
    );
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('re-probe the fallback before skipping it', new ConfigManager(), {
      provider: 'pinned',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    expect(fallbackIsAvailable.mock.calls.length).toBe(2);
    expect(fallbackCalls.n).toBe(1);
    expect(result.provider).toBe('fallback');
  });

  it('stands a fallback down after TWO probe misses, and says it was a probe', async () => {
    const { fallbackIsAvailable, fallbackCalls } = mockPinnedPair(
      new Error('429 rate limit exceeded'),
      { fallbackAvailable: [false] },
    );
    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('stand down a fallback that will not answer a probe', new ConfigManager(), {
      provider: 'pinned',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    // Probed twice, never called: nothing left to serve the step, and the turn
    // reports a failure rather than inventing one.
    expect(fallbackIsAvailable.mock.calls.length).toBe(2);
    expect(fallbackCalls.n).toBe(0);
    expect(result.generationFailed).toBe(true);
  });
});

/**
 * Phase 4b/4c — SESSION REHYDRATION across a process death.
 *
 * A run that died mid-turn leaves an OPEN session snapshot. The next run with
 * `--resume` picks the conversation up: the prior work is already in the thread,
 * so it is neither re-run nor re-paid. A run with no request must NOT touch the
 * store at all.
 */
describe('loop executor — session rehydration (Phase 4b/4c)', () => {
  let memDir = '';
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetModules();
    envBackup.NUVIRA_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
    envBackup.NUVIRA_RESUME = process.env.NUVIRA_RESUME;
    delete process.env.NUVIRA_RESUME;
    memDir = mkdtempSync(join(tmpdir(), 'buff-session-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
  });
  afterEach(() => {
    if (envBackup.NUVIRA_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = envBackup.NUVIRA_MEMORY_DIR;
    if (envBackup.NUVIRA_RESUME === undefined) delete process.env.NUVIRA_RESUME;
    else process.env.NUVIRA_RESUME = envBackup.NUVIRA_RESUME;
    rmSync(memDir, { recursive: true, force: true });
    vi.doUnmock('../../src/cli/router.js');
    vi.resetModules();
  });

  it('rehydrates the thread a dead process left OPEN', async () => {
    const { openSession } = await import('../../src/learning/session-store.js');
    const goal = 'continue building the widget';
    const cwd = process.cwd();
    const store = openSession({ goal, cwd });
    // Deliberately NOT finished: this is the transcript of a turn that died.
    store.save(
      [
        { role: 'system', content: 'stale system prompt' },
        { role: 'user', content: goal },
        { role: 'assistant', content: 'PRIOR-WORK-MARKER' },
      ],
      { steps: 1, successfulTools: ['write_file'], mutatedPaths: ['widget.ts'] },
    );

    let seen: readonly ToolMessage[] = [];
    const provider: InferenceProvider = {
      name: 'Scripted',
      async generate(): Promise<string> {
        return 'done';
      },
      async generateTools(messages: ToolMessage[]): Promise<ToolCallResponse> {
        seen = messages;
        return { content: 'done', toolCalls: [] };
      },
    } as unknown as InferenceProvider;
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor(goal, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
      resume: true,
    });

    expect(result.generationFailed).toBe(false);
    // The dead run's conversation is present…
    expect(seen.some((m) => m.content.includes('PRIOR-WORK-MARKER'))).toBe(true);
    // …while the stored (stale) head was replaced by a fresh one.
    expect(seen.some((m) => m.content.includes('stale system prompt'))).toBe(false);
  });

  it('rehydrates an OPEN session BY DEFAULT, and `sessionStore: false` turns it off', async () => {
    const { openSession } = await import('../../src/learning/session-store.js');
    const goal = 'a totally ordinary ask';
    /** Seed an OPEN session for this ask, carrying a marker we can look for. */
    const seed = (marker: string): void => {
      const store = openSession({ goal, cwd: process.cwd() });
      store.save(
        [{ role: 'system', content: 'stale' }, { role: 'user', content: goal }, { role: 'assistant', content: marker }],
        { steps: 1, successfulTools: [], mutatedPaths: [] },
      );
    };

    let seen: readonly ToolMessage[] = [];
    const provider: InferenceProvider = {
      name: 'Scripted',
      async generate(): Promise<string> {
        return 'ok';
      },
      async generateTools(messages: ToolMessage[]): Promise<ToolCallResponse> {
        seen = messages;
        return { content: 'ok', toolCalls: [] };
      },
    } as unknown as InferenceProvider;
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: () => ({ type: 'scripted', provider }),
    }));

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');

    // Default: continuity is ON — an open matching session is picked up.
    seed('DEFAULT-MARKER');
    const first = await runLoopExecutor(goal, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });
    expect(first.generationFailed).toBe(false);
    expect(seen.some((m) => m.content.includes('DEFAULT-MARKER'))).toBe(true);

    // Disabled: the store is not consulted, so a NEW open session is ignored.
    seen = [];
    seed('OFF-MARKER');
    const second = await runLoopExecutor(goal, new ConfigManager(), {
      provider: 'scripted',
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
      sessionStore: false,
    });
    expect(second.generationFailed).toBe(false);
    expect(seen.some((m) => m.content.includes('OFF-MARKER'))).toBe(false);
  });
});
