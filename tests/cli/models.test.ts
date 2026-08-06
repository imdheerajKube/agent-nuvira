/**
 * ModelsCommand — Unit tests for `buff models --json`.
 *
 * The command lists models from providers and renders a human table by
 * default. These tests mock the provider layer (resolveProvider + plugin
 * registry) and verify the machine-readable JSON mode that the VS Code
 * extension relies on:
 * 1. JSON output shape (models array with provider/providerType/name/id)
 * 2. providerType matches the provider passed via -p (needed for switching)
 * 3. -p restricts output to the requested provider
 * 4. JSON mode stays pure (no human decoration on stdout)
 * 5. -s search filter applies in JSON mode too
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferenceProvider, ModelDescriptor } from '../../src/inference/interface.js';
import type { ProviderType } from '../../src/config/types.js';

// ─── Mock helpers ───────────────────────────────────────────────────────────

/** Create a mock InferenceProvider with controllable behaviour */
function createMockProvider(overrides: Partial<InferenceProvider> = {}): InferenceProvider {
  return {
    name: overrides.name || 'MockProvider',
    isAvailable: overrides.isAvailable || vi.fn().mockResolvedValue(true),
    generate: overrides.generate || vi.fn(),
    generateStream: overrides.generateStream as any || undefined,
    listModels: overrides.listModels || vi.fn().mockResolvedValue([]),
    getInfo: overrides.getInfo || vi.fn().mockReturnValue('Mock info'),
  } as InferenceProvider;
}

/** Create a mock ModelDescriptor */
function makeModel(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    name: overrides.name || id,
    provider: overrides.provider || 'groq',
    owner: overrides.owner,
    description: overrides.description,
    tags: overrides.tags || [],
    ...overrides,
  };
}

const PLUGIN_MOCK = vi.hoisted(() => ({
  getAllPlugins: vi.fn().mockReturnValue([]),
  hasPlugin: vi.fn().mockReturnValue(false),
  getPlugin: vi.fn().mockReturnValue(undefined),
  register: vi.fn(),
  unregister: vi.fn(),
  createProviderFromPlugin: vi.fn(),
  listPlugins: vi.fn().mockReturnValue([]),
}));

// vi.hoisted ensures the Map is initialized before vi.mock's hoisted factory runs
const mockResolveResults = vi.hoisted(() => new Map<string, { type: string; provider: InferenceProvider }>());

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_configManager: any, providerType: string) => {
    const result = mockResolveResults.get(providerType);
    if (!result) {
      return {
        type: providerType,
        provider: createMockProvider({
          name: providerType,
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      };
    }
    return result;
  }),
}));

vi.mock('../../src/plugins/registry.js', () => ({
  getPluginRegistry: vi.fn(() => PLUGIN_MOCK),
}));

// The unblock subcommand re-probes against the live API via
// refreshModelRegistry — mock it so the CLI test is hermetic (no network).
const mockRefreshRegistry = vi.hoisted(() => ({
  refreshModelRegistry: vi.fn(),
}));

vi.mock('../../src/inference/model-probe.js', () => ({
  refreshModelRegistry: mockRefreshRegistry.refreshModelRegistry,
  startRegistryWatcher: vi.fn(() => ({ stop: vi.fn(), runOnce: vi.fn() })),
  PROBE_PROVIDERS: ['local', 'groq', 'gemini', 'nim', 'openrouter'],
}));

// ─── Test helpers ───────────────────────────────────────────────────────────

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Run `buff models ...` and return everything written to stdout via console.log. */
async function runModels(args: string[]): Promise<string> {
  const { ModelsCommand } = await import('../../src/cli/models.js');
  const cmd = new ModelsCommand();
  (cmd as any).configManager = { getAll: vi.fn(() => ({})), getProviderConfig: vi.fn() };
  await cmd.create().parseAsync(['node', 'buff', 'models', ...args]);
  return vi.mocked(console.log).mock.calls
    .map((c) => c.map((v) => String(v)).join(' '))
    .join('\n');
}

// ─── Shared mock state ──────────────────────────────────────────────────────

const GROQ_MODELS = [
  makeModel('llama-3.3-70b-versatile', { provider: 'groq', description: 'High quality' }),
  makeModel('llama-3.1-8b-instant', { provider: 'groq' }),
  makeModel('mixtral-8x7b-32768', { provider: 'groq', owner: 'Mistral AI' }),
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ModelsCommand --json', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockResolveResults.clear();
    PLUGIN_MOCK.getAllPlugins.mockReturnValue([]);
    muteConsole();

    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue(GROQ_MODELS),
      }),
    });
    mockResolveResults.set('openrouter', {
      type: 'openrouter',
      provider: createMockProvider({
        name: 'OpenRouter',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockResolvedValue([
          makeModel('meta-llama/llama-3.1-8b-instruct', { provider: 'openrouter', name: 'Llama 3.1 8B' }),
        ]),
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs a parseable JSON object with a models array', async () => {
    const output = await runModels(['--json', '-p', 'groq']);
    const parsed = JSON.parse(output) as { models: any[] };

    expect(Array.isArray(parsed.models)).toBe(true);
    expect(parsed.models).toHaveLength(3);
    expect(parsed.models[0].id).toBe('llama-3.3-70b-versatile');
    expect(parsed.models[0].name).toBe('llama-3.3-70b-versatile');
    expect(parsed.models[2].owner).toBe('Mistral AI');
    expect(parsed.models[0].description).toBe('High quality');
  });

  it('includes providerType so consumers can switch to a specific model', async () => {
    const output = await runModels(['--json', '-p', 'groq']);
    const parsed = JSON.parse(output) as { models: any[] };

    for (const m of parsed.models) {
      expect(m.providerType).toBe('groq');
      expect(m.provider).toBe('Groq');
    }
  });

  it('respects -p and only lists the requested provider', async () => {
    const output = await runModels(['--json', '-p', 'groq']);
    const parsed = JSON.parse(output) as { models: any[] };

    expect(parsed.models.every((m) => m.providerType === 'groq')).toBe(true);
    expect(parsed.models.some((m) => m.id.includes('llama'))).toBe(true);
  });

  it('keeps stdout pure JSON (no human decoration)', async () => {
    const output = await runModels(['--json', '-p', 'groq']);
    // The whole stdout must be a single parseable JSON document
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output.trim().startsWith('{')).toBe(true);
    expect(output).not.toContain('Available Models');
    expect(output).not.toContain('models found');
  });

  it('applies the -s search filter in JSON mode', async () => {
    const output = await runModels(['--json', '-p', 'groq', '-s', 'mixtral']);
    const parsed = JSON.parse(output) as { models: any[] };

    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].id).toBe('mixtral-8x7b-32768');
  });

  it('returns an empty models array when the provider is not configured', async () => {
    mockResolveResults.set('gemini', {
      type: 'gemini',
      provider: createMockProvider({
        name: 'Google Gemini',
        isAvailable: vi.fn().mockResolvedValue(false),
        listModels: vi.fn().mockResolvedValue([]),
      }),
    });

    const output = await runModels(['--json', '-p', 'gemini']);
    const parsed = JSON.parse(output) as { models: any[] };

    expect(parsed.models).toEqual([]);
  });

  it('skips a provider whose model fetch throws', async () => {
    mockResolveResults.set('groq', {
      type: 'groq',
      provider: createMockProvider({
        name: 'Groq',
        isAvailable: vi.fn().mockResolvedValue(true),
        listModels: vi.fn().mockRejectedValue(new Error('API rate limited')),
      }),
    });

    const output = await runModels(['--json', '-p', 'groq']);
    const parsed = JSON.parse(output) as { models: any[] };

    expect(parsed.models).toEqual([]);
  });
});

describe('ModelsCommand status --verbose', () => {
  let verboseTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockResolveResults.clear();
    PLUGIN_MOCK.getAllPlugins.mockReturnValue([]);
    muteConsole();
    // Hermetic registry storage — the verbose status reads/writes the
    // ModelRegistry singleton, which persists to BUFF_MEMORY_DIR.
    verboseTempDir = mkdtempSync(join(tmpdir(), 'buff-models-verbose-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = verboseTempDir;
    const { resetModelRegistry } = await import('../../src/learning/model-registry.js');
    resetModelRegistry();
  });

  afterEach(async () => {
    const { resetModelRegistry } = await import('../../src/learning/model-registry.js');
    resetModelRegistry();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(verboseTempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('verbose status shows registry-blocked providers and per-action telemetry', async () => {
    const { getModelRegistry } = await import('../../src/learning/model-registry.js');
    const registry = getModelRegistry();
    registry.markVerified('local', 'gemma4:e4b', 'spot-check');
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry', 0, 'execute');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', true, undefined, 'chat');

    // Parse through the production CLI shape — commander parses
    // parent-action + subcommand options correctly only when `models` is a
    // child of a root program (the exact production tree). router.js is mocked
    // in this file, so build the root program directly.
    const { Command } = await import('commander');
    const { ModelsCommand } = await import('../../src/cli/models.js');
    const cli = new Command();
    cli.addCommand(new ModelsCommand().create());
    cli.exitOverride();

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cli.parseAsync(['node', 'buff', 'models', 'status', '--verbose']);
    const output = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    spy.mockRestore();

    expect(output).toContain('Registry-blocked providers');
    expect(output).toContain('gemini');
    expect(output).toContain('auth');
    expect(output).toContain('Learned from real usage');
    expect(output).toContain('execute');
    expect(output).toContain('killed');
    expect(output).toContain('chat');
    expect(output).toContain('verified');
  });
});

describe('ModelsCommand unblock — manual escape hatch', () => {
  let unblockTempDir: string;
  let originalMemoryDir: string | undefined;
  let configManager: any;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockResolveResults.clear();
    PLUGIN_MOCK.getAllPlugins.mockReturnValue([]);
    muteConsole();
    // Hermetic registry + ledger storage.
    unblockTempDir = mkdtempSync(join(tmpdir(), 'buff-models-unblock-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = unblockTempDir;
    const { resetModelRegistry } = await import('../../src/learning/model-registry.js');
    const { resetQuotaLedger } = await import('../../src/learning/quota-ledger.js');
    resetModelRegistry();
    resetQuotaLedger();
    mockRefreshRegistry.refreshModelRegistry.mockReset();
    mockRefreshRegistry.refreshModelRegistry.mockResolvedValue({
      providersProbed: ['gemini'],
      modelsListed: 2,
      verified: 1,
      unavailable: 0,
      skipped: 0,
      errors: 0,
    });
    configManager = { getAll: vi.fn(() => ({})), getProviderConfig: vi.fn(() => ({ config: {} })) };
  });

  afterEach(async () => {
    const { resetModelRegistry } = await import('../../src/learning/model-registry.js');
    const { resetQuotaLedger } = await import('../../src/learning/quota-ledger.js');
    resetModelRegistry();
    resetQuotaLedger();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(unblockTempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Parse through the production CLI shape (root program → models child). */
  async function runUnblock(args: string[]): Promise<string> {
    const { Command } = await import('commander');
    const { ModelsCommand } = await import('../../src/cli/models.js');
    const cmd = new ModelsCommand();
    (cmd as any).configManager = configManager;
    const cli = new Command();
    cli.addCommand(cmd.create());
    cli.exitOverride();
    await cli.parseAsync(['node', 'buff', 'models', ...args]);
    return vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('unblocks a registry-blocked provider and re-probes it against the live API', async () => {
    const { getModelRegistry } = await import('../../src/learning/model-registry.js');
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    expect(registry.getBlockedProviders()).toContain('gemini');

    await runUnblock(['unblock', 'gemini']);

    // Provider is released from the predictive skip…
    expect(registry.getBlockedProviders()).not.toContain('gemini');
    expect(registry.getEntry('gemini', 'gemini-2.5-flash')?.status).toBe('unverified');
    // …and re-probed against the live API (spot-check enabled by default).
    expect(mockRefreshRegistry.refreshModelRegistry).toHaveBeenCalledWith(
      configManager,
      expect.objectContaining({ providers: ['gemini'], spotCheck: true }),
    );
  });

  it('clears the central ledger cooldown so syncQuota cannot instantly re-park', async () => {
    const { getQuotaLedger } = await import('../../src/learning/quota-ledger.js');
    const ledger = getQuotaLedger();
    ledger.parkProvider('gemini', Date.now() + 3600_000, 'rate-limit');
    expect(ledger.getRouterQuotaStatus()).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: 'gemini' })]),
    );

    await runUnblock(['unblock', 'gemini']);

    expect(ledger.getRouterQuotaStatus()).toEqual([]);
  });

  it('reports wasBlocked / demoted / unparked in --json output', async () => {
    const { getModelRegistry } = await import('../../src/learning/model-registry.js');
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    registry.recordCall('groq', 'llama-3.3-70b-versatile', false, 'rate-limit');

    const output = await runUnblock(['unblock', 'gemini', '--json']);
    const parsed = JSON.parse(output);
    expect(parsed.wasBlocked).toBe(true);
    expect(parsed.demoted).toBe(1);
    expect(parsed.unparked).toBe(0);
    expect(parsed.provider).toBe('gemini');
    expect(parsed.stillBlocked).toBe(false);
    expect(parsed.probe.verified).toBe(1);
  });

  it('is a harmless no-op for a provider that was never tracked', async () => {
    const output = await runUnblock(['unblock', 'openrouter', '--json']);
    const parsed = JSON.parse(output);
    expect(parsed.wasBlocked).toBe(false);
    expect(parsed.demoted).toBe(0);
    expect(parsed.unparked).toBe(0);
    expect(mockRefreshRegistry.refreshModelRegistry).toHaveBeenCalledWith(
      configManager,
      expect.objectContaining({ providers: ['openrouter'] }),
    );
  });

  it('refuses to unblock when routing.governance.allowUnblock is false (M2.4 admin hard-deny)', async () => {
    const { getModelRegistry } = await import('../../src/learning/model-registry.js');
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    expect(registry.getBlockedProviders()).toContain('gemini');
    // Admin policy hard-denies the escape hatch.
    configManager.getAll = vi.fn(() => ({ routing: { governance: { allowUnblock: false } } }));

    const output = await runUnblock(['unblock', 'gemini']);

    // The provider stays blocked AND no re-probe happened (the command bailed).
    expect(registry.getBlockedProviders()).toContain('gemini');
    expect(mockRefreshRegistry.refreshModelRegistry).not.toHaveBeenCalled();
    expect(output).toContain('allowUnblock');
  });

  it('still unblocks when allowUnblock is true or unset (default escape hatch)', async () => {
    const { getModelRegistry } = await import('../../src/learning/model-registry.js');
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    configManager.getAll = vi.fn(() => ({ routing: { governance: { allowUnblock: true } } }));

    await runUnblock(['unblock', 'gemini']);

    expect(registry.getBlockedProviders()).not.toContain('gemini');
    expect(mockRefreshRegistry.refreshModelRegistry).toHaveBeenCalledWith(
      configManager,
      expect.objectContaining({ providers: ['gemini'] }),
    );
  });
});
