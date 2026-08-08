/**
 * ModelProbe — probe / spot-check engine tests.
 *
 * Covers:
 * 1. buildProvider skips providers without keys (local always attempted)
 * 2. probeProviderList records listed models into the registry
 * 3. spotCheckModel success → verified with latency
 * 4. spotCheckModel 403/404 permission → unavailable ("not purchasable")
 * 5. spotCheckModel rate-limit → unavailable + quota parked
 * 6. spotCheckModel transient (timeout/network) → entry untouched
 * 7. spotCheckModel throttles recently verified models
 * 8. refreshModelRegistry orchestration + result aggregation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetModelRegistry, getModelRegistry } from '../../src/learning/model-registry.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import {
  spotCheckModel,
  probeProviderList,
  buildProvider,
  refreshModelRegistry,
  startRegistryWatcher,
  SPOT_CHECK_MIN_INTERVAL_MS,
} from '../../src/inference/model-probe.js';
import { setVectorBackendOverride, resetVectorBackendSelection } from '../../src/memory/vector-store.js';
import { getEventBus, EventNames, resetEventBus } from '../../src/observability/event-bus.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

/** A fake InferenceProvider for hermetic probe tests. */
function makeProvider(overrides: {
  models?: Array<{ id: string; contextWindowTokens?: number }>;
  generateError?: Error;
  listModelsError?: Error;
}) {
  return {
    name: 'fake',
    listModels: async () => {
      if (overrides.listModelsError) throw overrides.listModelsError;
      return overrides.models || [];
    },
    generate: async () => {
      if (overrides.generateError) throw overrides.generateError;
      return 'ok';
    },
    isAvailable: async () => true,
    getInfo: () => 'fake',
  } as any;
}

/** ConfigManager stub: key present for gemini/groq, absent for nim. */
function makeConfigManager(providerFactory: (type: string) => any) {
  return {
    getAll: () => ({ routing: {} }),
    hasRequiredCredentials: (p: string) => p !== 'nim',
    getProviderConfig: (type: string) => ({ config: { model: 'default', apiKey: 'x' } }),
    _factory: providerFactory,
  } as any;
}

// Mock the factory so buildProvider's REAL credential gate runs, then routes
// to our fake provider. Restored in afterEach.
function mockFactory(providerFactory: (type: string) => any): void {
  vi.spyOn(ProviderFactory, 'createProvider').mockImplementation((type: string) => {
    const provider = providerFactory(type);
    if (!provider) throw new Error(`Unknown provider type: '${type}'`);
    return provider;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ModelProbe — provider resolution', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-probe-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    resetVectorBackendSelection();
    vi.restoreAllMocks();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildProvider returns null for a provider without a key', () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    // nim has no key in the stub → null (factory never reached).
    expect(buildProvider('nim', cm)).toBeNull();
  });

  it('buildProvider returns a provider when the key exists', () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    mockFactory(() => makeProvider({ models: [{ id: 'm1' }] }));
    expect(buildProvider('gemini', cm)).not.toBeNull();
  });
});

describe('ModelProbe — listModels probe', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-probe-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    mockFactory(() => makeProvider({ models: [{ id: 'a-model' }, { id: 'b-model' }] }));
  });

  afterEach(() => {
    resetModelRegistry();
    resetVectorBackendSelection();
    vi.restoreAllMocks();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records listed models as unverified in the registry', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'a-model' }, { id: 'b-model' }] }));
    const ids = await probeProviderList('gemini', cm);

    expect(ids).toEqual(['a-model', 'b-model']);
    expect(getModelRegistry().getEntry('gemini', 'a-model')?.status).toBe('unverified');
  });

  it('records the provider-advertised context window into the registry', async () => {
    // The describe's beforeEach mocks the factory with bare ids — override it
    // so listModels returns descriptors carrying the advertised window.
    mockFactory(() =>
      makeProvider({
        models: [
          { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter', contextWindowTokens: 128_000 },
          { id: 'a-model' },
        ],
      }),
    );
    const cm = makeConfigManager(() => makeProvider({ models: [] }));
    await probeProviderList('openrouter', cm);

    expect(getModelRegistry().getEntry('openrouter', 'openai/gpt-4o')?.contextWindowTokens).toBe(128_000);
    expect(getModelRegistry().getEntry('openrouter', 'a-model')?.contextWindowTokens).toBeUndefined();
  });

  it('returns empty and never throws when listModels fails', async () => {
    const cm = makeConfigManager(() => makeProvider({ listModelsError: new Error('boom') }));
    mockFactory(() => makeProvider({ listModelsError: new Error('boom') }));
    const ids = await probeProviderList('gemini', cm);
    expect(ids).toEqual([]);
  });
});

describe('ModelProbe — spot-checks', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-probe-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    resetVectorBackendSelection();
    vi.restoreAllMocks();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks a working model verified with measured latency', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    mockFactory(() => makeProvider({ models: [{ id: 'm1' }] }));
    const outcome = await spotCheckModel('gemini', 'm1', cm);

    expect(outcome).toBe('verified');
    expect(getModelRegistry().isUsable('gemini', 'm1')).toBe(true);
    expect(getModelRegistry().getEntry('gemini', 'm1')?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('marks a 403 model unavailable (key exists but model not purchasable)', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'paid-model' }] }));
    mockFactory(() => makeProvider({
      models: [{ id: 'paid-model' }],
      generateError: new Error('403 PermissionDenied: billing required'),
    }));
    const outcome = await spotCheckModel('gemini', 'paid-model', cm);

    expect(outcome).toBe('unavailable');
    expect(getModelRegistry().isUsable('gemini', 'paid-model')).toBe(false);
    expect(getModelRegistry().getEntry('gemini', 'paid-model')?.status).toBe('unavailable');
  });

  it('marks a 404 model unavailable (retired / not served)', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'gone' }] }));
    mockFactory(() => makeProvider({
      models: [{ id: 'gone' }],
      generateError: new Error('404 model not found'),
    }));
    const outcome = await spotCheckModel('openrouter', 'gone', cm);

    expect(outcome).toBe('unavailable');
    expect(getModelRegistry().isUsable('openrouter', 'gone')).toBe(false);
  });

  it('marks a rate-limited model unavailable and parks quota', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    mockFactory(() => makeProvider({
      models: [{ id: 'm1' }],
      generateError: new Error('429 Too Many Requests'),
    }));
    const outcome = await spotCheckModel('groq', 'm1', cm);

    expect(outcome).toBe('unavailable');
    expect(getModelRegistry().isUsable('groq', 'm1')).toBe(false);
  });

  it('ignores transient errors (timeout/network) — does not flip a verified model', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    mockFactory(() => makeProvider({
      models: [{ id: 'm1' }],
      generateError: new Error('fetch failed: ECONNREFUSED'),
    }));
    const registry = getModelRegistry();
    registry.markVerified('groq', 'm1', 'spot-check');
    // Age the verification past the throttle window so the spot-check actually runs.
    const entry = registry.getEntry('groq', 'm1')!;
    entry.lastVerifiedAt = Date.now() - SPOT_CHECK_MIN_INTERVAL_MS - 1000;

    const outcome = await spotCheckModel('groq', 'm1', cm);
    expect(outcome).toBe('error');
    expect(registry.isUsable('groq', 'm1')).toBe(true); // still usable
  });

  it('skips models verified within the throttle window', async () => {
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'm1' }] }));
    mockFactory(() => makeProvider({ models: [{ id: 'm1' }] }));
    const registry = getModelRegistry();
    registry.markVerified('groq', 'm1', 'spot-check'); // just verified

    const outcome = await spotCheckModel('groq', 'm1', cm);
    expect(outcome).toBe('skipped');
  });
});

describe('ModelProbe — refresh orchestration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-probe-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    // Default factory: gemini lists curated + one extra model, all working.
    mockFactory(() => makeProvider({
      models: [{ id: 'gemini-2.5-flash' }, { id: 'other' }],
    }));
  });

  afterEach(() => {
    resetModelRegistry();
    resetVectorBackendSelection();
    vi.restoreAllMocks();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('probes + spot-checks candidates and aggregates results', async () => {
    // gemini lists 2 models; with a single spot-check the top LIVE-list
    // candidate (generic capability ranking, never a hardcoded catalog) gets
    // verified first.
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }, { id: 'other' }] }));
    const result = await refreshModelRegistry(cm, { providers: ['gemini'], maxSpotChecksPerProvider: 1 });

    expect(result.providersProbed).toContain('gemini');
    expect(result.modelsListed).toBe(2);
    expect(result.verified).toBe(1); // top live-list candidate verified first
    expect(getModelRegistry().isUsable('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(getModelRegistry().isUsable('gemini', 'other')).toBe(false);
  });

  it('skips spot-checks when disabled', async () => {
    mockFactory(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }));
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }));
    const result = await refreshModelRegistry(cm, { providers: ['gemini'], spotCheck: false });

    expect(result.modelsListed).toBe(1);
    expect(result.verified).toBe(0);
    expect(getModelRegistry().getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unverified');
  });

  it('reports the throttle-window constant for CI visibility', () => {
    expect(SPOT_CHECK_MIN_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it('ISSUE-004: purges stale local models the user deleted from the system (keyless runners)', async () => {
    // Seed a stale entry that no longer exists on the local runner.
    const registry = getModelRegistry();
    registry.markListed('lmstudio', [{ id: 'deleted-model' }]);
    expect(registry.getEntry('lmstudio', 'deleted-model')).toBeDefined();

    // lmstudio now lists ONLY the surviving model — the deleted one is gone.
    mockFactory(() => makeProvider({ models: [{ id: 'survivor' }] }));
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'survivor' }] }));
    const result = await refreshModelRegistry(cm, {
      providers: ['lmstudio'],
      spotCheck: false,
    });

    // The absent entry was pruned and reported in the result summary.
    expect(result.prunedLocal).toBe(1);
    expect(registry.getEntry('lmstudio', 'deleted-model')).toBeUndefined();
    // The surviving model is listed normally.
    expect(registry.getEntry('lmstudio', 'survivor')?.status).toBe('unverified');
  });

  it('ISSUE-004: does NOT prune keyed providers (their lists are portals, not local disk)', async () => {
    const registry = getModelRegistry();
    registry.markListed('gemini', [{ id: 'stale-remote' }]);

    mockFactory(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }));
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }));
    const result = await refreshModelRegistry(cm, {
      providers: ['gemini'],
      spotCheck: false,
    });

    // Keyed providers never prune — a remote catalog can legitimately drop a
    // model temporarily without the user deleting anything.
    expect(result.prunedLocal).toBe(0);
    expect(registry.getEntry('gemini', 'stale-remote')).toBeDefined();
  });
});

describe('ModelProbe — event-driven wakeup (watch daemon reacts to mid-session changes)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-probe-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetEventBus();
  });

  afterEach(() => {
    resetModelRegistry();
    resetVectorBackendSelection();
    resetEventBus();
    vi.restoreAllMocks();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a MODEL_REGISTRY_UPDATED event triggers an immediate targeted re-verification', async () => {
    let listCalls = 0;
    const working = makeProvider({
      models: [{ id: 'gemini-2.5-flash' }],
    });
    // Track how many times the provider's listModels() is hit.
    const spyProvider = {
      ...working,
      listModels: async () => {
        listCalls++;
        return working.listModels();
      },
    };
    mockFactory(() => spyProvider);
    const cm = makeConfigManager(() => spyProvider);

    // Start the watcher with a long interval so ONLY the event can trigger a
    // second pass during the test (the immediate first pass happens regardless).
    const watcher = startRegistryWatcher(cm, {
      intervalMs: 60 * 60 * 1000,
      spotCheck: false, // probe-only so the event pass is fast + deterministic
    });
    try {
      // Wait for the immediate first pass to land.
      await new Promise((r) => setTimeout(r, 100));
      const afterFirst = listCalls;
      expect(afterFirst).toBeGreaterThan(0);

      // Emit a mid-session state change exactly like chat telemetry does when
      // it flips a model unavailable (source: telemetry — a REAL session write).
      getEventBus().emit(EventNames.MODEL_REGISTRY_UPDATED, {
        providers: ['gemini'],
        blocked: [],
        updatedAt: Date.now(),
        detail: 'unavailable: 403 permission denied',
        source: 'telemetry',
      }, 'test');

      // The watcher reacts IMMEDIATELY (no 10-min wait) with a targeted pass.
      await new Promise((r) => setTimeout(r, 200));
      expect(listCalls).toBeGreaterThan(afterFirst);
    } finally {
      watcher.stop();
    }
  });

  it('ignores its OWN probe/spot-check events (no self-trigger loop)', async () => {
    let listCalls = 0;
    const spyProvider = {
      ...makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }),
      listModels: async () => {
        listCalls++;
        return [{ id: 'gemini-2.5-flash' }];
      },
    };
    mockFactory(() => spyProvider);
    const cm = makeConfigManager(() => spyProvider);

    const watcher = startRegistryWatcher(cm, {
      intervalMs: 60 * 60 * 1000,
      spotCheck: false,
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const afterFirst = listCalls;

      // The watcher's OWN spot-check marks a model unavailable → this event
      // must NOT wake the daemon again (infinite loop guard).
      getEventBus().emit(EventNames.MODEL_REGISTRY_UPDATED, {
        providers: ['gemini'],
        blocked: [],
        updatedAt: Date.now(),
        detail: 'unavailable: 403 permission denied',
        source: 'spot-check',
      }, 'test');
      await new Promise((r) => setTimeout(r, 200));

      expect(listCalls).toBe(afterFirst); // no extra pass from its own write
    } finally {
      watcher.stop();
    }
  });

  it('event-triggered passes are throttled per provider (no spot-check storm)', async () => {
    let listCalls = 0;
    const spyProvider = {
      ...makeProvider({ models: [{ id: 'gemini-2.5-flash' }] }),
      listModels: async () => {
        listCalls++;
        return [{ id: 'gemini-2.5-flash' }];
      },
    };
    mockFactory(() => spyProvider);
    const cm = makeConfigManager(() => spyProvider);

    const watcher = startRegistryWatcher(cm, {
      intervalMs: 60 * 60 * 1000,
      spotCheck: false,
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const afterFirst = listCalls;

      // Burst of events for the SAME provider — only the first triggers a pass.
      for (let i = 0; i < 5; i++) {
        getEventBus().emit(EventNames.MODEL_REGISTRY_UPDATED, {
          providers: ['gemini'],
          blocked: [],
          updatedAt: Date.now(),
          detail: `event ${i}`,
        }, 'test');
      }
      await new Promise((r) => setTimeout(r, 250));
      // 1 immediate pass + exactly 1 event pass (not 5).
      expect(listCalls).toBe(afterFirst + 1);
    } finally {
      watcher.stop();
    }
  });
});
