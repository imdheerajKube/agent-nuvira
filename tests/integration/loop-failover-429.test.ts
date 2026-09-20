/**
 * Live-ish integration: a 429 on the primary LOOP candidate must (a) fail over
 * to the next provider instead of dying, and (b) leave a REAL park behind so the
 * failure is learned.
 *
 * Unlike the unit test in `tests/cli/loop-executor.test.ts`, the failure
 * bookkeeping here is the PRODUCTION one: `recordActionFailure` runs for real
 * against the real quota ledger + model registry (pointed at a temp memory dir),
 * so this pins the "recorded park" half of the fix, not just the failover walk.
 *
 * Only the TRANSPORT is stubbed (provider resolution, the router's decision and
 * the deep pool) — no network, no TTY.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../src/config/manager.js';
import type { InferenceProvider, ToolCallResponse } from '../../src/inference/interface.js';
import { getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';
import { resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-loop-429-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetProviderFallback();
  resetAutoRouter();
  resetRouterBandit();
  vi.resetModules();
});

afterEach(() => {
  for (const m of [
    '../../src/cli/router.js',
    '../../src/learning/auto-router.js',
    '../../src/learning/resilient-call.js',
    '../../src/inference/model-validator.js',
  ]) {
    vi.doUnmock(m);
  }
  resetQuotaLedger();
  resetModelRegistry();
  resetProviderFallback();
  resetAutoRouter();
  resetRouterBandit();
  vi.resetModules();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('loop executor — mid-turn 429 fails over and is recorded (T1/T4)', () => {
  it('walks past a rate-limited primary to groq and parks the failed model', async () => {
    const gemini: InferenceProvider = {
      name: 'Gemini',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        throw new Error('should not be reached');
      },
      async generateTools(): Promise<ToolCallResponse> {
        throw new Error(
          'Gemini tool-calling API error (429): quota exceeded for generate_content_free_tier_requests, limit: 15',
        );
      },
    } as unknown as InferenceProvider;
    const groq: InferenceProvider = {
      name: 'Groq',
      isAvailable: async () => true,
      async generate(): Promise<string> {
        return 'groq answer';
      },
      async generateTools(): Promise<ToolCallResponse> {
        return { content: 'groq answer', toolCalls: [] };
      },
    } as unknown as InferenceProvider;

    vi.doMock('../../src/learning/auto-router.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/auto-router.js')>()),
      getAutoRouter: () => ({
        resolve: async () => ({ provider: 'gemini', model: 'gemini-model', fallbackChain: [] }),
        resolveModel: () => 'resolved-model',
      }),
    }));
    vi.doMock('../../src/learning/resilient-call.js', async (orig) => ({
      ...(await orig<typeof import('../../src/learning/resilient-call.js')>()),
      buildDeepFailoverPool: () => [
        { provider: 'gemini', model: 'gemini-model' },
        { provider: 'groq', model: 'groq-model' },
      ],
      createFailoverExclusionFilter: () => () => false,
    }));
    vi.doMock('../../src/inference/model-validator.js', async (orig) => ({
      ...(await orig<typeof import('../../src/inference/model-validator.js')>()),
      resolveWorkingModel: async (_p: unknown, _t: string, desired?: string) => desired ?? 'resolved',
    }));
    vi.doMock('../../src/cli/router.js', () => ({
      resolveProvider: (_cm: unknown, type: string) => ({
        type,
        provider: type === 'gemini' ? gemini : groq,
      }),
    }));

    const { runLoopExecutor } = await import('../../src/cli/loop-executor.js');
    const result = await runLoopExecutor('do the thing', new ConfigManager(), {
      skipProjectContext: true,
      skipSkillHint: true,
      quiet: true,
    });

    // (a) The turn survived on the next candidate.
    expect(result.generationFailed).toBe(false);
    expect(result.content).toBe('groq answer');
    expect(result.provider).toBe('groq');

    // (b) The 429 was recorded — the failed model is parked in the real ledger,
    // so the NEXT run skips it (this is what makes the fix learned, not just a
    // one-off retry).
    const parked = getQuotaLedger().getModelQuotaStatus();
    expect(parked.some((m) => m.provider === 'gemini' && m.model === 'gemini-model')).toBe(true);

    // The registry also learned about the failed provider × model.
    expect(getModelRegistry().getEntry('gemini', 'gemini-model')).toBeDefined();
  });
});
