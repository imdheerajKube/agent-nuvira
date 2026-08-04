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

  it('resolveVerifiedModel prefers curated candidates, falls back to any verified', () => {
    const registry = new ModelRegistry();
    registry.markVerified('groq', 'openai/gpt-oss-20b', 'spot-check');
    registry.markVerified('groq', 'llama-3.1-8b-instant', 'spot-check');

    // Curated order: llama-3.3-70b-versatile (not verified) → llama-3.1-8b-instant (verified)
    expect(registry.resolveVerifiedModel('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']))
      .toBe('llama-3.1-8b-instant');
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
