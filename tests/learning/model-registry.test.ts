/**
 * ModelRegistry — persistent Model Availability Registry tests.
 *
 * Covers:
 * 1. markListed → unverified entries; verified survives a re-probe
 * 2. markVerified → usable; isUsable fast-path reads
 * 3. markUnavailable → 403/404 ("key exists but model not purchasable")
 * 4. Quota parking (parkProvider / releaseProvider / syncQuota from ledger)
 * 5. Telemetry recordCall — success upgrades, auth/rate-limit failures park
 * 6. pruneStale demotes old verified entries
 * 7. resolveVerifiedModel curated-first fast path
 * 8. getUsableProviders / getVerifiedModels filtering
 * 9. Persistence: JSON mirror honors BUFF_MEMORY_DIR; vector mirror auto-tiers
 *    (falls back to the JSON backend when FAISS isn't installed — never throws)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ModelRegistry,
  resetModelRegistry,
  getModelRegistry,
  DEFAULT_STALE_MS,
} from '../../src/learning/model-registry.js';
import { QuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetVectorBackendSelection, setVectorBackendOverride } from '../../src/memory/vector-store.js';
import { getEventBus, EventNames, resetEventBus } from '../../src/observability/event-bus.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeConfigManager(quota?: Record<string, unknown>) {
  return {
    getAll: () => ({ routing: { quota } }),
    hasRequiredCredentials: () => true,
    getProviderConfig: () => ({ config: { model: 'default' } }),
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ModelRegistry — probe / spot-check lifecycle', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json'); // hermetic: force the JSON backend
    resetModelRegistry();
    resetQuotaLedger();
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('markListed creates unverified entries; isUsable is false until verified', () => {
    const registry = new ModelRegistry();
    registry.markListed('gemini', ['gemini-2.5-flash', 'gemini-2.0-flash']);

    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unverified');
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);
    expect(registry.getVerifiedModels('gemini')).toHaveLength(0);
  });

  it('markVerified upgrades to usable; a later probe does not downgrade it', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check', 420);

    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.latencyMs).toBe(420);

    // Re-probe (listModels) after verification must keep it verified.
    registry.markListed('gemini', ['gemini-2.5-flash', 'new-model']);
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(registry.getEntry('gemini', 'new-model')?.status).toBe('unverified');
  });

  it('markListed records the provider-advertised context window and preserves it across rebuilds/reloads', () => {
    const registry = new ModelRegistry();
    registry.markListed('openrouter', [
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter', contextWindowTokens: 128_000 },
      'meta-llama/llama-3.3-70b-instruct', // legacy bare id — no window
    ]);

    expect(registry.getEntry('openrouter', 'openai/gpt-4o')?.contextWindowTokens).toBe(128_000);
    expect(registry.getEntry('openrouter', 'meta-llama/llama-3.3-70b-instruct')?.contextWindowTokens).toBeUndefined();

    // markVerified rebuilds the entry — the live window survives.
    registry.markVerified('openrouter', 'openai/gpt-4o', 'spot-check', 300);
    expect(registry.getEntry('openrouter', 'openai/gpt-4o')?.contextWindowTokens).toBe(128_000);

    // markUnavailable rebuilds too.
    registry.markUnavailable('openrouter', 'openai/gpt-4o', '403 permission denied', 'spot-check');
    expect(registry.getEntry('openrouter', 'openai/gpt-4o')?.contextWindowTokens).toBe(128_000);

    // And the JSON mirror survives a full reload.
    const reloaded = new ModelRegistry();
    expect(reloaded.getEntry('openrouter', 'openai/gpt-4o')?.contextWindowTokens).toBe(128_000);
  });

  it('markUnavailable captures the 403/404 "key exists but model not purchasable" case', () => {
    const registry = new ModelRegistry();
    registry.markListed('openrouter', ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct']);
    registry.markUnavailable('openrouter', 'openai/gpt-4o', '403 permission denied', 'spot-check');

    const entry = registry.getEntry('openrouter', 'openai/gpt-4o');
    expect(entry?.status).toBe('unavailable');
    expect(entry?.lastError).toContain('403');
    expect(registry.isUsable('openrouter', 'openai/gpt-4o')).toBe(false);
  });

  it('getVerifiedModels + getUsableProviders only surface usable models', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', 'auth', 'spot-check');
    registry.markListed('openrouter', ['openai/gpt-4o-mini']);

    expect(registry.getVerifiedModels('gemini')).toEqual(['gemini-2.5-flash']);
    expect(registry.getUsableProviders().sort()).toEqual(['gemini', 'groq']);
  });

  it('latency EMA blends measured spot-checks', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check', 100);
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check', 300);
    // EMA(α=0.3): 0.3*300 + 0.7*100 = 160
    expect(registry.getEntry('groq', 'llama-3.3-70b-versatile')?.latencyMs).toBe(160);
  });

  it('getBlockedProviders returns providers whose every model is unavailable/parked', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markUnavailable('gemini', 'gemini-2.5-flash', '403 permission denied', 'spot-check');
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', 'auth', 'spot-check');
    // openrouter only unverified → NOT blocked ("not yet probed" ≠ "dead")
    registry.markListed('openrouter', ['openai/gpt-4o-mini']);

    expect(registry.getBlockedProviders().sort()).toEqual(['gemini', 'nim']);
  });

  it('getBlockedProviders does not block a provider that still has a verified model', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-1.5-flash', 'spot-check');
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    expect(registry.getBlockedProviders()).not.toContain('gemini');
  });

  it('getDegradedProviders flags a provider with 0 verified + ≥3 unavailable (ISSUE-002 pre-filter)', () => {
    const registry = new ModelRegistry();
    // openrouter: 3 unavailable, 0 verified → DEGRADED by the explicit
    // 0-verified + ≥3-unavailable rule (the router's registry pre-filter).
    registry.markUnavailable('openrouter', 'openai/gpt-4o', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'openai/gpt-4o-mini', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'anthropic/claude-3.5-sonnet', '401', 'telemetry');
    // gemini: only 2 unavailable + 1 verified — NOT degraded (has a working model).
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markUnavailable('gemini', 'gemini-1.5-pro', '403', 'telemetry');
    registry.markUnavailable('gemini', 'gemini-2.0-flash', '403', 'telemetry');
    // groq: only 1 unavailable — NOT degraded (below the threshold).
    registry.markUnavailable('groq', 'llama-3.3-70b-versatile', 'auth', 'telemetry');
    // A verified (usable) provider is never degraded even with dead models
    // alongside — nim verifies one model after accumulating failures.
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', '503', 'telemetry');
    registry.markUnavailable('nim', 'meta/llama-3.1-8b-instruct', '503', 'telemetry');
    registry.markUnavailable('nim', 'mistralai/mixtral-8x7b', '503', 'telemetry');
    registry.markVerified('nim', 'meta/llama-3.3-70b-instruct', 'spot-check');

    expect(registry.getDegradedProviders().sort()).toEqual(['openrouter']);
    // Consistency: an all-models-unavailable provider is ALSO blocked by the
    // existing (stricter) check — the degraded rule is the explicit
    // thresholded form of the same registry knowledge.
    expect(registry.getBlockedProviders()).toContain('openrouter');
    // gemini/nim keep a verified model → neither blocked nor degraded.
    expect(registry.getBlockedProviders()).not.toContain('gemini');
    expect(registry.getDegradedProviders()).not.toContain('gemini');
    expect(registry.getDegradedProviders()).not.toContain('nim');
  });

  it('getDegradedProviders does not flag a provider that later verifies a model (recovery)', () => {
    const registry = new ModelRegistry();
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', '503', 'telemetry');
    registry.markUnavailable('nim', 'meta/llama-3.1-8b-instruct', '503', 'telemetry');
    registry.markUnavailable('nim', 'mistralai/mixtral-8x7b', '503', 'telemetry');
    expect(registry.getDegradedProviders()).toContain('nim');
    // One genuine verification proves the provider serves again → not degraded.
    registry.markVerified('nim', 'meta/llama-3.3-70b-instruct', 'spot-check');
    expect(registry.getDegradedProviders()).not.toContain('nim');
  });

  it('getProviderStats cites verified/unverified/unavailable/parked counts per provider', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markListed('gemini', ['gemini-1.5-pro']);
    registry.markUnavailable('gemini', 'gemini-2.0-flash', '403', 'telemetry');
    registry.markUnavailable('gemini', 'gemini-1.0-pro', '403', 'telemetry');

    const stats = registry.getProviderStats('gemini');
    expect(stats.verified).toBe(1);
    expect(stats.unverified).toBe(1);
    expect(stats.unavailable).toBe(2);
    expect(stats.parked).toBe(0);
    // Parking the whole provider flips the count to parked (parked wins).
    registry.parkProvider('gemini', Date.now() + 60_000);
    const parked = registry.getProviderStats('gemini');
    expect(parked.parked).toBe(4);
    expect(parked.verified).toBe(0);
    // Untracked provider → all zeros, never throws.
    expect(registry.getProviderStats('untracked')).toEqual({ verified: 0, unverified: 0, unavailable: 0, parked: 0 });
  });

  it('recordCall failures feed getBlockedProviders (chat telemetry → predictive skip)', () => {
    const registry = new ModelRegistry();
    registry.recordCall('gemini', 'gemini-2.5-flash', false, 'auth');
    registry.recordCall('nim', 'meta/llama-3.3-70b-instruct', false, 'rate-limit');
    // A successful local call keeps local usable (not blocked).
    registry.recordCall('local', 'llama3.2', true);

    expect(registry.getBlockedProviders().sort()).toEqual(['gemini', 'nim']);
    expect(registry.getUsableProviders()).toEqual(['local']);
  });

  it('a transient (server) recordCall failure does not block the provider', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'server');
    expect(registry.getBlockedProviders()).not.toContain('groq');
  });
});

describe('ModelRegistry — quota parking & telemetry', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    resetEventBus();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parkProvider excludes a verified model until the time passes', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');

    registry.parkProvider('gemini', Date.now() + 60_000);
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);

    registry.releaseProvider('gemini');
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(true);
  });

  it('unblockProvider demotes unavailable→unverified and clears parks (escape hatch)', () => {
    const registry = new ModelRegistry();
    // Every tracked model unavailable → provider is predictively blocked.
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    registry.markUnavailable('gemini', 'gemini-1.5-flash', '403 permission denied', 'spot-check');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'rate-limit'); // parks quota
    expect(registry.getBlockedProviders().sort()).toEqual(['gemini', 'groq']);

    const gemini = registry.unblockProvider('gemini');
    expect(gemini).toEqual({ demoted: 2, unparked: 0 });
    // Demoted → unverified, so the provider is no longer blocked (unverified alone never blocks).
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unverified');
    expect(registry.getBlockedProviders()).not.toContain('gemini');
    // The unrelated provider is untouched.
    expect(registry.getBlockedProviders()).toContain('groq');

    const groq = registry.unblockProvider('groq');
    expect(groq).toEqual({ demoted: 1, unparked: 1 });
    expect(registry.getEntry('groq', 'llama-3.3-70b-versatile')?.quotaParkedUntil).toBe(0);
    expect(registry.getBlockedProviders()).toHaveLength(0);
  });

  it('unblockProvider is a no-op for an untracked provider (0/0)', () => {
    const registry = new ModelRegistry();
    expect(registry.unblockProvider('openrouter')).toEqual({ demoted: 0, unparked: 0 });
    expect(registry.getBlockedProviders()).toHaveLength(0);
  });

  it('unblockProvider emits MODEL_REGISTRY_UPDATED so the watcher re-probes the provider', () => {
    const registry = new ModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    const events: string[] = [];
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, (record) => {
      events.push((record.data as { providers: string[]; detail: string }).detail);
    });

    try {
      registry.unblockProvider('gemini');
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('manually unblocked');
    } finally {
      unsub();
    }
  });

  it('syncQuota reads the QuotaLedger router feed (exhausted provider parked)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    // Exhaust gemini in the ledger with a 1-request limit.
    const ledger = new QuotaLedger();
    ledger.recordUsage('gemini', 'default', 100, 50);
    const config = makeConfigManager({ gemini: { requestsPerWindow: 1, windowMs: 3_600_000 } });

    registry.syncQuota(config);
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('syncQuota mirrors FULL quota telemetry (tokens/requests/reset/remaining) per model', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    const ledger = new QuotaLedger();
    // gemini: 2000 tokens used, 2 requests, 1k-token window → 1000 remaining
    ledger.recordUsage('gemini', 'gemini-2.5-flash', 1200, 800);
    ledger.recordUsage('gemini', 'gemini-2.5-flash', 300, 100);
    // groq: no limit configured → remaining = -1 (unlimited)
    ledger.recordUsage('groq', 'llama-3.3-70b-versatile', 50, 10);
    const config = makeConfigManager({
      gemini: { tokensPerWindow: 3000, windowMs: 3_600_000 },
    });

    registry.syncQuota(config);

    const gemini = registry.getEntry('gemini', 'gemini-2.5-flash');
    expect(gemini?.tokensConsumed).toBe(2400);
    expect(gemini?.requests).toBe(2);
    expect(gemini?.remainingTokens).toBe(600); // 3000 - 2400
    expect(gemini?.resetsInMs).toBeGreaterThan(0);

    const groq = registry.getEntry('groq', 'llama-3.3-70b-versatile');
    expect(groq?.tokensConsumed).toBe(60);
    expect(groq?.remainingTokens).toBe(-1); // no limit → unlimited
  });

  it('getRouterQuotaStatus is a UNIFIED single-store feed (registry parks mirror the ledger)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    const ledger = new QuotaLedger();
    ledger.recordUsage('gemini', 'default', 100, 50);
    const config = makeConfigManager({ gemini: { requestsPerWindow: 1, windowMs: 3_600_000 } });

    const parked = registry.getRouterQuotaStatus(config);
    expect(parked.some((p) => p.provider === 'gemini' && p.cooldownRemaining > 0)).toBe(true);
    expect(parked.some((p) => p.provider === 'groq')).toBe(false);

    // Idempotent + cheap: calling again mirrors nothing new (no crash, same
    // shape). The cooldown countdown ticks down in real time, so compare the
    // per-provider remaining-time with a small tolerance instead of exact
    // equality (a 1ms drift between calls is expected and harmless).
    const again = registry.getRouterQuotaStatus(config);
    expect(again.map((p) => p.provider).sort()).toEqual(parked.map((p) => p.provider).sort());
    const g1 = parked.find((p) => p.provider === 'gemini')!.cooldownRemaining;
    const g2 = again.find((p) => p.provider === 'gemini')!.cooldownRemaining;
    expect(Math.abs(g1 - g2)).toBeLessThan(100); // both reflect the same window
    expect(again.some((p) => p.provider === 'groq')).toBe(false);
  });

  it('getRouterQuotaStatus unions ledger parks for providers the registry never tracked', () => {
    const registry = new ModelRegistry();
    // No registry entry for openrouter — but the ledger parks it explicitly.
    const ledger = new QuotaLedger();
    ledger.parkProvider('openrouter', Date.now() + 60_000, 'manual');

    const parked = registry.getRouterQuotaStatus(undefined);
    expect(parked.some((p) => p.provider === 'openrouter' && p.cooldownRemaining > 0)).toBe(true);
  });

  it('markUnavailable emits MODEL_REGISTRY_UPDATED so the watch daemon reacts', () => {
    const registry = new ModelRegistry();
    const events: Array<{ provider: string; detail: string }> = [];
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, (record) => {
      const d = record.data as { providers: string[]; detail: string };
      events.push({ provider: d.providers[0], detail: d.detail });
    });

    try {
      registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
      // The flip to unavailable must be reported to the watcher.
      registry.markUnavailable('gemini', 'gemini-2.5-flash', '403 permission denied', 'telemetry');
      const unavailable = events.find((e) => e.detail.includes('403'));
      expect(unavailable).toBeDefined();
      expect(unavailable?.provider).toBe('gemini');
    } finally {
      unsub();
    }
  });

  it('recordCall auth failure emits MODEL_REGISTRY_UPDATED; transient failure does not', () => {
    const registry = new ModelRegistry();
    let count = 0;
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, () => {
      count++;
    });

    try {
      // Transient server failure — flips nothing, so no event.
      registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'server');
      expect(count).toBe(0);
      // Definitive auth failure — flips to unavailable, so an event fires.
      registry.recordCall('gemini', 'gemini-2.5-flash', false, 'auth');
      expect(count).toBe(1);
    } finally {
      unsub();
    }
  });

  it('parkProvider emits MODEL_REGISTRY_UPDATED; releaseProvider emits again', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    const events: string[] = [];
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, (record) => {
      events.push((record.data as { detail: string }).detail);
    });

    try {
      registry.parkProvider('gemini', Date.now() + 60_000);
      registry.releaseProvider('gemini');
      expect(events).toHaveLength(2);
      expect(events[0]).toContain('parked');
      expect(events[1]).toContain('released');
    } finally {
      unsub();
    }
  });

  it('emits source metadata so the watcher can ignore its own probe writes', () => {
    const registry = new ModelRegistry();
    const sources: string[] = [];
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, (record) => {
      sources.push((record.data as { source: string }).source);
    });

    try {
      // A spot-check (the watcher's own write) marks a model unavailable.
      registry.markUnavailable('gemini', 'gemini-2.5-flash', '403 permission denied', 'spot-check');
      // A telemetry failure (chat) marks another unavailable.
      registry.markUnavailable('groq', 'llama-3.3-70b-versatile', 'auth', 'telemetry');
      // A promotion from real usage (telemetry) is reported too.
      registry.recordCall('nim', 'meta/llama-3.3-70b-instruct', true);

      expect(sources).toContain('spot-check');
      expect(sources).toContain('telemetry');
      // The verified transition carries the telemetry source.
      expect(sources.filter((s) => s === 'telemetry').length).toBeGreaterThanOrEqual(2);
    } finally {
      unsub();
    }
  });

  it('markVerified only emits on genuine transitions, not every success', () => {
    const registry = new ModelRegistry();
    let count = 0;
    const unsub = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, () => {
      count++;
    });

    try {
      registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check'); // transition → 1
      registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check'); // already verified → 0
      expect(count).toBe(1);
    } finally {
      unsub();
    }
  });

  it('recordCall success upgrades an entry to verified (telemetry source)', () => {
    const registry = new ModelRegistry();
    registry.recordCall('nim', 'meta/llama-3.3-70b-instruct', true);
    expect(registry.isUsable('nim', 'meta/llama-3.3-70b-instruct')).toBe(true);
    expect(registry.getEntry('nim', 'meta/llama-3.3-70b-instruct')?.source).toBe('telemetry');
  });

  it('recordCall auth failure marks unavailable; rate-limit failure parks quota', () => {
    const registry = new ModelRegistry();
    registry.recordCall('gemini', 'gemini-2.5-flash', false, 'auth');
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unavailable');
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);

    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'rate-limit');
    const groq = registry.getEntry('groq', 'llama-3.3-70b-versatile');
    expect(groq?.status).toBe('unavailable');
    expect(groq?.quotaParkedUntil).toBeGreaterThan(Date.now());
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('transient recordCall failures bump errorRate but keep the model usable', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'server');

    const entry = registry.getEntry('groq', 'llama-3.3-70b-versatile');
    expect(entry?.status).toBe('verified'); // transient doesn't flip
    expect(entry?.errorRate).toBeCloseTo(0.2, 5); // EMA α=0.2
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('pruneStale demotes verified entries older than the stale window', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    // Age the entry beyond the stale window.
    const entry = registry.getEntry('gemini', 'gemini-2.5-flash')!;
    entry.lastVerifiedAt = Date.now() - DEFAULT_STALE_MS - 1000;

    const demoted = registry.pruneStale();
    expect(demoted).toBe(1);
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unverified');
  });

  it('pruneAbsentModels removes entries for models deleted from the local system', () => {
    const registry = new ModelRegistry();
    registry.markListed('local', [{ id: 'still-here' }, { id: 'deleted-by-user' }]);

    // The user ran `ollama rm deleted-by-user` — the next refresh lists only
    // the surviving model.
    const pruned = registry.pruneAbsentModels('local', ['still-here']);
    expect(pruned).toBe(1);
    expect(registry.getEntry('local', 'deleted-by-user')).toBeUndefined();
    expect(registry.getEntry('local', 'still-here')).toBeDefined();
  });

  it('pruneAbsentModels DEMOTES verified-but-absent models instead of deleting them (preserves learned telemetry)', () => {
    const registry = new ModelRegistry();
    registry.markListed('local', [{ id: 'verified-model' }]);
    registry.markVerified('local', 'verified-model', 'telemetry', 120, 'chat');

    // A PARTIAL listModels response (model mid-pull / gateway hiccup) — the
    // verified model is absent this pass but its history must survive.
    const pruned = registry.pruneAbsentModels('local', []);
    expect(pruned).toBe(1);
    const entry = registry.getEntry('local', 'verified-model');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('unavailable');
    expect(entry!.lastError).toContain('model deleted from local system');
    // Learned telemetry survives the demote.
    expect(entry!.latencyMs).toBe(120);
  });

  it('pruneAbsentModels never removes entries from OTHER providers', () => {
    const registry = new ModelRegistry();
    registry.markListed('local', [{ id: 'local-model' }]);
    registry.markListed('gemini', [{ id: 'gemini-model' }]);

    const pruned = registry.pruneAbsentModels('local', ['different-local-model']);
    expect(pruned).toBe(1);
    // The gemini entry is untouched — pruning is scoped to the provider.
    expect(registry.getEntry('gemini', 'gemini-model')).toBeDefined();
    expect(registry.getEntry('local', 'local-model')).toBeUndefined();
  });

  it('resolveVerifiedModel prefers curated candidates, falls back to any verified', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'openai/gpt-oss-20b', 'spot-check');
    registry.markVerified('groq', 'llama-3.1-8b-instant', 'spot-check');

    // Curated order: llama-3.3-70b-versatile (not verified) → llama-3.1-8b-instant (verified)
    expect(registry.resolveVerifiedModel('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']))
      .toBe('llama-3.1-8b-instant');
  });
});

describe('ModelRegistry — per-action "learned from real usage" telemetry', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('recordCall success logs a verified event attributed to the action', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');

    const tele = registry.getActionTelemetry();
    expect(tele.enabled).toBe(true);
    expect(tele.total).toBe(1);
    const chat = tele.actions.find((a) => a.action === 'chat');
    expect(chat?.verified).toBe(1);
    expect(chat?.verifiedModels).toHaveLength(1);
    expect(chat?.verifiedModels[0]).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
  });

  it('recordCall auth failure logs a killed event with the reason', () => {
    const registry = new ModelRegistry();
    registry.recordCall('gemini', 'gemini-2.5-flash', false, 'auth', 'execute');

    const tele = registry.getActionTelemetry();
    const execute = tele.actions.find((a) => a.action === 'execute');
    expect(execute?.killed).toBe(1);
    expect(execute?.killedModels[0]).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', reason: 'auth' });
  });

  it('transient failures count as transient, never as killed', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'server', 'chat');

    const tele = registry.getActionTelemetry();
    const chat = tele.actions.find((a) => a.action === 'chat');
    expect(chat?.transient).toBe(1);
    expect(chat?.killed).toBe(0);
    expect(chat?.killedModels).toHaveLength(0);
  });

  it('markUnavailable with an action logs a killed event (model-not-found path)', () => {
    const registry = new ModelRegistry();
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', 'model not found', 'telemetry', 0, 'plan');

    const tele = registry.getActionTelemetry();
    const plan = tele.actions.find((a) => a.action === 'plan');
    expect(plan?.killed).toBe(1);
    expect(plan?.killedModels[0].reason).toContain('model not found');
  });

  it('anonymous writes (no action) update health but are NOT logged', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true);
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');

    // Health updated...
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unavailable');
    // ...but no per-action rows (dashboard panel stays empty).
    expect(registry.getActionTelemetry().enabled).toBe(false);
  });

  it('repeated writes dedupe to one chip per provider × model (latest wins)', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');

    const tele = registry.getActionTelemetry();
    const chat = tele.actions.find((a) => a.action === 'chat');
    expect(chat?.verified).toBe(2); // honest volume
    expect(chat?.verifiedModels).toHaveLength(1); // one chip
    // The daily timeline dedupes its per-day events the same way (latest per
    // provider × model × outcome) while keeping raw counts.
    const today = chat!.timeline[chat!.timeline.length - 1];
    expect(today.verified).toBe(2);
    expect(today.events).toHaveLength(1);
    expect(today.events[0]).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'verified' });
  });

  it('action log persists to BUFF_MEMORY_DIR and survives a restart', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');

    const path = join(tempDir, 'model-registry-actions.jsonl');
    expect(existsSync(path)).toBe(true);

    resetModelRegistry();
    const fresh = new ModelRegistry();
    const tele = fresh.getActionTelemetry();
    expect(tele.enabled).toBe(true);
    expect(tele.actions.find((a) => a.action === 'chat')?.verified).toBe(1);
  });

  it('each action carries a 14-day daily timeline (ascending) bucketing events', () => {
    const registry = new ModelRegistry();
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    registry.recordCall('gemini', 'gemini-2.5-flash', false, 'auth', 'chat');

    const tele = registry.getActionTelemetry();
    const chat = tele.actions.find((a) => a.action === 'chat');
    expect(chat?.timeline).toHaveLength(14); // TIMELINE_DAYS
    // Buckets ascend oldest → newest by UTC day start.
    for (let i = 1; i < (chat?.timeline.length ?? 0); i++) {
      expect(chat!.timeline[i].day).toBeGreaterThan(chat!.timeline[i - 1].day);
    }
    // Both events landed in today's bucket.
    const today = chat!.timeline[chat!.timeline.length - 1];
    expect(today.verified).toBe(1);
    expect(today.killed).toBe(1);
    expect(today.transient).toBe(0);
    // Older days exist but hold zero events.
    expect(chat!.timeline[0].verified + chat!.timeline[0].killed + chat!.timeline[0].transient).toBe(0);
    // Each day bucket carries the RAW events so the scrubbable dashboard chart
    // can render that day's exact chips (provider × model × outcome).
    expect(today.events).toHaveLength(2);
    const verifiedEv = today.events.find((e) => e.outcome === 'verified');
    expect(verifiedEv).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    const killedEv = today.events.find((e) => e.outcome === 'unavailable');
    expect(killedEv).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', errorType: 'auth' });
    // Days with no events carry an empty events array (stable shape).
    expect(chat!.timeline[0].events).toEqual([]);
  });

  it('timeline buckets split by UTC day (an old event lands in its own day bucket)', () => {
    const registry = new ModelRegistry();
    // Force a deterministic timestamps by writing the JSONL directly.
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const lines = [
      { timestamp: now, action: 'execute', provider: 'groq', model: 'm1', outcome: 'verified' },
      { timestamp: now - 3 * DAY_MS, action: 'execute', provider: 'nim', model: 'm2', outcome: 'unavailable', errorType: 'auth' },
    ];
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(join(tempDir, 'model-registry-actions.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const tele = registry.getActionTelemetry();
    const execute = tele.actions.find((a) => a.action === 'execute');
    expect(execute?.verified).toBe(1);
    expect(execute?.killed).toBe(1);
    const today = execute!.timeline[execute!.timeline.length - 1];
    expect(today.verified).toBe(1);
    // The 3-day-old kill is in an earlier bucket, not today.
    expect(today.killed).toBe(0);
    const oldDay = execute!.timeline[execute!.timeline.length - 4];
    expect(oldDay.killed).toBe(1);
    // The old kill's raw event (with reason) rides along in its own day bucket.
    expect(oldDay.events).toHaveLength(1);
    expect(oldDay.events[0]).toMatchObject({
      provider: 'nim', model: 'm2', outcome: 'unavailable', errorType: 'auth',
    });
  });

  it('recordPartial logs a dedicated partial outcome (P4 M4.4 mid-stream learning)', () => {
    const registry = new ModelRegistry();
    // A provider that STARTED streaming then died — distinct from a clean error.
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server', 128);

    const tele = registry.getActionTelemetry();
    expect(tele.enabled).toBe(true);
    const chat = tele.actions.find((a) => a.action === 'chat');
    expect(chat?.partial).toBe(1);
    expect(chat?.transient).toBe(0); // NOT an error — a partial is its own signal
    expect(chat?.killed).toBe(0); // and NOT a kill — it started, it can finish next time
    // The raw event carries the streamed-chunk count for the dashboard.
    const today = chat!.timeline[chat!.timeline.length - 1];
    expect(today.partial).toBe(1);
    const ev = today.events.find((e) => e.outcome === 'partial');
    expect(ev).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile', errorType: 'server' });
  });

  it('partial events do NOT flip registry status (started-but-died ≠ dead)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout', 64);
    // Still verified and usable — a partial mid-stream interruption is not a
    // definitive failure, so routing must not block the provider over it.
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('partialModels aggregates one chip per provider × model (latest wins) for the dashboard', () => {
    const registry = new ModelRegistry();
    // Same provider × model interrupted twice, plus a second model once.
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout', 64);
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server', 512);
    registry.recordPartial('groq', 'llama-3.3-70b-instant', 'chat', 'disconnect', 8);

    const tele = registry.getActionTelemetry();
    const chat = tele.actions.find((a) => a.action === 'chat');
    // Honest volume counts every interruption.
    expect(chat?.partial).toBe(3);
    // But the chip list dedupes — one chip per provider × model.
    expect(chat?.partialModels).toHaveLength(2);
    const flaky = chat!.partialModels.find((m) => m.model === 'llama-3.3-70b-versatile');
    // Latest reason + streamed-chunk count win.
    expect(flaky?.reason).toBe('server');
    expect(chat!.partialModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'groq', model: 'llama-3.3-70b-instant', reason: 'disconnect' }),
    ]));
  });

  it('recordPartial bumps a partialRate EMA the router can read (flakiness signal)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-instant', 'spot-check');

    // Two mid-stream interruptions on the versatile model.
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    const afterOne = registry.getEntry('groq', 'llama-3.3-70b-versatile')?.partialRate ?? 0;
    expect(afterOne).toBeGreaterThan(0);
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server');
    const afterTwo = registry.getEntry('groq', 'llama-3.3-70b-versatile')?.partialRate ?? 0;
    expect(afterTwo).toBeGreaterThan(afterOne);

    // Status NEVER flips — a partial is not a kill (it started, it can finish).
    expect(registry.getEntry('groq', 'llama-3.3-70b-versatile')?.status).toBe('verified');
    expect(registry.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
    // The untouched model stays clean.
    expect(registry.getEntry('groq', 'llama-3.3-70b-instant')?.partialRate || 0).toBe(0);
    // Provider-level signal reflects the WORST model's flakiness.
    expect(registry.getProviderFlakiness('groq')).toBeCloseTo(afterTwo, 5);
  });

  it('clean successes heal the partialRate flakiness EMA over time', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    const flaky = registry.getEntry('groq', 'llama-3.3-70b-versatile')?.partialRate ?? 0;
    expect(flaky).toBeGreaterThan(0);

    // Repeated clean completions decay the signal (never hard-reset — a single
    // success must NOT wipe the flaky streak, only shave it down).
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    const afterOne = registry.getEntry('groq', 'llama-3.3-70b-versatile')?.partialRate ?? 0;
    expect(afterOne).toBeGreaterThan(0); // decayed, NOT wiped
    expect(afterOne).toBeLessThan(flaky);
    for (let i = 0; i < 7; i++) {
      registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    }
    const healed = registry.getEntry('groq', 'llama-3.3-70b-versatile')?.partialRate ?? 0;
    expect(healed).toBeLessThan(flaky);
    // The provider-level signal heals with it.
    expect(registry.getProviderFlakiness('groq')).toBeLessThan(flaky);

    // The healed rate survives a RESTART — the decay is persisted, not just
    // in-memory (a re-verify rebuild must carry + persist the shaved EMA).
    resetModelRegistry();
    const reloaded = new ModelRegistry();
    expect(reloaded.getProviderFlakiness('groq')).toBeLessThan(flaky);
  });

  it('getProviderFlakiness is 0 for providers with no tracked partials', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    expect(registry.getProviderFlakiness('gemini')).toBe(0);
    expect(registry.getProviderFlakiness('openrouter')).toBe(0); // untracked
  });
});

describe('ModelRegistry — partialRate history (healing sparkline data)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-hist-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json'); // hermetic: force the JSON backend
    resetModelRegistry();
    resetQuotaLedger();
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends a history point on every partial bump and every decay (the sparkline trajectory)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    let e = registry.getEntry('groq', 'llama-3.3-70b-versatile')!;
    expect(e.partialHistory).toHaveLength(1);
    expect(e.partialHistory![0].rate).toBeCloseTo(0.25, 5); // 0 + (1-0)*0.25
    expect(typeof e.partialHistory![0].t).toBe('number');

    // A clean success DECAYS the EMA and appends the healed point — so the
    // dashboard sparkline can show flakiness trending DOWN (healing).
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    e = registry.getEntry('groq', 'llama-3.3-70b-versatile')!;
    expect(e.partialHistory).toHaveLength(2);
    expect(e.partialHistory![1].rate).toBeCloseTo(0.15, 5); // 0.25 - 0.1
    expect(e.partialHistory![1].rate).toBeLessThan(e.partialHistory![0].rate);
  });

  it('preserves partialHistory through a markVerified re-verify (never hard-wiped)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server');
    const before = registry.getEntry('groq', 'llama-3.3-70b-versatile')!.partialHistory;
    expect(before).toHaveLength(2);

    // The rebuild inside markVerified must carry the trajectory (same contract
    // as partialRate surviving a re-verify).
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'telemetry');
    const after = registry.getEntry('groq', 'llama-3.3-70b-versatile')!.partialHistory;
    expect(after).toHaveLength(2);
    expect(after).toEqual(before);
  });

  it('preserves partialHistory through a markUnavailable availability flip', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    const before = registry.getEntry('groq', 'llama-3.3-70b-versatile')!.partialHistory;
    expect(before).toHaveLength(1);

    // An auth/403 availability flip must NOT wipe the reliability signal —
    // the rebuild carries the trajectory (never hard-reset contract).
    registry.markUnavailable('groq', 'llama-3.3-70b-versatile', 'auth', 'spot-check');
    const after = registry.getEntry('groq', 'llama-3.3-70b-versatile')!;
    expect(after.status).toBe('unavailable');
    expect(after.partialHistory).toEqual(before);
    expect(after.partialRate).toBeGreaterThan(0);
  });

  it('caps partialHistory at MAX_PARTIAL_HISTORY (newest kept)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    for (let i = 0; i < 20; i++) {
      registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    }
    const history = registry.getEntry('groq', 'llama-3.3-70b-versatile')!.partialHistory!;
    expect(history).toHaveLength(16);
    // Newest last, and the EMA climbed toward 1 across the burst.
    expect(history[history.length - 1].rate).toBeCloseTo(1, 1);
    expect(history[history.length - 1].rate).toBeGreaterThan(history[0].rate);
  });

  it('formatStatus surfaces the flakiness trend (worsening then healing)', async () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    // Two mid-stream interruptions → EMA climbs → "worsening".
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server');
    let status = await registry.formatStatus();
    expect(status).toContain('⏸ flaky');
    expect(status).toContain('worsening');

    // Two clean completions decay the EMA (0.4375 → 0.2375) below its FIRST
    // history sample (0.25) → "healing", while the signal survives (> 0).
    // (Five decays would fully heal it to 0 — a clean model shows no chip.)
    for (let i = 0; i < 2; i++) {
      registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');
    }
    status = await registry.formatStatus();
    expect(status).toContain('healing');
    // The signal was decayed, never wiped.
    expect(status).toContain('⏸ flaky');
  });

  it('persists partialHistory across a restart (mirror write survives reload)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'timeout');
    registry.recordPartial('groq', 'llama-3.3-70b-versatile', 'chat', 'server');

    resetModelRegistry();
    const reloaded = new ModelRegistry();
    const history = reloaded.getEntry('groq', 'llama-3.3-70b-versatile')?.partialHistory;
    expect(history).toHaveLength(2);
  });
});

describe('ModelRegistry — persistence (JSON mirror + vector auto-tier)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
    resetQuotaLedger();
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the JSON mirror to BUFF_MEMORY_DIR (canonical fast-read store)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');

    const path = join(tempDir, 'model-registry.json');
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.entries['gemini|gemini-2.5-flash']).toBeDefined();
    expect(raw.entries['gemini|gemini-2.5-flash'].status).toBe('verified');
  });

  it('a fresh process re-reads verified state from the mirror (survives restart)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');

    resetModelRegistry();
    const fresh = new ModelRegistry();
    expect(fresh.isUsable('groq', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('mirrors to the vector store namespace (auto-tiers to the JSON backend)', async () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');

    // Force the default 'faiss' preference → createFaissBackend → JSON backend
    // (no native FAISS in CI). Mirror must succeed, never throw.
    await new Promise((r) => setTimeout(r, 50));
    const backend = await registry.vectorBackendName();
    expect(['json', 'faiss-ivf', 'faiss-native']).toContain(backend);

    // The vector snapshot can hydrate the registry in another instance.
    resetModelRegistry();
    const hydrated = new ModelRegistry();
    await hydrated.hydrateFromVector();
    expect(hydrated.isUsable('gemini', 'gemini-2.5-flash')).toBe(true);
  });

  it('singleton honors BUFF_MEMORY_DIR', () => {
    const registry = getModelRegistry();
    registry.markVerified('nim', 'meta/llama-3.3-70b-instruct', 'spot-check');
    expect(existsSync(join(tempDir, 'model-registry.json'))).toBe(true);
  });

  it('reset clears the registry and mirror', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(true);

    registry.reset();
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')).toBeUndefined();
  });

  it('getStatus reports verified / unavailable / parked breakdown', async () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', 'auth', 'spot-check');
    registry.markListed('openrouter', ['openai/gpt-4o-mini']);

    const status = await registry.getStatus();
    expect(status.total).toBe(4);
    expect(status.verified).toBe(2);
    expect(status.unavailable).toBe(1);
    expect(status.unverified).toBe(1);
    expect(status.providers.length).toBe(4);
    const gemini = status.providers.find((p) => p.provider === 'gemini')!;
    expect(gemini.models[0].model).toBe('gemini-2.5-flash');
  });

  it('isUsable respects the stale window (no infinite verification)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    const entry = registry.getEntry('gemini', 'gemini-2.5-flash')!;
    entry.lastVerifiedAt = Date.now() - DEFAULT_STALE_MS - 1000;
    expect(registry.isUsable('gemini', 'gemini-2.5-flash')).toBe(false);
  });
});

describe('ModelRegistry — M2.2 wire-token metering (measured cost inputs)', () => {
  let measuredTempDir: string;
  let measuredOrigDir: string | undefined;

  beforeEach(() => {
    measuredTempDir = mkdtempSync(join(tmpdir(), 'buff-registry-measured-'));
    measuredOrigDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = measuredTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (measuredOrigDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = measuredOrigDir;
    }
    rmSync(measuredTempDir, { recursive: true, force: true });
  });

  it('recordMeasuredUsage EMAs exact tokens per provider × model', () => {
    const registry = new ModelRegistry();
    registry.recordMeasuredUsage('groq', 'llama-3.3-70b-versatile', 100, 50);
    registry.recordMeasuredUsage('groq', 'llama-3.3-70b-versatile', 300, 150);
    const e = registry.getEntry('groq', 'llama-3.3-70b-versatile')!;
    // EMA (α=0.3): 0.3*300 + 0.7*100 = 160; 0.3*150 + 0.7*50 = 80.
    expect(e.measuredInputTokens).toBe(160);
    expect(e.measuredOutputTokens).toBe(80);
    expect(e.measuredSamples).toBe(2);
  });

  it('getMeasuredUsage aggregates sample-weighted across the provider models', () => {
    const registry = new ModelRegistry();
    // Model A: 3 samples @ 200/100  Model B: 1 sample @ 400/200
    for (let i = 0; i < 3; i++) registry.recordMeasuredUsage('groq', 'm-a', 200, 100);
    registry.recordMeasuredUsage('groq', 'm-b', 400, 200);
    const m = registry.getMeasuredUsage('groq')!;
    expect(m).toBeDefined();
    expect(m.inputTokens).toBe(250); // (3*200 + 1*400) / 4
    expect(m.outputTokens).toBe(125); // (3*100 + 1*200) / 4
    expect(m.samples).toBe(4);
    // Other providers untouched.
    expect(registry.getMeasuredUsage('gemini')).toBeUndefined();
  });

  it('measured EMAs survive a later markVerified re-verify', () => {
    const registry = new ModelRegistry();
    registry.recordMeasuredUsage('groq', 'llama-3.3-70b-versatile', 200, 100);
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'telemetry');
    const e = registry.getEntry('groq', 'llama-3.3-70b-versatile')!;
    expect(e.status).toBe('verified');
    expect(e.measuredInputTokens).toBe(200);
    expect(e.measuredOutputTokens).toBe(100);
    expect(e.measuredSamples).toBe(1);
  });

  it('no measured usage anywhere → getMeasuredUsage undefined (estimate fallback)', () => {
    const registry = new ModelRegistry();
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    expect(registry.getMeasuredUsage('gemini')).toBeUndefined();
    expect(registry.getMeasuredUsage('nim')).toBeUndefined();
  });
});
