/**
 * Groq adapter — the base URL override.
 *
 * `providers.groq.baseUrl` used to be ignored: the adapter hardcoded
 * `https://api.groq.com/openai/v1` at every call site, while NIM, Anthropic and
 * the generic OpenAI-compatible adapter all honor the override (and the
 * dashboard already offers a baseUrl field for Groq, and README.md documents the
 * Groq endpoint as the *default*). That made a Groq-compatible gateway — a
 * self-hosted endpoint, or the parity harness's stub server — impossible to
 * point at without a code change.
 *
 * These tests pin the override on every wire path (generate, generateTools,
 * listModels) and prove the DEFAULT is unchanged when no override is set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroqAdapter } from '../../src/inference/groq-adapter.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const GROQ_DEFAULT = 'https://api.groq.com/openai/v1';

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-groq-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetModelRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  resetModelRegistry();
  if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  rmSync(tempDir, { recursive: true, force: true });
});

const baseConfig = { apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile' };

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

describe('GroqAdapter — base URL', () => {
  it('uses the Groq default when no override is configured', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'ok' } }] }));
    await new GroqAdapter(baseConfig).generate('hi');
    expect(mockFetch.mock.calls[0][0]).toBe(`${GROQ_DEFAULT}/chat/completions`);
  });

  it('generate() posts to config.baseUrl when set (trailing slash stripped)', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'ok' } }] }));
    await new GroqAdapter({ ...baseConfig, baseUrl: 'http://127.0.0.1:4242/v1/' }).generate('hi');
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4242/v1/chat/completions');
  });

  it('generateTools() posts native tool calls to config.baseUrl and parses the wire form', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
          },
        ],
      }),
    );

    const adapter = new GroqAdapter({ ...baseConfig, baseUrl: 'http://127.0.0.1:4242/v1' });
    const response = await adapter.generateTools(
      [{ role: 'user', content: 'list the dir' }],
      [{ name: 'list_dir', description: 'list', parameters: { type: 'object' } }],
    );

    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4242/v1/chat/completions');
    // Arguments come back as an OBJECT, never the raw JSON string.
    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'list_dir', arguments: { path: '.' } }]);
  });

  it('listModels() reads the override too', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: [{ id: 'parity-stub-model', owned_by: 'local' }] }));
    const models = await new GroqAdapter({ ...baseConfig, baseUrl: 'http://127.0.0.1:4242/v1' }).listModels();
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4242/v1/models');
    expect(models[0].id).toBe('parity-stub-model');
  });
});
