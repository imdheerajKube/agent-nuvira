/**
 * ProviderCommand — Unit tests for buff provider list/health.
 *
 * Covers:
 * 1. provider list — all providers available
 * 2. provider list — some providers unavailable
 * 3. provider list — no API keys configured
 * 4. provider list — with plugin providers
 * 5. provider list — provider instantiation error
 * 6. provider health — all providers healthy
 * 7. provider health — specific provider
 * 8. provider health — provider with no API key
 * 9. provider health — provider endpoint unreachable
 * 10. provider health — verbose mode with model listing
 * 11. provider health — verbose mode with model list error
 * 12. provider health — provider instantiation error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { logger } from '../../src/utils/logger.js';
import type { InferenceProvider, ModelDescriptor } from '../../src/inference/interface.js';
import type { ProviderType } from '../../src/config/types.js';
import type { ProviderConfig, BuffConfig } from '../../src/config/types.js';

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
const mockResolveResults = vi.hoisted(() => new Map<string, { type: ProviderType; provider: InferenceProvider }>());

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_configManager: any, providerType: string) => {
    const result = mockResolveResults.get(providerType);
    if (!result) {
      return {
        type: providerType as ProviderType,
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

// ─── Test helpers ───────────────────────────────────────────────────────────

function muteConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Provider config factory — returns a deep-cloneable provider config */
function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    model: 'test-model',
    temperature: 0.7,
    maxTokens: 4096,
    apiKey: 'test-key-12345',
    ...overrides,
  };
}

/** Full config factory */
function makeBuffConfig(overrides: Partial<BuffConfig> = {}): BuffConfig {
  return {
    defaultProvider: 'groq',
    providers: {
      local: { model: 'llama2', temperature: 0.7, maxTokens: 4096 },
      groq: makeProviderConfig({ model: 'llama-3.3-70b-versatile', apiKey: 'gsk_test_key_1234567890', provider: 'groq' as any }),
      nim: makeProviderConfig({ model: 'meta/llama-3.1-8b-instruct', apiKey: 'nvapi-test-key', provider: 'nim' as any }),
      gemini: makeProviderConfig({ model: 'gemini-2.0-flash-exp', apiKey: 'gemini-test-key', provider: 'gemini' as any }),
      openrouter: makeProviderConfig({ model: 'mistralai/mistral-7b-instruct', apiKey: 'openrouter-test-key', provider: 'openrouter' as any }),
      ...(overrides.providers || {}),
    },
    history: { retentionDays: 30, semanticSearch: true },
    ...overrides,
  };
}

/**
 * Create a fresh ProviderCommand and parse args against it.
 * Uses Commander's parseAsync which takes the full arg list.
 */
async function runProvider(args: string[]): Promise<void> {
  const { ProviderCommand } = await import('../../src/cli/provider.js');
  const cmd = new ProviderCommand();
  const command = cmd.create();
  // Override the configManager to return controlled data
  (cmd as any).configManager = {
    hasRequiredCredentials: vi.fn((pt: string) => {
      if (pt === 'local') return true;
      return mockApiKeyPresence[pt] ?? false;
    }),
    getProviderConfig: vi.fn((pt: string) => ({
      type: pt,
      config: mockConfigs[pt] || makeProviderConfig({ model: undefined }),
    })),
    getAll: vi.fn(() => mockFullConfig),
  };
  // Note: parseAsync on a subcommand doesn't expect the command name itself
  await command.parseAsync(['node', 'buff', ...args]);
}

// ─── Shared mock state ──────────────────────────────────────────────────────

let mockApiKeyPresence: Record<string, boolean> = {};
let mockConfigs: Record<string, ProviderConfig> = {};
let mockFullConfig: BuffConfig = makeBuffConfig();

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ProviderCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockResolveResults.clear();
    PLUGIN_MOCK.getAllPlugins.mockReturnValue([]);
    muteConsole();

    // Default: all providers with keys and available
    mockApiKeyPresence = {
      groq: true,
      nim: true,
      gemini: true,
      openrouter: true,
    };
    mockFullConfig = makeBuffConfig();
    mockConfigs = {
      groq: { model: 'llama-3.3-70b-versatile', apiKey: 'gsk_test_key' },
      nim: { model: 'meta/llama-3.1-8b-instruct', apiKey: 'nvapi_test_key' },
      gemini: { model: 'gemini-2.0-flash-exp', apiKey: 'gemini_test_key' },
      openrouter: { model: 'mistralai/mistral-7b-instruct', apiKey: 'openrouter_test_key' },
      local: { model: 'llama2' },
    };

    // Default: all providers available
    for (const pt of ['local', 'groq', 'nim', 'gemini', 'openrouter']) {
      mockResolveResults.set(pt, {
        type: pt as ProviderType,
        provider: createMockProvider({
          name: pt === 'local' ? 'Local' : pt.charAt(0).toUpperCase() + pt.slice(1),
          isAvailable: vi.fn().mockResolvedValue(true),
          listModels: vi.fn().mockResolvedValue([
            makeModel(mockConfigs[pt]?.model || 'test-model', { provider: pt }),
          ]),
        }),
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── provider list ─────────────────────────────────────────────────────

  describe('provider list', () => {
    it('should list all 5 built-in providers with available status', async () => {
      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runProvider(['list']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Provider Status'));
      // Verify all providers were logged
      for (const label of ['Local', 'Groq', 'NVIDIA', 'Gemini', 'OpenRouter']) {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(label));
      }
    });

    it('should show summary counts when all providers available', async () => {
      await runProvider(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('✅ 5 available')
      );
    });

    it('should show unreachable status when some providers fail', async () => {
      // Make groq and nim unavailable but configured
      mockResolveResults.set('groq', {
        type: 'groq',
        provider: createMockProvider({
          name: 'Groq',
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });
      mockResolveResults.set('nim', {
        type: 'nim',
        provider: createMockProvider({
          name: 'NVIDIA NIM',
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });

      await runProvider(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('⚠️  2 unreachable')
      );
    });

    it('should show not configured status when providers have no API key', async () => {
      // Remove API keys for groq and openrouter
      mockApiKeyPresence.groq = false;
      mockApiKeyPresence.openrouter = false;

      await runProvider(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('❌ 2 not configured')
      );
    });

    it('should display error line for configured but failed providers', async () => {
      // Make groq throw during resolve
      mockResolveResults.set('groq', {
        type: 'groq',
        provider: createMockProvider({
          name: 'Groq',
          isAvailable: vi.fn().mockRejectedValue(new Error('Connection refused')),
        }),
      });

      await runProvider(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Error')
      );
    });

    it('should include plugin providers when discovered', async () => {
      PLUGIN_MOCK.getAllPlugins.mockReturnValue([
        {
          metadata: { name: 'Custom AI', version: '1.0.0', description: 'Custom provider' },
          getProviderType: () => 'custom-ai',
          createProvider: vi.fn(),
        },
      ]);
      mockResolveResults.set('custom-ai', {
        type: 'custom-ai' as ProviderType,
        provider: createMockProvider({
          name: 'Custom AI',
          isAvailable: vi.fn().mockResolvedValue(true),
        }),
      });
      mockApiKeyPresence['custom-ai'] = true;

      await runProvider(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('custom-ai')
      );
    });

    it('should include providers with no config when --all is set', async () => {
      // Remove all API keys
      mockApiKeyPresence.groq = false;
      mockApiKeyPresence.nim = false;
      mockApiKeyPresence.gemini = false;
      mockApiKeyPresence.openrouter = false;

      await runProvider(['list', '--all']);

      // Should still show local (always available) + 4 cloud providers
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Not configured')
      );
    });
  });

  // ── provider health ────────────────────────────────────────────────────

  describe('provider health', () => {
    it('should show all providers healthy when everything works', async () => {
      const highlightSpy = vi.spyOn(logger, 'highlight');

      await runProvider(['health']);

      expect(highlightSpy).toHaveBeenCalledWith(expect.stringContaining('Provider Health'));
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('All providers healthy')
      );
    });

    it('should check a specific provider when named', async () => {
      await runProvider(['health', 'groq']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Groq')
      );
      // Should NOT contain other provider names
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('NVIDIA')
      );
    });

    it('should show API key failure for provider without key', async () => {
      mockApiKeyPresence.groq = false;

      await runProvider(['health', 'groq']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Not configured')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('GROQ_API_KEY')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Some providers have issues')
      );
    });

    it('should show endpoint unreachable for available=false providers', async () => {
      mockResolveResults.set('groq', {
        type: 'groq',
        provider: createMockProvider({
          name: 'Groq',
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });

      await runProvider(['health', 'groq']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Not reachable')
      );
    });

    it('should list models in verbose mode', async () => {
      mockResolveResults.set('groq', {
        type: 'groq',
        provider: createMockProvider({
          name: 'Groq',
          isAvailable: vi.fn().mockResolvedValue(true),
          listModels: vi.fn().mockResolvedValue([
            makeModel('llama-3.3-70b-versatile', { provider: 'groq' }),
            makeModel('llama-3.1-8b-instant', { provider: 'groq' }),
            makeModel('mixtral-8x7b-32768', { provider: 'groq' }),
          ]),
        }),
      });

      await runProvider(['health', 'groq', '--verbose']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('llama-3.3-70b-versatile')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('mixtral-8x7b-32768')
      );
    });

    it('should handle model list error gracefully in verbose mode', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      mockResolveResults.set('groq', {
        type: 'groq',
        provider: createMockProvider({
          name: 'Groq',
          isAvailable: vi.fn().mockResolvedValue(true),
          listModels: vi.fn().mockRejectedValue(new Error('API rate limited')),
        }),
      });

      await runProvider(['health', 'groq', '--verbose']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Could not list')
      );
    });

    it('should handle provider instantiation error gracefully', async () => {
      const resolveProvider = (await import('../../src/cli/router.js')).resolveProvider;
      vi.mocked(resolveProvider).mockImplementationOnce(() => {
        throw new Error('Provider module not found');
      });

      await runProvider(['health', 'groq']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Provider module not found')
      );
    });

    it('should show module name for available providers', async () => {
      await runProvider(['health', 'groq']);

      // Module line shows the provider name
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Module')
      );
    });

    it('should show configured model name', async () => {
      await runProvider(['health', 'groq']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('llama-3.3-70b-versatile')
      );
    });

    it('should show locale provider as always healthy without API key', async () => {
      await runProvider(['health', 'local']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No key needed')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Reachable')
      );
    });

    it('should show fix suggestion for endpoint issues', async () => {
      mockResolveResults.set('local', {
        type: 'local',
        provider: createMockProvider({
          name: 'Local',
          isAvailable: vi.fn().mockResolvedValue(false),
        }),
      });

      await runProvider(['health', 'local']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('ollama serve')
      );
    });
  });
});
