import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAdapter } from '../../src/inference/local-adapter.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Hermetic storage isolation ──────────────────────────────────────────────
// Every generate() flows through cost-tracker → model-registry telemetry.
// Isolate BUFF_MEMORY_DIR so the real user registry is never written.

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-local-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) {
    delete process.env.BUFF_MEMORY_DIR;
  } else {
    process.env.BUFF_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// Mock child_process spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

function createMockProcess() {
  const stdout = { on: vi.fn((event: string, cb: Function) => { if (event === 'data') cb(Buffer.from('{"response": "test response"}')); }) };
  const stderr = { on: vi.fn() };
  const proc = {
    stdout,
    stderr,
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'close') cb(0);  // exit code 0
    }),
  };
  return proc;
}

describe('LocalAdapter', () => {
  const baseConfig = {
    runner: 'ollama' as const,
    model: 'llama2',
    temperature: 0.7,
    maxTokens: 4096,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and name', () => {
    it('should have the correct name', () => {
      const adapter = new LocalAdapter(baseConfig);
      expect(adapter.name).toBe('Local');
    });

    it('should default to ollama runner', () => {
      const adapter = new LocalAdapter({});
      expect(adapter.getInfo()).toContain('ollama');
    });
  });

  describe('generate (Ollama runner)', () => {
    it('should successfully generate via Ollama HTTP API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'Hello from Ollama!', done: true }),
      });

      const adapter = new LocalAdapter(baseConfig);
      const result = await adapter.generate('Hello');

      expect(result).toBe('Hello from Ollama!');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('http://localhost:11434/api/generate');

      const callOptions = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callOptions.body);
      expect(body.model).toBe('llama2');
      expect(body.prompt).toBe('Hello');
      expect(body.stream).toBe(false);
      expect(body.options.temperature).toBe(0.7);
    });

    it('should throw on Ollama API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const adapter = new LocalAdapter(baseConfig);
      await expect(adapter.generate('test')).rejects.toThrow('Ollama API error (500)');
    });

    it('should use model from options over config', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'ok', done: true }),
      });

      const adapter = new LocalAdapter(baseConfig);
      await adapter.generate('test', { model: 'llama3' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('llama3');
    });

    it('should throw for unknown runner', async () => {
      const adapter = new LocalAdapter({ runner: 'unknown' as any });
      await expect(adapter.generate('test')).rejects.toThrow('Unknown local runner: unknown');
    });
  });

  describe('generate (HuggingFace runner)', () => {
    it('should handle missing Python', async () => {
      const proc = createMockProcess();
      // Override the error handler to simulate ENOENT
      proc.on = vi.fn((event: string, cb: Function) => {
        if (event === 'error') {
          const err: any = new Error('spawn python3 ENOENT');
          err.code = 'ENOENT';
          cb(err);
        }
      });

      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(proc);

      // A model is pinned (otherwise the adapter would refuse to invent one)
      // — the missing-python path is what's under test.
      const adapter = new LocalAdapter({ runner: 'huggingface' as const, model: 'phi-2' });
      await expect(adapter.generate('test')).rejects.toThrow('Python 3 is not installed');
    });

    it('should parse successful Python output', async () => {
      const mockStdout = { on: vi.fn((event: string, cb: Function) => { if (event === 'data') cb(Buffer.from('{"response": "Model response"}')); }) };
      const mockStderr = { on: vi.fn() };
      const proc = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn((event: string, cb: Function) => { if (event === 'close') cb(0); }),
      };

      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(proc);

      const adapter = new LocalAdapter({ runner: 'huggingface' as const, model: 'phi-2' });
      const result = await adapter.generate('test prompt');
      expect(result).toBe('Model response');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Ollama responds', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const adapter = new LocalAdapter(baseConfig);
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return false when Ollama is not running', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      const adapter = new LocalAdapter(baseConfig);
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('should return true for huggingface runner (checked at generation)', async () => {
      const adapter = new LocalAdapter({ runner: 'huggingface' as const });
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return true for ggml runner (checked at generation)', async () => {
      const adapter = new LocalAdapter({ runner: 'ggml' as const });
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  describe('listModels', () => {
    it('should return models from Ollama API', async () => {
      const sampleTags = {
        models: [
          { name: 'llama2:latest' },
          { name: 'mistral:latest' },
          { name: 'codellama:latest' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleTags,
      });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();

      expect(models).toHaveLength(3);
      expect(models[0]).toEqual({ id: 'llama2:latest', name: 'llama2:latest', provider: 'local', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[1]).toEqual({ id: 'mistral:latest', name: 'mistral:latest', provider: 'local', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[2]).toEqual({ id: 'codellama:latest', name: 'codellama:latest', provider: 'local', tags: expect.arrayContaining([expect.any(String)]) });

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
    });

    it('should record the advertised context window wherever Ollama exposes it (details.* / general.* / llama.*)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            // 0.32.x exposes it in details.context_length.
            { name: 'qwen2.5:0.5b', details: { context_length: 32_768 } },
            // Mid builds: model_info.general.context_length.
            { name: 'qwen3:32b', model_info: { 'general.context_length': 32_768 } },
            // Runner-keyed builds: model_info.llama.context_length.
            { name: 'llama3:8b', model_info: { 'llama.context_length': 8_192 } },
            // No metadata at all → graceful fallback.
            { name: 'old-model', model_info: {} },
          ],
        }),
      });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();

      expect(models[0].contextWindowTokens).toBe(32_768);
      expect(models[1].contextWindowTokens).toBe(32_768);
      expect(models[2].contextWindowTokens).toBe(8_192);
      expect(models[3].contextWindowTokens).toBeUndefined();
    });

    it('falls back to /api/show (family-keyed context_length) for models missing a window in /api/tags', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ models: [{ name: 'gemma4:e4b' }] }), // no details/model_info in tags
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ model_info: { 'gemma4.context_length': 131_072 } }),
        });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();

      expect(models[0].contextWindowTokens).toBe(131_072);
      expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:11434/api/show');
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.model).toBe('gemma4:e4b');
    });

    it('bounds the /api/show fallback so a large library never triggers an unbounded N+1', async () => {
      const many = Array.from({ length: 10 }, (_, i) => ({ name: `model-${i}` }));
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ models: many }) });
      for (let i = 0; i < 8; i++) {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      }

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();

      expect(models).toHaveLength(10);
      // 1 tags fetch + at most 8 show fallbacks — never 10.
      expect(mockFetch).toHaveBeenCalledTimes(9);
      expect(models.every((m) => m.contextWindowTokens === undefined)).toBe(true);
    });

    it('gracefully skips the /api/show fallback when it fails (no window, no throw)', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'x-model' }] }) })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();
      expect(models[0].contextWindowTokens).toBeUndefined();
    });

    it('should return empty array for non-ollama runners', async () => {
      const adapter = new LocalAdapter({ runner: 'huggingface' as const });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should return empty array when Ollama is not running', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle empty models list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle missing models field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const adapter = new LocalAdapter({ runner: 'ollama' as const });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });
  });

  describe('getInfo', () => {
    it('should show ollama runner by default', () => {
      const adapter = new LocalAdapter(baseConfig);
      const info = adapter.getInfo();
      expect(info).toContain('Local (ollama)');
      expect(info).toContain('llama2');
      expect(info).toContain('✅');
    });

    it('should show huggingface runner', () => {
      const adapter = new LocalAdapter({ runner: 'huggingface' as const });
      const info = adapter.getInfo();
      expect(info).toContain('Local (huggingface)');
    });
  });
});
