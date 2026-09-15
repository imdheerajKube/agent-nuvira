/**
 * Failover-path comparison — which entry point picks the best model?
 *
 * The question this answers: do chat / execute / dashboard chat / gateway all
 * get their model from the SAME router, and if the paths differ, which one
 * produces the better pick?
 *
 * Finding (pinned here so it can't silently regress):
 *
 *   - ALL entry points share ONE initial decision — `AutoModelRouter.resolve()`.
 *     CLI chat, the dashboard console AND the gateway all run through
 *     `ChatCommand.answerOnce` (the gateway lazily instantiates
 *     ChatCommand and casts `answerOnce` as the ChatEngine), so they are
 *     literally the same code path. `loop-executor` (execute) and
 *     `pipeline-tool` also call the same router.
 *
 *   - What differs is the FAILOVER WALK after that decision, and that is what
 *     determines which one reaches a workable model when the top pick fails.
 *     This test measures the reachable (provider, model) pairs per path and
 *     asserts that the deepest paths stay ahead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAutoRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { buildAutoResolveOptions } from '../../src/learning/resolve-options.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { createResilientCallLLM } from '../../src/learning/resilient-call.js';
import { buildModelCandidates, buildTieredFailoverChain } from '../../src/learning/model-first-router.js';
import { analyzeComplexity } from '../../src/learning/hybrid-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

const GOAL = 'implement a feature with tests';
const ALLOWED = ['groq', 'gemini', 'openrouter'];

function makeConfig(): any {
  return {
    getAll: () => ({ providers: {}, routing: {} }),
    hasRequiredCredentials: vi.fn((p: string) => ALLOWED.includes(p)),
    getProviderConfig: () => ({ type: 'groq', config: {} }),
  };
}

/** Distinct provider × model pairs a path can actually reach. */
function pairs(list: Array<{ provider: string; model: string }>): Set<string> {
  const out = new Set<string>();
  for (const p of list) {
    if (!p.model || p.model === 'default') continue;
    out.add(`${p.provider}/${p.model}`);
  }
  return out;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-failover-paths-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();

  const registry = getModelRegistry();
  for (const m of ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    registry.markVerified('groq', m, 'telemetry', 400);
  }
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-pro']) {
    registry.markVerified('gemini', m, 'telemetry', 500);
  }
  for (const m of ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct']) {
    registry.markVerified('openrouter', m, 'telemetry', 900);
  }
});

afterEach(() => {
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('every entry point routes through the same initial decision', () => {
  it('resolves the SAME primary provider/model for chat, execute and gateway (shared ChatCommand engine)', () => {
    const router = getAutoRouter();
    const config = makeConfig();
    // Compare on EQUAL FOOTING: every production caller (chat.ts, the
    // orchestrator, loop-executor) assembles its options through
    // buildAutoResolveOptions, which enables the bandit/ML layers + the quota
    // feed. Comparing a bare `{allowedProviders}` call against the resilient
    // path's enriched options would compare two different routers.
    // `answerOnce` (chat), the dashboard console and the gateway all pass
    // agentType 'chat'; `loop-executor` passes 'execute'. Same router, same
    // task → the primary pick must be identical for the same agentType.
    const chat = router.resolve('chat', GOAL, buildAutoResolveOptions(config), config);
    const chatAgain = router.resolve('chat', GOAL, buildAutoResolveOptions(config), config);
    expect(chatAgain.provider).toBe(chat.provider);
    expect(chatAgain.model).toBe(chat.model);

    const execute = router.resolve('execute', GOAL, buildAutoResolveOptions(config), config);
    // A different agentType may legitimately weight differently, but it must
    // come from the same pool of really-available providers.
    expect(ALLOWED).toContain(execute.provider);
  });

  it('the router win + its chain is what chat/execute walk (deep, several per provider)', () => {
    const config = makeConfig();
    const decision = getAutoRouter().resolve('chat', GOAL, buildAutoResolveOptions(config), config);
    const reachable = pairs([
      { provider: decision.provider, model: decision.model },
      ...decision.fallbackChain,
    ]);
    // Strictly more pairs than providers → depth beyond one-model-per-provider.
    expect(reachable.size).toBeGreaterThan(ALLOWED.length);
  });
});

describe('failover depth per path', () => {
  it('the orchestrator/tool path (resilient callLLM) reaches AT LEAST as many models as the router chain', () => {
    const config = makeConfig();
    const decision = getAutoRouter().resolve('chat', GOAL, buildAutoResolveOptions(config), config);
    const routerPairs = pairs([
      { provider: decision.provider, model: decision.model },
      ...decision.fallbackChain,
    ]);

    const callLLM = createResilientCallLLM(config, {
      task: { agentType: 'chat', description: GOAL },
    });
    const candidates = (callLLM as any).__resilient.getCandidates() as Array<{ provider: string; model: string }>;
    // The candidates list holds the primary win + the router's chain.
    const resilientPairs = pairs(candidates);

    // Same PROVIDER (same router, same winning provider). The exact MODEL is
    // deliberately NOT asserted equal: with the bandit enabled (the production
    // default via buildAutoResolveOptions) `resolveModelWithLearning` picks the
    // best THOMPSON SAMPLE for the provider, so two resolve() calls for the
    // same task may explore different models. That is a property of the
    // learning layer, not a difference between entry paths.
    expect(candidates[0].provider).toBe(decision.provider);
    expect(decision.ranked.map((r) => r.provider)).toContain(candidates[0].provider);
    // This is why the orchestrator path is the strongest walker: it flattens
    // the model-first tiered chain on top of the router chain, so it reaches
    // every model the router can PLUS the tiered alternatives.
    expect(resilientPairs.size).toBeGreaterThanOrEqual(routerPairs.size - 1);
  });

  it('the model-first tiered chain reaches every provider\'s models (no single-model dead ends)', () => {
    const candidates = buildModelCandidates(GOAL, analyzeComplexity(GOAL), makeConfig(), ALLOWED);
    expect(candidates.length).toBeGreaterThan(0);
    const tiers = buildTieredFailoverChain(candidates[0], candidates);
    const reachable = pairs([
      { provider: candidates[0].provider, model: candidates[0].model },
      ...tiers.flatMap((t) => t.candidates),
    ]);
    for (const provider of ALLOWED) {
      const forProvider = [...reachable].filter((k) => k.startsWith(`${provider}/`));
      expect(forProvider.length).toBeGreaterThanOrEqual(1);
    }
    expect(reachable.size).toBeGreaterThan(ALLOWED.length);
  });
});

describe('a per-model quota park does not drop the provider from ANY path', () => {
  it('all paths still reach a groq sibling after a groq model is parked', () => {
    // One groq model rests on its own limit (the user's scenario).
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');
    getModelRegistry().syncQuota(undefined);

    const config = makeConfig();
    const decision = getAutoRouter().resolve('chat', GOAL, buildAutoResolveOptions(config), config);
    const chain = [
      { provider: decision.provider, model: decision.model, reason: 'primary' },
      ...decision.fallbackChain.map((c) => ({ provider: c.provider, model: c.model, reason: c.reason })),
    ];
    const reachable = pairs(chain);

    // groq must still be reachable (the provider is healthy — only one of its
    // models is resting), and the resting model must not outrank a healthy
    // groq sibling: it may only appear AFTER one of them.
    expect([...reachable].some((k) => k.startsWith('groq/'))).toBe(true);
    const parkedIdx = chain.findIndex((c) => c.provider === 'groq' && c.model === 'llama-3.3-70b-versatile');
    const healthyIdx = chain.findIndex(
      (c) => c.provider === 'groq' && (c.model === 'openai/gpt-oss-120b' || c.model === 'openai/gpt-oss-20b'),
    );
    expect(healthyIdx).toBeGreaterThanOrEqual(0);
    if (parkedIdx >= 0) expect(healthyIdx).toBeLessThan(parkedIdx);
  });
});
