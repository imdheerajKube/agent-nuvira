import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterAdapter } from '../../src/inference/openrouter-adapter.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenRouterAdapter', () => {
  const baseConfig = {
    apiKey: 'sk-or-v1-test-key',
    model: 'mistralai/mistral-7b-instruct',
    temperature: 0.7,
    maxTokens: 2048,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and name', () => {
    it('should have the correct name', () => {
      const adapter = new OpenRouterAdapter(baseConfig);
      expect(adapter.name).toBe('OpenRouter');
    });
  });

  describe('generate', () => {
    it('should successfully generate a response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Mistral response' } }],
        }),
      });

      const adapter = new OpenRouterAdapter(baseConfig);
      const result = await adapter.generate('Tell me about AI');

      expect(result).toBe('Mistral response');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify request URL
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('https://openrouter.ai/api/v1/chat/completions');

      // Verify headers
      const callOptions = mockFetch.mock.calls[0][1];
      expect(callOptions.headers['Authorization']).toBe('Bearer sk-or-v1-test-key');
      expect(callOptions.headers['HTTP-Referer']).toBe('https://github.com/buff-cli/buff');
      expect(callOptions.headers['X-Title']).toBe('Buff CLI');

      // Verify body
      const body = JSON.parse(callOptions.body);
      expect(body.model).toBe('mistralai/mistral-7b-instruct');
      expect(body.messages[0].content).toBe('Tell me about AI');
      expect(body.temperature).toBe(0.7);
    });

    it('should throw when API key is missing', async () => {
      const adapter = new OpenRouterAdapter({});
      await expect(adapter.generate('test')).rejects.toThrow(
        'OpenRouter API key is not configured'
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      const adapter = new OpenRouterAdapter(baseConfig);
      await expect(adapter.generate('test')).rejects.toThrow('OpenRouter API error (429): Rate limited');
    });

    it('should use different model from options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      const adapter = new OpenRouterAdapter(baseConfig);
      await adapter.generate('test', { model: 'openai/gpt-4o' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('openai/gpt-4o');
    });

    it('should handle empty choices', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [] }),
      });

      const adapter = new OpenRouterAdapter(baseConfig);
      const result = await adapter.generate('test');
      expect(result).toBe('');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is set', async () => {
      const adapter = new OpenRouterAdapter(baseConfig);
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const adapter = new OpenRouterAdapter({});
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('getInfo', () => {
    it('should show configured status', () => {
      const adapter = new OpenRouterAdapter(baseConfig);
      const info = adapter.getInfo();
      expect(info).toContain('OpenRouter');
      expect(info).toContain('✅ Configured');
    });

    it('should show missing key status', () => {
      const adapter = new OpenRouterAdapter({});
      const info = adapter.getInfo();
      expect(info).toContain('❌ Missing API key');
    });
  });
});
