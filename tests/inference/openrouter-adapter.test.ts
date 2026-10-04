import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterAdapter } from '../../src/inference/openrouter-adapter.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { getCostTracker } from '../../src/learning/cost-tracker.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Hermetic storage isolation ──────────────────────────────────────────────
// Every generate() flows through cost-tracker → model-registry telemetry.
// Isolate BUFF_MEMORY_DIR so the real user registry is never written.

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-openrouter-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) {
    delete process.env.NUVIRA_MEMORY_DIR;
  } else {
    process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

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

  describe('cost metering (M2.2 measured cost + provider-reported cost)', () => {
    /** The most recent openrouter entry persisted to the hermetic ledger. */
    function lastOpenRouterEntry() {
      const entries = getCostTracker().getAllEntries().filter((e) => e.provider === 'openrouter');
      return entries[entries.length - 1];
    }

    it('records measured tokens and the exact OpenRouter-reported cost', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.00123 },
        }),
      });

      await new OpenRouterAdapter(baseConfig).generate('hello');

      const entry = lastOpenRouterEntry();
      expect(entry.measured).toBe(true);
      expect(entry.inputTokens).toBe(100);
      expect(entry.outputTokens).toBe(50);
      // Provider-reported cost wins over the local price table verbatim.
      expect(entry.costUsd).toBe(0.00123);
      expect(entry.costReported).toBe(true);
    });

    it('bills a :free model $0 even when usage carries no cost', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      await new OpenRouterAdapter(baseConfig).generate('hello', {
        model: 'meta-llama/llama-3.3-70b-instruct:free',
      });

      const entry = lastOpenRouterEntry();
      expect(entry.model).toBe('meta-llama/llama-3.3-70b-instruct:free');
      expect(entry.costUsd).toBe(0);
      // Zero because the model is free — not because the provider said so.
      expect(entry.costReported).toBeUndefined();
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

  describe('listModels', () => {
    it('should return models from the API', async () => {
      const sampleModels = {
        data: [
          { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI flagship model' },
          { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', description: 'Fast & affordable' },
          { id: 'mistralai/mistral-7b-instruct', description: 'Mistral 7B' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleModels,
      });

      const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-test' });
      const models = await adapter.listModels();

      expect(models).toHaveLength(3);
      expect(models[0]).toEqual({ id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter', description: 'OpenAI flagship model', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[1]).toEqual({ id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', provider: 'openrouter', description: 'Fast & affordable', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[2]).toEqual({ id: 'mistralai/mistral-7b-instruct', name: 'mistralai/mistral-7b-instruct', provider: 'openrouter', description: 'Mistral 7B', tags: expect.arrayContaining([expect.any(String)]) });

      expect(mockFetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': 'Bearer sk-or-test' },
      });
    });

    it('should fall back to id when name is not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'model-without-name' }],
        }),
      });

      const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();

      expect(models[0].name).toBe('model-without-name');
    });

    it('should return empty array when API key is missing', async () => {
      const adapter = new OpenRouterAdapter({});
      const models = await adapter.listModels();
      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should return empty array on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle empty data field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
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
