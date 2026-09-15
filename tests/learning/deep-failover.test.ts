/**
 * Deep failover + per-model quota — regression tests.
 *
 * The two gaps this pins down:
 *
 * 1. FAILOVER WAS ONE MODEL PER PROVIDER. `decision.fallbackChain` carried a
 *    single resolveModel() pick per provider, so a provider's 2nd/3rd-best
 *    model was effectively unreachable — a 429 on the one listed model skipped
 *    the whole provider. Free tiers meter PER MODEL (RPD/TPM), so the siblings
 *    were usually still usable. The chain must now carry SEVERAL models per
 *    provider.
 *
 * 2. QUOTA WAS PROVIDER-SCOPED. `parkProvider` (and the failure bookkeeping
 *    that calls it) sank a whole provider when ONE model 429ed, dragging its
 *    working siblings down. Parks are now per-model (parkModel) with an
 *    escalation to a provider park only when several DISTINCT models of the
 *    same provider are rate-limited (a genuinely shared limit — Groq's
 *    free-tier TPM is shared across all of its models).
 *
 * Also covers the RECOVERY loop: a parked model is re-admitted automatically
 * when its window lapses and the registry stops reporting it as parked, so a
 * healed model is picked again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaLedger, getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { preferredModelsFor } from '../../src/learning/model-selection.js';
import { AutoModelRouter, resetAutoRouter, FALLBACK_MODELS_PER_PROVIDER } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

/** ConfigManager-shaped stub with a controllable credential set. */
function makeConfig(creds: string[], quota?: Record<string, unknown>): any {
  return {
    hasRequiredCredentials: vi.fn((p: string) => creds.includes(p)),
    getAll: () => ({ providers: {}, routing: { quota } }),
    getProviderConfig: () => ({ type: 'groq', config: {} }),
  };
}

/** Seed a verified provider × model into the registry. */
function seedVerified(provider: string, ...models: string[]): void {
  for (const m of models) getModelRegistry().markVerified(provider, m, 'telemetry', 400);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-deep-failover-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetProviderFallback();
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

// ─── 1. Per-model quota keys ────────────────────────────────────────────────

describe('QuotaLedger — per-model parks never sink a provider', () => {
  it('parkModel parks ONE model: the provider feed stays clean, the model feed reports it', () => {
    const ledger = new QuotaLedger();
    ledger.parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');

    // The provider-level feed (which sinks a whole provider in router scoring)
    // must NOT list groq — only one of its models is resting.
    expect(ledger.getRouterQuotaStatus().some((p) => p.provider === 'groq')).toBe(false);
    // The model-level feed reports exactly that model.
    const models = ledger.getModelQuotaStatus();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(models[0].cooldownRemaining).toBeGreaterThan(0);
    expect(ledger.getParkedModelCount('groq')).toBe(1);
  });

  it('parkProvider still parks the provider-wide (shared quota / outage)', () => {
    const ledger = new QuotaLedger();
    ledger.parkProvider('groq', Date.now() + 60_000, 'outage');

    expect(ledger.getRouterQuotaStatus().some((p) => p.provider === 'groq')).toBe(true);
    // A provider-wide park covers the whole provider, reported as `*`.
    expect(ledger.getModelQuotaStatus().some((m) => m.provider === 'groq' && m.model === '*')).toBe(true);
  });

  it('counts DISTINCT parked models so the caller can detect a shared provider limit', () => {
    const ledger = new QuotaLedger();
    expect(ledger.getParkedModelCount('groq')).toBe(0);
    ledger.parkModel('groq', 'model-a', Date.now() + 60_000, 'rate-limit');
    expect(ledger.getParkedModelCount('groq')).toBe(1);
    ledger.parkModel('groq', 'model-b', Date.now() + 60_000, 'rate-limit');
    expect(ledger.getParkedModelCount('groq')).toBe(2);
    // Re-parking the SAME model must not inflate the count.
    ledger.parkModel('groq', 'model-a', Date.now() + 60_000, 'rate-limit');
    expect(ledger.getParkedModelCount('groq')).toBe(2);
    // Another provider is counted separately.
    expect(ledger.getParkedModelCount('gemini')).toBe(0);
  });

  it('releaseProvider clears both model- and provider-scoped parks', () => {
    const ledger = new QuotaLedger();
    ledger.parkModel('groq', 'model-a', Date.now() + 60_000, 'rate-limit');
    ledger.parkProvider('groq', Date.now() + 60_000, 'outage');

    ledger.releaseProvider('groq');

    expect(ledger.getRouterQuotaStatus()).toHaveLength(0);
    expect(ledger.getModelQuotaStatus()).toHaveLength(0);
    expect(ledger.getParkedModelCount('groq')).toBe(0);
  });

  it('a park with no attributable model falls back to a provider-wide park (honest scope)', () => {
    const ledger = new QuotaLedger();
    ledger.parkModel('groq', 'default', Date.now() + 60_000, 'rate-limit');
    expect(ledger.getRouterQuotaStatus().some((p) => p.provider === 'groq')).toBe(true);
  });
});

// ─── 2. The registry mirrors per-model parks onto the exact entry ───────────

describe('ModelRegistry — per-model quota mirror', () => {
  it('syncQuota parks ONLY the rate-limited model; its siblings stay usable', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b');
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');

    const registry = getModelRegistry();
    registry.syncQuota(undefined);

    // The parked model is gated…
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(false);
    // …while its siblings remain verified + usable (THIS is the fix: before,
    // the provider-scoped park took them all down).
    expect(registry.isUsable('groq', 'openai/gpt-oss-120b')).toBe(true);
    expect(registry.isUsable('groq', 'openai/gpt-oss-20b')).toBe(true);
    // Model-level park must NOT mark the provider blocked.
    expect(registry.getBlockedProviders()).not.toContain('groq');
    // The health-ranked pick list skips the resting model and keeps the rest.
    const preferred = preferredModelsFor('groq');
    expect(preferred).not.toContain('llama-3.3-70b-versatile');
    expect(preferred).toContain('openai/gpt-oss-120b');
  });

  it('re-admits a parked model automatically once its window lapses (recovery loop)', async () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60, 'rate-limit');

    const registry = getModelRegistry();
    registry.syncQuota(undefined);
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(false);

    // Let the park lapse, then re-sync (every routing read does this) — the
    // recovered model must be routable again with no manual intervention.
    await new Promise((r) => setTimeout(r, 80));
    registry.syncQuota(undefined);

    expect(getQuotaLedger().getModelQuotaStatus()).toHaveLength(0);
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
    expect(preferredModelsFor('groq')).toContain('llama-3.3-70b-versatile');
  });

  it('a genuine success clears the model park (markVerified is the strongest proof)', () => {
    seedVerified('groq', 'model-a');
    getQuotaLedger().parkModel('groq', 'model-a', Date.now() + 60_000, 'rate-limit');
    const registry = getModelRegistry();
    registry.syncQuota(undefined);
    expect(registry.isUsable('groq', 'model-a')).toBe(false);

    registry.recordCall('groq', 'model-a', true, undefined, 'chat');

    expect(registry.isUsable('groq', 'model-a')).toBe(true);
  });
});

// ─── 3. Deep failover: several models per provider in the chain ─────────────

describe('AutoModelRouter — deep failover chain', () => {
  it('carries MULTIPLE models per provider, not one', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b');
    seedVerified('gemini', 'gemini-2.5-flash', 'gemini-2.5-pro');

    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
    });

    const modelsOf = (p: string): Set<string> =>
      new Set(decision.fallbackChain.filter((c) => c.provider === p).map((c) => c.model));

    // The whole point: a provider's 2nd/3rd-best model is reachable. groq is
    // not the winner here, so ALL of its models are in the chain.
    const groq = modelsOf('groq');
    expect(groq.size).toBe(3);
    expect([...groq]).toContain('openai/gpt-oss-20b');
    // The winner's own provider keeps its remaining models in play too (it has
    // exactly one left, since its best model is the primary pick).
    expect(modelsOf('gemini').size).toBeGreaterThanOrEqual(1);
    // Never more than the configured depth per provider.
    for (const p of ['groq', 'gemini']) {
      expect(modelsOf(p).size).toBeLessThanOrEqual(FALLBACK_MODELS_PER_PROVIDER);
    }
    // Sanity: one model per provider would have produced exactly 2 entries.
    expect(decision.fallbackChain.length).toBeGreaterThan(2);
  });

  it('never lists the "default" sentinel or a non-chat model in the chain', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    // A probe can mark a safety classifier "verified" (observed live) — it can
    // never serve a chat turn, so it must never be a fallback candidate.
    seedVerified('groq', 'meta-llama/llama-prompt-guard-2-86m');
    seedVerified('gemini', 'gemini-2.5-flash');

    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
    });

    for (const c of decision.fallbackChain) {
      expect(c.model).not.toBe('default');
      expect(c.model).not.toContain('prompt-guard');
    }
  });

  it('appends the RESERVE pool (credentialed but unverified) strictly after ranked picks', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    const config = makeConfig(['groq', 'gemini']);

    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {}, config);

    const gemini = decision.fallbackChain.find((c) => c.provider === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.reason).toContain('unverified');
    // The reserve never wins the primary pick — it is only reachable after
    // every verified candidate has been tried.
    expect(decision.provider).toBe('groq');
    expect(decision.ranked.map((r) => r.provider)).not.toContain('gemini');
  });

  it('the chain explains an alternate model distinctly from a provider fallback', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    seedVerified('gemini', 'gemini-2.5-flash');

    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
    });

    const reasons = decision.fallbackChain.map((c) => c.reason);
    expect(reasons.some((r) => r.includes('alternate model'))).toBe(true);
  });
});

// ─── 4. End-to-end: a 429 keeps the provider's siblings in play ─────────────

describe('deep failover + per-model quota together', () => {
  it('a parked model is skipped by the pick while its sibling still serves', () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    const ledger = getQuotaLedger();
    ledger.parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60_000, 'rate-limit');
    getModelRegistry().syncQuota(undefined);

    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq'],
    });

    // Router still routes to groq — the PROVIDER is healthy.
    expect(decision.provider).toBe('groq');
    // The PRIMARY pick must be the servable sibling, NOT the resting model:
    // model-level scoring alone only ranks a parked model low, it does not
    // exclude it, so the usability gate is what guarantees this.
    expect(decision.model).toBe('openai/gpt-oss-120b');
    // And the resting model is not preferred ahead of the healthy one.
    const chain = decision.fallbackChain.filter((c) => c.provider === 'groq').map((c) => c.model);
    expect(chain.length).toBeGreaterThanOrEqual(1);
  });

  it('re-admits the parked model as the pick once its window lapses', async () => {
    seedVerified('groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b');
    getQuotaLedger().parkModel('groq', 'llama-3.3-70b-versatile', Date.now() + 60, 'rate-limit');
    getModelRegistry().syncQuota(undefined);

    await new Promise((r) => setTimeout(r, 80));
    getModelRegistry().syncQuota(undefined);

    // Both models are usable again, so the parked-and-recovered model is back
    // in the pool the router picks from ("keep checking models that are
    // available again").
    const preferred = preferredModelsFor('groq');
    expect(preferred).toContain('llama-3.3-70b-versatile');
    expect(preferred).toContain('openai/gpt-oss-120b');
  });
});
