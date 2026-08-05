/**
 * E2E — Nuvira gateway adapter: measured wire-token cost through the FULL
 * pipeline (Nuvira-Router M2.2). Hermetic + CI-safe, no external network.
 *
 *   - A REAL local HTTP server mocks an OpenAI-compatible /v1 gateway that
 *     reports `usage` (exact wire tokens) on BOTH the non-streaming response
 *     and a final SSE chunk (OpenAI include_usage convention).
 *   - The REAL NuviraAdapter is exercised over that socket — no mocks for the
 *     adapter or the telemetry layer.
 *   - Verifies the M2.2 loop end-to-end:
 *       1. generate() records MEASURED tokens → cost-tracker entry flagged
 *          `measured: true` (persisted — the dashboard split reads it).
 *       2. The exact tokens write through to the Model Availability Registry
 *          (recordMeasuredUsage) → getMeasuredUsage() returns them.
 *       3. The successful call also VERIFIES the provider (telemetry) → the
 *          registry can route to it.
 *       4. generateStream() captures usage from the final SSE chunk the same
 *          way.
 *       5. A resolve() restricted to the gateway surfaces costSource
 *          'measured' + costBasis (measured cost beats the TYPICAL estimate).
 *
 * Storage isolation: BUFF_MEMORY_DIR points at a temp dir for the whole file
 * (registry mirror, cost-tracker, action telemetry) so no real user data is
 * touched — mirroring tests/e2e/failover-learning.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NuviraAdapter } from '../../src/inference/nuvira-adapter.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { getCostTracker } from '../../src/learning/cost-tracker.js';
import { AutoModelRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetRouterPromotion } from '../../src/learning/router-promotion.js';
import type { ConfigManager } from '../../src/config/manager.js';

// ─── Mock OpenAI-compatible gateway ─────────────────────────────────────────

let server: Server;
let port: number;

const GATEWAY_MODEL = 'enterprise-llm-70b';
const USAGE = { prompt_tokens: 42, completion_tokens: 7 };

function sendJSON(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendSSE(res: import('node:http').ServerResponse): void {
  // OpenAI include_usage convention: content chunks, a usage chunk, then [DONE].
  const body =
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" from the gateway"}}]}\n\n' +
    `data: {"usage":{"prompt_tokens":${USAGE.prompt_tokens},"completion_tokens":${USAGE.completion_tokens}}}\n\n` +
    'data: [DONE]\n\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Transfer-Encoding': 'chunked' });
  res.end(body);
}

function startMockServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url === '/v1/models') {
        sendJSON(res, 200, { object: 'list', data: [{ id: GATEWAY_MODEL, owned_by: 'acme' }] });
        return;
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        // Distinguish stream vs non-stream from the request body.
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          let stream = false;
          try {
            stream = (JSON.parse(raw) as { stream?: boolean }).stream === true;
          } catch {
            // Non-JSON body — treat as non-stream.
          }
          if (stream) {
            sendSSE(res);
          } else {
            sendJSON(res, 200, {
              choices: [{ message: { content: 'Mock completion from the gateway.' } }],
              usage: USAGE,
            });
          }
        });
        return;
      }
      sendJSON(res, 404, { error: { message: `not found: ${req.method} ${url}` } });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      port = addr.port;
      resolve(port);
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

// ─── Hermetic storage isolation ─────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeConfigManager(): ConfigManager {
  return {
    getAll: () => ({ pricing: {}, routing: {} }),
    hasRequiredCredentials: () => true,
    getProviderConfig: () => ({
      config: {
        model: GATEWAY_MODEL,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
    }),
  } as unknown as ConfigManager;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-gw-e2e-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetRouterPromotion();
  await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
  resetModelRegistry();
  if (originalMemoryDir === undefined) {
    delete process.env.BUFF_MEMORY_DIR;
  } else {
    process.env.BUFF_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Gateway E2E — measured wire-token cost (M2.2)', () => {
  it('generate() records measured usage → cost-tracker flag + registry (verified)', async () => {
    const adapter = new NuviraAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const content = await adapter.generate('write a hello world script', { model: GATEWAY_MODEL });
    expect(content).toContain('Mock completion');

    // 1. Exact wire tokens landed in the registry (measured-cost routing input).
    const measured = getModelRegistry().getMeasuredUsage('nuvira');
    expect(measured).toEqual({ inputTokens: 42, outputTokens: 7, samples: 1 });

    // 2. The successful call verified the provider via telemetry → routable.
    expect(getModelRegistry().isUsable('nuvira', GATEWAY_MODEL)).toBe(true);

    // 3. The cost-tracker entry is flagged measured (persisted — dashboard
    //    measured-vs-estimated split reads this from disk).
    const entries = getCostTracker().getAllEntries().filter((e) => e.provider === 'nuvira');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].measured).toBe(true);
    expect(entries[entries.length - 1].inputTokens).toBe(42);
    expect(entries[entries.length - 1].outputTokens).toBe(7);
  });

  it('generateStream() captures usage from the final SSE chunk (measured)', async () => {
    const adapter = new NuviraAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const tokens: string[] = [];
    const full = await adapter.generateStream('stream me', { model: GATEWAY_MODEL }, (t) => tokens.push(t));
    expect(tokens.join('')).toBe('Hello from the gateway');
    expect(full).toBe('Hello from the gateway');

    const measured = getModelRegistry().getMeasuredUsage('nuvira');
    // Two measured calls now: non-stream (42/7) then stream (42/7) — EMA
    // (α=0.3) keeps the profile at the same exact tokens.
    expect(measured).toEqual({ inputTokens: 42, outputTokens: 7, samples: 2 });
  });

  it('resolve() restricted to the gateway scores cost from MEASURED tokens', async () => {
    const router = new AutoModelRouter();
    const decision = router.resolve(
      'writer',
      'implement a login form',
      { allowedProviders: ['nuvira'] },
      makeConfigManager(),
    );
    const gw = decision.ranked.find((r) => r.provider === 'nuvira');
    expect(gw).toBeDefined();
    // Measured wire tokens (42/7) replaced the TYPICAL 2000/500 estimate.
    expect(gw!.costSource).toBe('measured');
    expect(gw!.costBasis).toEqual({ inputTokens: 42, outputTokens: 7 });
    // And it is picked (only provider + verified by real telemetry).
    expect(decision.provider).toBe('nuvira');
  });
});
