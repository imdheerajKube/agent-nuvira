/**
 * E2E — "registry learns the block, the next pick skips it" (hermetic).
 *
 * This is the repeatable, CI-safe version of the manual tmux failover proof:
 *   - A REAL local HTTP server mocks an OpenAI-compatible provider (NIM) that
 *     returns 429 (rate-limit) for /chat/completions and 200 for /models.
 *   - The REAL NIM adapter + REAL ProviderFallback + REAL ModelRegistry +
 *     REAL AutoModelRouter are exercised over that HTTP socket — no unit
 *     mocks for the routing layer, no external network, no Ollama required.
 *   - Verifies the full learning loop:
 *       1. A real call fails with the mocked 429 → classified rate-limit →
 *          recordRegistryFailure writes through → nim marked unavailable
 *          (+ quota-parked).
 *       2. getBlockedProviders() includes nim (learned block).
 *       3. The auto router's next resolve() predictively SKIPS nim even though
 *          every provider claims to have credentials (registry block, not
 *          credential filtering).
 *       4. The per-action telemetry log records the `plan` kill (the feed that
 *          powers the dashboard's "learned from real usage" panel).
 *       5. When the mock flips to success, the same path re-verifies nim →
 *          unblocked → ranked again.
 *
 * Storage isolation: BUFF_MEMORY_DIR points at a temp dir for the whole file
 * (registry mirror, action telemetry, bandit state) so no real user data is
 * touched, mirroring the existing test-suite convention.
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

// ─── Mock OpenAI-compatible server ──────────────────────────────────────────

let server: Server;
let port: number;
let failMode: 'rate-limit' | 'ok' = 'rate-limit';

const MOCK_MODEL = 'meta/llama-3.3-70b-instruct';

function sendJSON(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function startMockServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url === '/v1/models') {
        // listModels probe — always OK so the provider is reachable at the
        // HTTP layer; only generation fails.
        sendJSON(res, 200, { object: 'list', data: [{ id: MOCK_MODEL, owned_by: 'nvidia' }] });
        return;
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        if (failMode === 'rate-limit') {
          sendJSON(res, 429, {
            error: { message: 'rate limit exceeded — quota exhausted for this model', code: 'rate_limit_exceeded' },
          });
          return;
        }
        // Success mode — a plausible NIM completion.
        sendJSON(res, 200, {
          choices: [{ message: { content: 'Mock completion from the hermetic test provider.' } }],
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
  // Every provider claims to have credentials — so any provider missing from
  // a resolve() ranking is excluded by the REGISTRY block, not by key checks.
  return {
    getAll: () => ({ pricing: {}, routing: { quota: {} } }),
    hasRequiredCredentials: () => true,
    getProviderConfig: (type: string) => ({
      config: {
        model: MOCK_MODEL,
        apiKey: 'fake-nim-key',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        // Only nim is real (points at the mock); others resolve but are never
        // reached in the fallback chain below (chain = [nim]).
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

describe('E2E: registry learns the block, next pick skips it', () => {
  beforeAll(async () => {
    await startMockServer();
  });

  afterAll(async () => {
    await stopMockServer();
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-e2e-failover-'));
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

  it('a real 429 call teaches the registry and the router skips the provider on the next pick', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nim'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });

    // ── 1. The real call fails with the mocked 429 ─────────────────────────
    await expect(
      fallback.callWithFallback(
        'nim',
        (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
        { context: 'plan', label: 'Plan generation' },
      ),
    ).rejects.toThrow();

    // ── 2. Registry learned the block (definitive, not transient) ──────────
    const registry = getModelRegistry();
    expect(registry.getEntry('nim', MOCK_MODEL)?.status).toBe('unavailable');
    expect(registry.getEntry('nim', MOCK_MODEL)?.lastError).toContain('rate-limit');
    expect(registry.getBlockedProviders()).toContain('nim');

    // ── 3. Next pick SKIPS nim — registry block, not credential filtering ──
    const decision = new AutoModelRouter().resolve('planner', 'write a plan', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'nim')).toBe(false);

    // ── 4. Per-action telemetry recorded the `plan` kill ───────────────────
    const log = readActionLog();
    const line = log.split('\n').find((l) => l.includes('"action":"plan"'));
    expect(line).toBeTruthy();
    expect(line).toContain('"provider":"nim"');
    expect(line).toContain('"outcome":"unavailable"');
    expect(line).toContain('"errorType":"rate-limit"');
    const telemetry = registry.getActionTelemetry();
    const plan = telemetry.actions.find((a) => a.action === 'plan');
    expect(plan?.killed).toBe(1);
    expect(plan?.killedModels[0]?.provider).toBe('nim');
  });

  it('the skip is stable across repeated resolve() calls (predictive, not reactive)', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nim'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });
    await fallback.callWithFallback(
      'nim',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan' },
    ).catch(() => undefined);

    // The next five picks never even try nim — sub-ms, no network.
    for (let i = 0; i < 5; i++) {
      const decision = getAutoRouter().resolve('planner', 'write a plan', {}, configManager);
      expect(decision.ranked.some((s) => s.provider === 'nim')).toBe(false);
    }
  });

  it('a later real success re-verifies the provider and unblocks it (recovery loop)', async () => {
    const configManager = makeConfigManager();
    const fallback = getProviderFallback(configManager, {
      providers: ['nim'],
      maxAttempts: 1,
      retryDelayMs: 1,
    });

    // First: learn the block.
    await fallback.callWithFallback(
      'nim',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan' },
    ).catch(() => undefined);
    expect(getModelRegistry().getBlockedProviders()).toContain('nim');

    // The provider recovers — the mock now serves 200s.
    failMode = 'ok';
    const result = await fallback.callWithFallback(
      'nim',
      (provider) => provider.generate('write a plan', { model: MOCK_MODEL }),
      { context: 'plan', label: 'Plan generation' },
    );
    expect(result.provider).toBe('nim');
    expect(result.response).toContain('Mock completion');

    // The success write-through re-verified nim → unblocked → ranked again.
    const registry = getModelRegistry();
    expect(registry.getEntry('nim', MOCK_MODEL)?.status).toBe('verified');
    expect(registry.getBlockedProviders()).not.toContain('nim');
    const decision = new AutoModelRouter().resolve('planner', 'write a plan', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'nim')).toBe(true);

    // And the action log carries the recovery: one plan kill, one plan verify.
    const telemetry = registry.getActionTelemetry();
    const plan = telemetry.actions.find((a) => a.action === 'plan');
    expect(plan?.killed).toBe(1);
    expect(plan?.verified).toBe(1);
    expect(plan?.verifiedModels[0]?.provider).toBe('nim');
  });
});
