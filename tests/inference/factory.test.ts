import { describe, it, expect, vi } from 'vitest';
import { ProviderFactory } from '../../src/inference/factory.js';
import { NIMAdapter } from '../../src/inference/nim-adapter.js';
import { GeminiAdapter } from '../../src/inference/gemini-adapter.js';
import { OpenRouterAdapter } from '../../src/inference/openrouter-adapter.js';
import { GroqAdapter } from '../../src/inference/groq-adapter.js';
import { LocalAdapter } from '../../src/inference/local-adapter.js';
import { NuviraAdapter } from '../../src/inference/nuvira-adapter.js';
import { OpenAICompatAdapter } from '../../src/inference/openai-compat-adapter.js';
import { AnthropicAdapter } from '../../src/inference/anthropic-adapter.js';
import { getPluginRegistry } from '../../src/plugins/registry.js';

describe('ProviderFactory', () => {
  const emptyConfig = {};

  describe('createProvider', () => {
    it('should create NIMAdapter for nim type', () => {
      const provider = ProviderFactory.createProvider('nim', emptyConfig);
      expect(provider).toBeInstanceOf(NIMAdapter);
      expect(provider.name).toBe('NVIDIA NIM');
    });

    it('should create GeminiAdapter for gemini type', () => {
      const provider = ProviderFactory.createProvider('gemini', emptyConfig);
      expect(provider).toBeInstanceOf(GeminiAdapter);
      expect(provider.name).toBe('Google Gemini');
    });

    it('should create OpenRouterAdapter for openrouter type', () => {
      const provider = ProviderFactory.createProvider('openrouter', emptyConfig);
      expect(provider).toBeInstanceOf(OpenRouterAdapter);
      expect(provider.name).toBe('OpenRouter');
    });

    it('should create LocalAdapter for local type', () => {
      const provider = ProviderFactory.createProvider('local', emptyConfig);
      expect(provider).toBeInstanceOf(LocalAdapter);
      expect(provider.name).toBe('Local');
    });

    it('should create NuviraAdapter for nuvira type', () => {
      const provider = ProviderFactory.createProvider('nuvira', emptyConfig);
      expect(provider).toBeInstanceOf(NuviraAdapter);
      expect(provider.name).toBe('Nuvira Gateway');
    });

    it('should create GroqAdapter for groq type', () => {
      const provider = ProviderFactory.createProvider('groq', emptyConfig);
      expect(provider).toBeInstanceOf(GroqAdapter);
      expect(provider.name).toBe('Groq');
    });

    // ── Issue 001: the extended catalog is served by the generic adapters ──

    it('should create OpenAICompatAdapter for extended OpenAI-compatible providers (openai)', () => {
      const provider = ProviderFactory.createProvider('openai', emptyConfig);
      expect(provider).toBeInstanceOf(OpenAICompatAdapter);
      expect(provider.name).toBe('OpenAI');
    });

    it('should create OpenAICompatAdapter for every catalog OpenAI-compatible provider', () => {
      for (const type of ['mistral', 'cohere', 'together', 'deepinfra', 'fireworks', 'perplexity', 'azure', 'lmstudio', 'anyscale', 'vllm', 'deepseek', 'xai', 'replicate']) {
        const provider = ProviderFactory.createProvider(type, emptyConfig);
        expect(provider).toBeInstanceOf(OpenAICompatAdapter);
      }
    });

    it('should create AnthropicAdapter for the native anthropic type', () => {
      const provider = ProviderFactory.createProvider('anthropic', emptyConfig);
      expect(provider).toBeInstanceOf(AnthropicAdapter);
      expect(provider.name).toBe('Anthropic');
    });

    it('should use the azure api-key header + api-version query from the catalog', () => {
      const provider = ProviderFactory.createProvider('azure', { apiKey: 'az-key' }) as OpenAICompatAdapter;
      expect(provider.getInfo()).toContain('Azure OpenAI');
      // The adapter applies the api-key header and api-version on requests —
      // exercise the request builder via a mocked fetch.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });
      vi.stubGlobal('fetch', fetchMock);
      return provider.generate('hi').then(() => {
        const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
        expect(String(url)).toContain('api-version=');
        expect(init.headers['api-key']).toBe('az-key');
        expect(init.headers['Authorization']).toBeUndefined();
        vi.unstubAllGlobals();
      });
    });

    it('should throw for unknown provider type', () => {
      expect(() => ProviderFactory.createProvider('unknown' as any, emptyConfig)).toThrow(
        'Unknown provider type'
      );
    });

    it('should create provider from registered plugin', () => {
      const registry = getPluginRegistry();
      registry.unregister('custom');
      const createProviderMock = vi.fn().mockReturnValue({ name: 'Custom Provider' });
      const plugin = {
        metadata: { name: 'Custom', version: '1.0.0', description: 'A custom provider' },
        getProviderType: () => 'custom',
        createProvider: createProviderMock,
      };
      registry.register(plugin as any);

      const provider = ProviderFactory.createProvider('custom', { apiKey: 'key' });
      expect(provider).toEqual({ name: 'Custom Provider' });
      expect(createProviderMock).toHaveBeenCalledWith({ apiKey: 'key' });
    });

    it('should pass configuration to the created provider', () => {
      const config = { apiKey: 'test-key', model: 'test-model' };
      const provider = ProviderFactory.createProvider('nim', config);

      // The info should contain the model we passed
      expect(provider.getInfo()).toContain('test-model');
    });
  });
});
