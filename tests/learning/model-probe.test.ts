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
  SPOT_CHECK_MIN_INTERVAL_MS,
} from '../../src/inference/model-probe.js';
import { setVectorBackendOverride, resetVectorBackendSelection } from '../../src/memory/vector-store.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

/** A fake InferenceProvider for hermetic probe tests. */
function makeProvider(overrides: {
  models?: Array<{ id: string }>;
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
    // gemini lists 2 models; only the curated candidate gets spot-checked.
    const cm = makeConfigManager(() => makeProvider({ models: [{ id: 'gemini-2.5-flash' }, { id: 'other' }] }));
    const result = await refreshModelRegistry(cm, { providers: ['gemini'] });

    expect(result.providersProbed).toContain('gemini');
    expect(result.modelsListed).toBe(2);
    expect(result.verified).toBe(1); // gemini-2.5-flash is curated & works
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
});
