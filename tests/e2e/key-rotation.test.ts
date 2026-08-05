/**
 * E2E — multi-account key rotation (Nuvira-Router M2.3). Hermetic, CI-safe.
 *
 *   - A REAL local HTTP server mocks an OpenAI-compatible gateway that keys
 *     behavior on the Authorization header: `key-1` → 429 (rate-limit),
 *     `key-2` → 200 with content (+ usage, so the measured-cost path also
 *     works), `/v1/models` always 200.
 *   - The REAL NuviraAdapter + REAL runSingleShotAuto + REAL QuotaLedger +
 *     REAL resolveProvider are exercised over that socket — no mocks for the
 *     rotation layer.
 *   - Proves the M2.3 loop end-to-end:
 *       1. The runner tries `key-1`, gets 429, and parks that ACCOUNT in the
 *          quota ledger (fingerprint only — no raw key persisted).
 *       2. It ROTATES to `key-2` of the SAME provider and succeeds — never
 *          switching providers.
 *       3. The next run SKIPS the parked `key-1` predictively (only `key-2`
 *          is attempted).
 *
 * Storage isolation: BUFF_MEMORY_DIR points at a temp dir (ledger + registry)
 * so no real user data is touched — mirroring the other hermetic E2Es.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSingleShotAuto } from '../../src/cli/failover-runner.js';
import { getQuotaLedger, resetQuotaLedger, accountIdForKey } from '../../src/learning/quota-ledger.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetRouterPromotion } from '../../src/learning/router-promotion.js';
import type { ConfigManager } from '../../src/config/manager.js';
import { NuviraAdapter } from '../../src/inference/nuvira-adapter.js';

// ─── Mock gateway (Authorization-header-conditional) ────────────────────────

let server: Server;
let port: number;

const KEY_1 = 'key-1';
const KEY_2 = 'key-2';
const GATEWAY_MODEL = 'enterprise-llm-70b';
const hits: Record<string, number> = { [KEY_1]: 0, [KEY_2]: 0 };

function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

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
        sendJSON(res, 200, { object: 'list', data: [{ id: GATEWAY_MODEL, owned_by: 'acme' }] });
        return;
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const token = bearerToken(req);
        if (token === KEY_1) {
          hits[KEY_1] += 1;
          sendJSON(res, 429, { error: { message: 'rate limit exceeded — quota exhausted', code: 'rate_limit_exceeded' } });
          return;
        }
        if (token === KEY_2) {
          hits[KEY_2] += 1;
          sendJSON(res, 200, {
            choices: [{ message: { content: 'answer from key-2 account' } }],
            usage: { prompt_tokens: 40, completion_tokens: 6 },
          });
          return;
        }
        sendJSON(res, 401, { error: { message: 'unknown key' } });
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
        apiKey: KEY_1,
        apiKeys: [KEY_2],
      },
    }),
  } as unknown as ConfigManager;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-keyrot-e2e-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetQuotaLedger();
  resetModelRegistry();
  resetAutoRouter();
  resetRouterBandit();
  resetRouterPromotion();
  await startMockServer();
});

// Fresh hit counters per test so assertions are order-independent (a future
// third test must not inherit hits from earlier ones).
beforeEach(() => {
  hits[KEY_1] = 0;
  hits[KEY_2] = 0;
});

afterAll(async () => {
  await stopMockServer();
  resetQuotaLedger();
  resetModelRegistry();
  if (originalMemoryDir === undefined) {
    delete process.env.BUFF_MEMORY_DIR;
  } else {
    process.env.BUFF_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('E2E — multi-account key rotation (M2.3)', () => {
  it('rotates key-1 → key-2 on 429, parks key-1, and answers from key-2', async () => {
    const adapter = new NuviraAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const result = await runSingleShotAuto({
      action: 'chat',
      task: 'implement a login form',
      configManager: makeConfigManager(),
      route: async () => ({
        type: 'nuvira',
        provider: adapter,
        model: GATEWAY_MODEL,
        ranked: [],
        complexity: 'moderate',
        score: 0.9,
      }),
      // The REAL adapter sends whatever key the runner hands it.
      generate: (provider, type, model, apiKey) =>
        provider.generate('hello', { model, apiKey }),
      recordFailure: () => {
        // The runner's own account-parking covers the dead key.
      },
    });

    expect(result).toContain('answer from key-2 account');
    // Both keys were hit: key-1 failed with 429, key-2 answered.
    expect(hits[KEY_1]).toBe(1);
    expect(hits[KEY_2]).toBe(1);
    // The dead account is parked (fingerprint) — key-2 stays usable.
    const ledger = getQuotaLedger();
    expect(ledger.isAccountParked('nuvira', accountIdForKey(KEY_1))).toBe(true);
    expect(ledger.isAccountParked('nuvira', accountIdForKey(KEY_2))).toBe(false);
  });

  it('a second run skips the parked key-1 predictively (only key-2 attempted)', async () => {
    const key2HitsBefore = hits[KEY_2];
    const adapter = new NuviraAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const result = await runSingleShotAuto({
      action: 'chat',
      task: 'another task',
      configManager: makeConfigManager(),
      route: async () => ({
        type: 'nuvira',
        provider: adapter,
        model: GATEWAY_MODEL,
        ranked: [],
        complexity: 'simple',
        score: 0.8,
      }),
      generate: (provider, type, model, apiKey) => provider.generate('hi', { model, apiKey }),
      recordFailure: () => {},
    });

    expect(result).toContain('answer from key-2 account');
    // key-1 was NOT attempted at all (predictive skip from the parked
    // account) — exactly one key-2 hit in THIS test's fresh counters.
    expect(hits[KEY_1]).toBe(0);
    expect(hits[KEY_2]).toBe(key2HitsBefore + 1);
  });
});
