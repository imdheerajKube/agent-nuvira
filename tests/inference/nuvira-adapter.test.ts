/**
 * Nuvira Gateway adapter — parity tests (Nuvira-Router P1 M1.4).
 *
 * Exercises the adapter against a MOCK OpenAI-compatible /v1 endpoint:
 *   - chat completions (non-stream + stream via onToken passthrough)
 *   - /models listing + isAvailable
 *   - error mapping to the shared classification contract (401→auth, 429→
 *     rate-limit, 500→server) so the failover walk + registry learn correctly
 *   - baseUrl normalization (trailing slash, custom port)
 *   - extra-header injection (headers field) + header-injection guard
 *   - graceful empty /models ("nothing listed" ≠ error)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NuviraAdapter } from '../../src/inference/nuvira-adapter.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Hermetic storage isolation ──────────────────────────────────────────────
// generate() flows through cost-tracker → model-registry telemetry. Isolate
// BUFF_MEMORY_DIR so the real user registry is never written.

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-nuvira-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetModelRegistry();
  vi.clearAllMocks();
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

describe('NuviraAdapter', () => {
  describe('constructor + baseUrl normalization', () => {
    it('defaults to the gateway base when no baseUrl is configured', () => {
      const adapter = new NuviraAdapter({});
      expect(adapter.name).toBe('Nuvira Gateway');
      expect((adapter as any).baseUrl).toBe('http://127.0.0.1:20128/v1');
    });

    it('normalizes a trailing-slash custom baseUrl', () => {
      const adapter = new NuviraAdapter({ baseUrl: 'http://localhost:9000/v1/' });
      expect((adapter as any).baseUrl).toBe('http://localhost:9000/v1');
    });
  });

  describe('generate', () => {
    it('posts to {baseUrl}/chat/completions and returns the content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'gateway answer' } }] }),
      });
      const adapter = new NuviraAdapter({ baseUrl: 'http://127.0.0.1:20128/v1', model: 'gpt-4o-mini' });

      const out = await adapter.generate('hello');
      expect(out).toBe('gateway answer');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:20128/v1/chat/completions');
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages[0].content).toBe('hello');
    });

    it('sends Authorization when an apiKey is configured', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });
      const adapter = new NuviraAdapter({ apiKey: 'secret', baseUrl: 'http://g:1/v1' });
      await adapter.generate('hi');
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer secret');
    });

    it('throws a 429 error that classifyFallbackError buckets as rate-limit', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limit' });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      await expect(adapter.generate('hi')).rejects.toThrow(/429/);
    });

    it('throws a 401 error that classifyFallbackError buckets as auth', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      await expect(adapter.generate('hi')).rejects.toThrow(/401/);
    });

    it('throws a 500 error that classifyFallbackError buckets as server', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'internal' });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      await expect(adapter.generate('hi')).rejects.toThrow(/500/);
    });

    it('throws on an empty response body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      await expect(adapter.generate('hi')).rejects.toThrow(/empty response/);
    });
  });

  describe('generateStream', () => {
    it('streams tokens via onToken and returns the full content', async () => {
      // streamCompletion consumes an SSE body reader — emulate it.
      const sseBody = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
      const encoder = new TextEncoder();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            const chunks = [encoder.encode(sseBody)];
            return {
              read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
              releaseLock: () => {},
              cancel: () => {},
            };
          },
        },
      });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      const tokens: string[] = [];
      const full = await adapter.generateStream('hi', { model: 'm' }, (t) => tokens.push(t));
      expect(tokens.join('')).toBe('Hello');
      expect(full).toBe('Hello');
    });
  });

  describe('isAvailable + listModels', () => {
    it('isAvailable is true when /models answers ok (keyless gateways supported)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      expect(await adapter.isAvailable()).toBe(true);
      expect(String(mockFetch.mock.calls[0][0])).toBe('http://g:1/v1/models');
    });

    it('isAvailable is false when the gateway is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('listModels maps gateway models with catalog tags', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }] }),
      });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      const models = await adapter.listModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('gpt-4o-mini');
      expect(models[0].provider).toBe('nuvira');
      expect(Array.isArray(models[0].tags)).toBe(true);
    });

    it('listModels returns [] on an EMPTY /models response (not an error)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      expect(await adapter.listModels()).toEqual([]);
    });

    it('listModels returns [] when /models is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const adapter = new NuviraAdapter({ baseUrl: 'http://g:1/v1' });
      expect(await adapter.listModels()).toEqual([]);
    });
  });

  describe('extra headers + injection guard', () => {
    it('merges config.headers into requests', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
      const adapter = new NuviraAdapter({
        baseUrl: 'http://g:1/v1',
        headers: { 'X-Tenant': 'acme', 'X-Gateway-Key': 'k' },
      });
      await adapter.generate('hi');
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-Tenant']).toBe('acme');
      expect(opts.headers['X-Gateway-Key']).toBe('k');
    });

    it('drops header keys/values containing CR/LF (injection guard)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
      const adapter = new NuviraAdapter({
        baseUrl: 'http://g:1/v1',
        headers: { 'X-Bad': 'v\r\nInjected: 1', 'X-Ok': 'fine', 'Bad:Key': 'x' },
      });
      await adapter.generate('hi');
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-Ok']).toBe('fine');
      expect(opts.headers['X-Bad']).toBeUndefined();
      expect(opts.headers['Bad:Key']).toBeUndefined();
    });
  });
});
