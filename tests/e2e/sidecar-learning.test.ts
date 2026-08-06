/**
 * E2E — P5 M5.3: routing through the Nuvira sidecar gateway learns like any
 * provider (hermetic).
 *
 * Mirrors tests/e2e/failover-learning.test.ts but through the GATEWAY path:
 *   - A REAL local HTTP server mocks a gateway-shaped OpenAI-compatible
 *     endpoint (`/v1/models` + `/v1/chat/completions`) that returns 429 for
 *     generation and 200 for the model list.
 *   - The REAL NuviraAdapter + REAL ProviderFallback + REAL ModelRegistry +
 *     REAL AutoModelRouter are exercised over that socket — no unit mocks for
 *     the routing layer, no external network, no real gateway.
 *   - Verifies the gateway-specific learning loop:
 *       1. A real gateway call fails with the mocked 429 → classified
 *          rate-limit → recordRegistryFailure writes through → nuvira marked
 *          unavailable (+ quota-parked).
 *       2. getBlockedProviders() includes nuvira (learned block).
 *       3. The auto router's next resolve() predictively SKIPS nuvira even
 *          though every provider claims to have credentials (registry block,
 *          not credential filtering).
 *       4. The per-action telemetry log records the `plan` kill for the
 *          gateway provider — the same feed the dashboard shows.
 *       5. When the mock flips to success, the same path re-verifies nuvira →
 *          unblocked → ranked again (recovery loop).
 *
 * Storage isolation: BUFF_MEMORY_DIR points at a temp dir for the whole file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProviderFallback, resetProviderFallback } from '../../src/learning/provider-fallback.js';
import { getModelRegistry, resetModelRegistry, ACTION_LOG_FILENAME } from '../../src/learning/model-registry.js';
import { AutoModelRouter, getAutoRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetRouterPromotion } from '../../src/learning/router-promotion.js';
import type { ConfigManager } from '../../src/config/manager.js';

// ─── Mock gateway-shaped server ─────────────────────────────────────────────

let server: Server;
let port: number;
let failMode: 'rate-limit' | 'ok' = 'rate-limit';

const MOCK_MODEL = 'gateway/llama-3.3-70b-instruct';

function sendJSON(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function startMockGateway(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url === '/v1/models') {
        // listModels probe — always OK so the gateway is reachable at the
        // HTTP layer; only generation fails.
        sendJSON(res, 200, { object: 'list', data: [{ id: MOCK_MODEL, owned_by: 'gateway' }] });
        return;
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        if (failMode === 'rate-limit') {
          sendJSON(res, 429, {
            error: { message: 'gateway rate limit exceeded — quota exhausted for this model', code: 'rate_limit_exceeded' },
          });
          return;
        }
        // Success mode — a plausible gateway completion.
        sendJSON(res, 200, {
          choices: [{ message: { content: 'Mock gateway completion from the hermetic test provider.' } }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
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

function stopMockGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

// ─── Hermetic storage isolation ─────────────────────────────────────────────

let tempDir: string;
let originalMemoryDir: string | undefined;

function makeConfigManager(): ConfigManager {
  // Every provider claims to have credentials — so any provider missing from
  // a resolve() ranking is excluded by the REGISTRY block, not by key checks.
  return {
    getAll: () => ({ pricing: {}, routing: { quota: {} } }),
    hasRequiredCredentials: () => true,
    getProviderConfig: (type: string) => ({
      config: {
        model: MOCK_MODEL,
        apiKey: 'fake-gateway-key',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        ...(type === 'local' ? { runner: 'ollama', model: 'mock-model' } : {}),
      },
    }),
  } as unknown as ConfigManager;
}

function readActionLog(): string {
  try {
    return readFileSync(join(tempDir, ACTION_LOG_FILENAME), 'utf-8');
  } catch {
    return '';
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: gateway 429 teaches the registry and the router skips it on the next pick', () => {
  beforeAll(async () => {
    await startMockGateway();
  });

  afterAll(async () => {
    await stopMockGateway();
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-e2e-sidecar-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    failMode = 'rate-limit';
    resetModelRegistry();
    resetProviderFallback();
    resetAutoRouter();
    resetRouterBandit();
    resetRouterPromotion();
  });

  afterEach(() => {
    resetModelRegistry();
    resetProviderFallback();
    resetAutoRouter();
    resetRouterBandit();
    resetRouterPromotion();
    if (originalMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
    else process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a real 429 gateway call teaches the registry; the next pick skips nuvira', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nuvira'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });

    // ── 1. The real gateway call fails with the mocked 429 ────────────────
    await expect(
      fallback.callWithFallback(
        'nuvira',
        (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
        { context: 'plan', label: 'Plan generation' },
      ),
    ).rejects.toThrow();

    // ── 2. Registry learned the block (definitive, not transient) ──────────
    const registry = getModelRegistry();
    expect(registry.getEntry('nuvira', MOCK_MODEL)?.status).toBe('unavailable');
    expect(registry.getEntry('nuvira', MOCK_MODEL)?.lastError).toContain('rate-limit');
    expect(registry.getBlockedProviders()).toContain('nuvira');

    // ── 3. Next pick SKIPS nuvira — registry block, not credential filtering ──
    const decision = new AutoModelRouter().resolve('planner', 'write a plan', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'nuvira')).toBe(false);

    // ── 4. Per-action telemetry recorded the `plan` kill for the gateway ──
    const log = readActionLog();
    const line = log.split('\n').find((l) => l.includes('"action":"plan"'));
    expect(line).toBeTruthy();
    expect(line).toContain('"provider":"nuvira"');
    expect(line).toContain('"outcome":"unavailable"');
    expect(line).toContain('"errorType":"rate-limit"');
    const telemetry = registry.getActionTelemetry();
    const plan = telemetry.actions.find((a) => a.action === 'plan');
    expect(plan?.killed).toBe(1);
    expect(plan?.killedModels[0]?.provider).toBe('nuvira');
  });

  it('the skip is stable across repeated resolve() calls (predictive, not reactive)', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nuvira'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });
    await fallback.callWithFallback(
      'nuvira',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan' },
    ).catch(() => undefined);

    // The next five picks never even try nuvira — sub-ms, no network.
    for (let i = 0; i < 5; i++) {
      const decision = getAutoRouter().resolve('planner', 'write a plan', {}, configManager);
      expect(decision.ranked.some((s) => s.provider === 'nuvira')).toBe(false);
    }
  });

  it('a later real gateway success re-verifies the provider and unblocks it (recovery loop)', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nuvira'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });

    // First: learn the block.
    await fallback.callWithFallback(
      'nuvira',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan' },
    ).catch(() => undefined);
    expect(getModelRegistry().getBlockedProviders()).toContain('nuvira');

    // The gateway recovers — the mock now serves 200s.
    failMode = 'ok';
    const result = await fallback.callWithFallback(
      'nuvira',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan', label: 'Plan generation' },
    );
    expect(result.provider).toBe('nuvira');
    expect(result.response).toContain('Mock gateway completion');

    // The success write-through re-verified nuvira → unblocked → ranked again.
    const registry = getModelRegistry();
    expect(registry.getEntry('nuvira', MOCK_MODEL)?.status).toBe('verified');
    expect(registry.getBlockedProviders()).not.toContain('nuvira');
    const decision = new AutoModelRouter().resolve('planner', 'write a plan', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'nuvira')).toBe(true);

    // And the action log carries the recovery: one plan kill, one plan verify.
    const telemetry = registry.getActionTelemetry();
    const plan = telemetry.actions.find((a) => a.action === 'plan');
    expect(plan?.killed).toBe(1);
    expect(plan?.verified).toBe(1);
    expect(plan?.verifiedModels[0]?.provider).toBe('nuvira');
  });
});
