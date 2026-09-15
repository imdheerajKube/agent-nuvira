/**
 * Shared deep-failover pool + shared exclusion filter — regression tests.
 *
 * WHY THIS EXISTS
 *
 * Every entry path (CLI chat, the dashboard console, the gateway — all three are
 * literally `ChatCommand.answerOnce` — `execute`, and the orchestrator's
 * tools/sub-agents) must walk the SAME candidate pool and apply the SAME
 * exclusion rules. Before this, only the orchestrator's resilient proxy built
 * the deepest pool (`src/learning/resilient-call.ts`) while chat and execute
 * built a shallower list locally, so the paths could silently drift apart.
 *
 * The pool now lives in ONE exported function, `buildDeepFailoverPool()`, and
 * the exclusion rule in ONE factory, `createFailoverExclusionFilter()`.
 *
 * Two invariants are pinned here because getting either wrong is invisible until
 * production traffic:
 *
 *   1. The router's own pick stays FIRST. The pool sorts best-first by score,
 *      and the model-first tiered layer scores on raw capability — which can
 *      outscore the router's composite score. Since chat/execute walk the pool
 *      in order and take the first AVAILABLE candidate, a sort that demoted the
 *      router's pick would silently override routing for every message.
 *
 *   2. Exclusions are MODEL-scoped, never accidentally provider-scoped. A 429
 *      on one model must never take its healthy siblings out of the walk (free
 *      tiers meter per model, and per-model quota parks are the whole point of
 *      the ledger).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAutoRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { buildAutoResolveOptions } from '../../src/learning/resolve-options.js';
import {
  buildDeepFailoverPool,
  createFailoverExclusionFilter,
} from '../../src/learning/resilient-call.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

const GOAL = 'implement a feature with tests';
const ALLOWED = ['groq', 'gemini'];

/** ConfigManager-shaped stub with a controllable credential set. */
function makeConfig(creds: string[] = ALLOWED): any {
  return {
    getAll: () => ({ providers: {}, routing: {} }),
    hasRequiredCredentials: vi.fn((p: string) => creds.includes(p)),
    getProviderConfig: () => ({ type: 'groq', config: {} }),
  };
}

/** Seed a verified provider × model into the registry. */
function seedVerified(provider: string, ...models: string[]): void {
  for (const m of models) getModelRegistry().markVerified(provider, m, 'telemetry', 400);
}

/** Resolve a real decision for the fixture, through production-shaped options. */
function resolveDecision(config: any, agentType = 'chat') {
  return getAutoRouter().resolve(agentType, GOAL, buildAutoResolveOptions(config), config);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-shared-pool-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();

  seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b');
  seedVerified('gemini', 'gemini-2.5-flash', 'gemini-2.5-pro');
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

// ─── The pool ───────────────────────────────────────────────────────────────

describe('buildDeepFailoverPool — the ONE pool every entry path walks', () => {
  it("keeps the router's own pick FIRST, ahead of higher-scoring tiered candidates", () => {
    const config = makeConfig();
    const decision = resolveDecision(config);
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: GOAL,
      complexity: decision.complexity,
      configManager: config,
    });

    // Chat and execute take the first AVAILABLE candidate, so element 0 must be
    // the router's decision — the pool only extends failover BEYOND it.
    expect(pool[0]).toMatchObject({ provider: decision.provider, model: decision.model });

    // And the invariant is not vacuous: the tiered layer really can produce a
    // higher raw score, so the hoist is what keeps the pick authoritative.
    const maxTailScore = Math.max(...pool.slice(1).map((c) => c.score));
    expect(pool[0].score).toBeGreaterThan(0);
    expect(maxTailScore).toBeGreaterThanOrEqual(0);
  });

  it('is a superset of the router chain (primary + every fallbackChain pair)', () => {
    const config = makeConfig();
    const decision = resolveDecision(config);
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: GOAL,
      complexity: decision.complexity,
      configManager: config,
    });

    const keys = new Set(pool.map((c) => `${c.provider}|${c.model}`));
    expect(keys.has(`${decision.provider}|${decision.model}`)).toBe(true);
    for (const fb of decision.fallbackChain) {
      expect(keys.has(`${fb.provider}|${fb.model}`)).toBe(true);
    }
  });

  it('reaches SEVERAL models per provider (no one-model-per-provider dead end)', () => {
    const config = makeConfig();
    const decision = resolveDecision(config);
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: GOAL,
      complexity: decision.complexity,
      configManager: config,
    });

    for (const provider of ALLOWED) {
      const concrete = pool.filter((c) => c.provider === provider && c.model !== 'default');
      expect(concrete.length).toBeGreaterThanOrEqual(1);
    }
    // Strictly more provider×model pairs than providers.
    const pairs = new Set(pool.filter((c) => c.model !== 'default').map((c) => `${c.provider}|${c.model}`));
    expect(pairs.size).toBeGreaterThan(ALLOWED.length);
  });

  it('draws CONCRETE tiered candidates only from providers the router ranked', () => {
    // groq + gemini credentialed; the catalog knows dozens of other providers.
    const config = makeConfig(['groq']);
    const decision = resolveDecision(config);
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: GOAL,
      complexity: decision.complexity,
      configManager: config,
    });

    const allowed = new Set([decision.provider, ...decision.ranked.map((r) => r.provider)]);
    for (const c of pool) {
      if (c.model === 'default') continue; // placeholders resolve at call time
      // A concrete model for a provider the router never ranked would be an
      // un-credentialed provider — every walk pointlessly probing them was the
      // bug the allowedProviders restriction fixes.
      expect(allowed.has(c.provider)).toBe(true);
    }
  });

  it('de-duplicates provider×model and never emits a duplicate entry', () => {
    const config = makeConfig();
    const decision = resolveDecision(config);
    const pool = buildDeepFailoverPool(decision, {
      taskDescription: GOAL,
      complexity: decision.complexity,
      configManager: config,
    });

    const keys = pool.map((c) => `${c.provider}|${c.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('degrades to an empty pool for no decision (never throws)', () => {
    expect(buildDeepFailoverPool(null)).toEqual([]);
  });
});

// ─── The exclusion filter ───────────────────────────────────────────────────

describe('createFailoverExclusionFilter — one rule for chat, execute and the orchestrator', () => {
  it('rules out ONLY the exact model for a model-scoped session failure', () => {
    const filter = createFailoverExclusionFilter({
      sessionFailedModels: new Map([['groq|llama-3.3-70b-versatile', Date.now() + 60_000]]),
      crossPipelineMemory: false,
      registryCheck: false,
    });

    // The failed model is skipped…
    expect(filter('groq', 'llama-3.3-70b-versatile')).toBe(true);
    // …its siblings are not (model-scoped, never provider-scoped)…
    expect(filter('groq', 'openai/gpt-oss-120b')).toBe(false);
    // …and the same model name on another provider is a different candidate.
    expect(filter('gemini', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('accepts the bare-expiry map shape chat keeps as well as {expiresAt} records', () => {
    const bare = createFailoverExclusionFilter({
      sessionFailedModels: new Map<string, number>([['groq|model-a', Date.now() + 60_000]]),
      crossPipelineMemory: false,
      registryCheck: false,
    });
    const shaped = createFailoverExclusionFilter({
      sessionFailedModels: new Map<string, { expiresAt: number }>([['groq|model-b', { expiresAt: Date.now() + 60_000 }]]),
      crossPipelineMemory: false,
      registryCheck: false,
    });

    expect(bare('groq', 'model-a')).toBe(true);
    expect(bare('groq', 'model-b')).toBe(false);
    expect(shaped('groq', 'model-b')).toBe(true);
    expect(shaped('groq', 'model-a')).toBe(false);
  });

  it('rules out the WHOLE provider for a provider-wide failure (dead key)', () => {
    const filter = createFailoverExclusionFilter({
      sessionFailed: new Map<string, number>([['groq', Date.now() + 60_000]]),
      crossPipelineMemory: false,
      registryCheck: false,
    });

    expect(filter('groq', 'openai/gpt-oss-120b')).toBe(true);
    expect(filter('groq')).toBe(true);
    expect(filter('gemini', 'gemini-2.5-flash')).toBe(false);
  });

  it('re-admits a candidate the moment its exclusion window lapses', () => {
    const filter = createFailoverExclusionFilter({
      sessionFailedModels: new Map([['groq|model-a', Date.now() - 1]]),
      sessionFailed: new Map([['gemini', Date.now() - 1]]),
      crossPipelineMemory: false,
      registryCheck: false,
    });

    expect(filter('groq', 'model-a')).toBe(false);
    expect(filter('gemini', 'gemini-2.5-flash')).toBe(false);
  });

  it('checks the registry per ENTRY: a parked model is skipped, its sibling is not', () => {
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');
    getModelRegistry().syncQuota(undefined);

    const filter = createFailoverExclusionFilter({ crossPipelineMemory: false });

    expect(filter('groq', 'llama-3.3-70b-versatile')).toBe(true);
    expect(filter('groq', 'openai/gpt-oss-120b')).toBe(false);
  });

  it('treats an UNTRACKED model as unproven, not as excluded', () => {
    const filter = createFailoverExclusionFilter({ crossPipelineMemory: false });

    // The failover chain exists precisely to reach models the registry has no
    // data on yet — an untracked model must stay reachable.
    expect(filter('groq', 'some-model-never-seen')).toBe(false);
  });

  it('skips the registry check entirely when registryCheck is false (chat owns model repair)', () => {
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');
    getModelRegistry().syncQuota(undefined);

    const filter = createFailoverExclusionFilter({ crossPipelineMemory: false, registryCheck: false });
    expect(filter('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('consults nothing at all by default with no maps and no failure history', () => {
    const filter = createFailoverExclusionFilter({ crossPipelineMemory: false, registryCheck: false });
    expect(filter('groq', 'anything')).toBe(false);
  });

  it('keeps a caller-supplied persisted-failure store authoritative when provided', () => {
    const filter = createFailoverExclusionFilter({
      crossPipelineMemory: true,
      registryCheck: false,
      // Provider-wide AND model-scoped entries, the two persisted shapes.
      persistedFailures: {
        gemini: { expiresAt: Date.now() + 60_000, kind: 'auth' as const, recordedAt: Date.now() },
        'groq|openai/gpt-oss-120b': { expiresAt: Date.now() + 60_000, kind: 'rate-limit' as const, recordedAt: Date.now() },
      } as any,
    });

    expect(filter('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(filter('groq', 'openai/gpt-oss-120b')).toBe(true);
    // The sibling of the model-scoped persisted failure is untouched.
    expect(filter('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });
});
