import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../../src/inference/factory.js';
import { NIMAdapter } from '../../src/inference/nim-adapter.js';
import { GeminiAdapter } from '../../src/inference/gemini-adapter.js';
import { OpenRouterAdapter } from '../../src/inference/openrouter-adapter.js';
import { LocalAdapter } from '../../src/inference/local-adapter.js';

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

    it('should throw for unknown provider type', () => {
      expect(() => ProviderFactory.createProvider('unknown' as any, emptyConfig)).toThrow(
        'Unknown provider type: unknown'
      );
    });

    it('should pass configuration to the created provider', () => {
      const config = { apiKey: 'test-key', model: 'test-model' };
      const provider = ProviderFactory.createProvider('nim', config);

      // The info should contain the model we passed
      expect(provider.getInfo()).toContain('test-model');
    });
  });
});
