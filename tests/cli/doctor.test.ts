/**
 * Doctor tests — Nuvira sidecar probe (P5 M5.1).
 *
 * `buff doctor --nuvira` probes an external OpenAI-compatible gateway:
 * GET {base}/models for reachability + model count, then a best-effort
 * GET {baseWithoutV1}/version for the gateway version. These tests exercise
 * the exported probeNuviraSidecar() against a REAL local HTTP mock — no
 * external network, no real gateway required.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  probeNuviraSidecar,
  auditJsonlIntegrity,
  checkSecretsBackend,
  checkGatewayTelemetry,
  buildEnterpriseChecks,
} from '../../src/cli/doctor.js';
import type { BuffConfig } from '../../src/config/types.js';

// ─── Mock gateway-shaped server ─────────────────────────────────────────────

let server: Server;
let port: number;

// Second mock: models only, no /version endpoint (many gateways).
let noVersionServer: Server;
let noVersionPort: number;

// Third mock: auth-token-gated gateway (production security default).
let authServer: Server;
let authPort: number;

function sendJSON(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function startMock(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url === '/v1/models') {
        sendJSON(res, 200, {
          object: 'list',
          data: [
            { id: 'gateway-model-a', owned_by: 'gateway' },
            { id: 'gateway-model-b', owned_by: 'gateway' },
          ],
        });
        return;
      }
      if (req.method === 'GET' && url === '/version') {
        sendJSON(res, 200, { version: '1.66.5-gateway' });
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

function stopMock(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function startNoVersionMock(): Promise<number> {
  return new Promise((resolve, reject) => {
    noVersionServer = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url === '/v1/models') {
        sendJSON(res, 200, { object: 'list', data: [{ id: 'only-model', owned_by: 'gateway' }] });
        return;
      }
      sendJSON(res, 404, { error: { message: `not found: ${req.method} ${url}` } });
    });
    noVersionServer.on('error', reject);
    noVersionServer.listen(0, '127.0.0.1', () => {
      const addr = noVersionServer.address() as AddressInfo;
      noVersionPort = addr.port;
      resolve(noVersionPort);
    });
  });
}

function stopNoVersionMock(): Promise<void> {
  return new Promise((resolve) => {
    if (!noVersionServer) return resolve();
    noVersionServer.close(() => resolve());
  });
}

function startAuthMock(): Promise<number> {
  return new Promise((resolve, reject) => {
    authServer = createServer((req, res) => {
      const url = req.url || '';
      // 401 unless the gateway token is presented — the M5.2 production default.
      if (req.headers.authorization !== 'Bearer prod-token') {
        sendJSON(res, 401, { error: { message: 'missing gateway token' } });
        return;
      }
      if (req.method === 'GET' && url === '/v1/models') {
        sendJSON(res, 200, { object: 'list', data: [{ id: 'secured-model', owned_by: 'gateway' }] });
        return;
      }
      sendJSON(res, 404, { error: { message: `not found: ${req.method} ${url}` } });
    });
    authServer.on('error', reject);
    authServer.listen(0, '127.0.0.1', () => {
      const addr = authServer.address() as AddressInfo;
      authPort = addr.port;
      resolve(authPort);
    });
  });
}

function stopAuthMock(): Promise<void> {
  return new Promise((resolve) => {
    if (!authServer) return resolve();
    authServer.close(() => resolve());
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('doctor --nuvira sidecar probe (P5 M5.1)', () => {
  beforeAll(async () => {
    await startMock();
    await startNoVersionMock();
    await startAuthMock();
  });

  afterAll(async () => {
    await stopMock();
    await stopNoVersionMock();
    await stopAuthMock();
  });

  it('healthy gateway: pass with model count + version reported', async () => {
    const probe = await probeNuviraSidecar(`http://127.0.0.1:${port}/v1`);
    expect(probe.status).toBe('pass');
    expect(probe.modelCount).toBe(2);
    expect(probe.version).toBe('1.66.5-gateway');
    expect(probe.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
  });

  it('trailing slashes are normalized; /version resolves at the non-/v1 root', async () => {
    // liteLLM-style: /version lives at the root, not under /v1.
    const probe = await probeNuviraSidecar(`http://127.0.0.1:${port}/v1///`);
    expect(probe.status).toBe('pass');
    expect(probe.version).toBe('1.66.5-gateway');
  });

  it('unreachable gateway: fail with the connection error', async () => {
    // A closed port on 127.0.0.1 — ECONNREFUSED is immediate.
    const probe = await probeNuviraSidecar('http://127.0.0.1:1/v1', 3000);
    expect(probe.status).toBe('fail');
    expect(probe.modelCount).toBe(0);
    expect(probe.error).toBeTruthy();
  });

  it('gateway with no /version: still pass (version unknown, not a failure)', async () => {
    // /v1/models answers but /version is 404 → the sidecar is reachable;
    // the version is simply unavailable (reported as a non-fatal detail).
    const probe = await probeNuviraSidecar(`http://127.0.0.1:${noVersionPort}/v1`, 3000);
    expect(probe.status).toBe('pass');
    expect(probe.modelCount).toBe(1);
    expect(probe.version).toBeNull();
    expect(probe.error).toContain('/version');
  });

  it('a token-gated gateway passes when the configured apiKey is sent (and fails without it)', async () => {
    // Without the token → 401 → fail.
    const bare = await probeNuviraSidecar(`http://127.0.0.1:${authPort}/v1`, 3000);
    expect(bare.status).toBe('fail');
    expect(bare.error).toContain('401');
    // With the token → pass + model count.
    const authed = await probeNuviraSidecar(`http://127.0.0.1:${authPort}/v1`, 3000, 'prod-token');
    expect(authed.status).toBe('pass');
    expect(authed.modelCount).toBe(1);
  });
});

// ─── P7 M7.1: enterprise self-check (pure helpers) ──────────────────────────

// Shared minimal config fixture (used by the M7.1 and M7.4 enterprise blocks).
const baseConfig: BuffConfig = {
  defaultProvider: 'local',
  providers: {
    local: { runner: 'ollama', model: 'llama2', temperature: 0.7, maxTokens: 4096 },
  },
};

describe('doctor --enterprise (P7 M7.1)', () => {

  it('auditJsonlIntegrity counts valid lines and flags corrupt lines', () => {
    const dir = '/tmp/buff-doctor-audit-test';
    mkdirSync(dir, { recursive: true });
    const good = join(dir, 'good.jsonl');
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(good, '{"a":1}\n{"b":2}\n', 'utf-8');
    writeFileSync(bad, '{"a":1}\n{corrupt\n{"b":2}\n', 'utf-8');
    expect(auditJsonlIntegrity(good)).toEqual({ total: 2, corrupt: 0 });
    expect(auditJsonlIntegrity(bad)).toEqual({ total: 3, corrupt: 1 });
    expect(auditJsonlIntegrity(join(dir, 'missing.jsonl'))).toEqual({ total: 0, corrupt: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('checkSecretsBackend warns when a key is in plaintext config (not env)', () => {
    const cfg: BuffConfig = {
      ...baseConfig,
      providers: { ...baseConfig.providers, groq: { apiKey: 'gsk_plaintext_secret' } },
    };
    const result = checkSecretsBackend(cfg, {});
    expect(result.status).toBe('warn');
    expect(result.message).toContain('plaintext');
  });

  it('checkSecretsBackend passes when the key comes from the environment', () => {
    const cfg: BuffConfig = {
      ...baseConfig,
      providers: { ...baseConfig.providers, groq: { apiKey: 'gsk_from_env' } },
    };
    const result = checkSecretsBackend(cfg, { GROQ_API_KEY: 'gsk_from_env' });
    expect(result.status).toBe('pass');
    expect(result.message).toContain('environment');
  });

  it('buildEnterpriseChecks: healthy gateway + clean audits + policy = all pass', () => {
    const dir = '/tmp/buff-doctor-enterprise-test';
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'quota-events.jsonl');
    const actions = join(dir, 'model-registry-actions.jsonl');
    writeFileSync(events, '{"type":"parked"}\n', 'utf-8');
    writeFileSync(actions, '{"outcome":"verified"}\n', 'utf-8');
    const checks = buildEnterpriseChecks({
      config: {
        ...baseConfig,
        routing: {
          governance: { allowProviders: ['groq', 'local'] },
          // M7.4 opt-in telemetry ON with tracked usage → all six checks pass.
          gatewayTelemetry: { enabled: true },
        },
      },
      env: { GROQ_API_KEY: 'k' },
      gatewayProbe: { status: 'pass', modelCount: 3, version: '1.2.3', baseUrl: 'http://127.0.0.1:20128/v1' },
      gatewayConfigured: true,
      auditFiles: [
        { name: 'quota-events.jsonl', path: events },
        { name: 'model-registry-actions.jsonl', path: actions },
      ],
      gatewayUsage: {
        providers: [{ provider: 'groq', requests: 5, tokens: 100, costUsd: 0, parked: false, resetsInMs: 0 }],
        totalRequests: 5,
        totalTokens: 100,
        totalCostUsd: 0,
      },
    });
    // 6 checks: gateway, secrets, 2× audit, RBAC, M7.4 telemetry — all pass.
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    const telemetry = checks.find((c) => c.name === 'Telemetry / Usage Health');
    expect(telemetry?.status).toBe('pass');
    expect(telemetry?.message).toContain('5 call(s)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildEnterpriseChecks: unreachable gateway + corrupt audit = fail with informative details', () => {
    const dir = '/tmp/buff-doctor-enterprise-bad';
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'quota-events.jsonl');
    writeFileSync(events, '{corrupt-line\n', 'utf-8');
    const checks = buildEnterpriseChecks({
      config: baseConfig,
      env: {},
      gatewayProbe: { status: 'fail', modelCount: 0, version: null, baseUrl: 'http://127.0.0.1:1/v1', error: 'ECONNREFUSED' },
      gatewayConfigured: true,
      auditFiles: [{ name: 'quota-events.jsonl', path: events }],
    });
    const gateway = checks.find((c) => c.name === 'Gateway Health');
    const audit = checks.find((c) => c.name.includes('Audit Integrity'));
    expect(gateway?.status).toBe('fail');
    expect(gateway?.fix).toContain('docker compose');
    expect(audit?.status).toBe('fail');
    expect(audit?.message).toContain('corrupt');
    // Missing-config (RBAC) is INFORMATIVE — a warn, not a fail.
    const rbac = checks.find((c) => c.name.includes('RBAC'));
    expect(rbac?.status).toBe('warn');
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildEnterpriseChecks: unconfigured gateway is informative (warn), not a failure', () => {
    const checks = buildEnterpriseChecks({
      config: baseConfig,
      env: {},
      gatewayProbe: null,
      gatewayConfigured: false,
      auditFiles: [],
    });
    const gateway = checks.find((c) => c.name === 'Gateway Health');
    expect(gateway?.status).toBe('warn');
    expect(gateway?.message).toContain('not configured');
  });
});

describe('doctor --enterprise telemetry flags (P7 M7.4, opt-in, off by default)', () => {
  const usage = {
    providers: [
      { provider: 'groq', requests: 12, tokens: 3400, costUsd: 0.0012, parked: false, resetsInMs: 0 },
      { provider: 'gemini', requests: 4, tokens: 900, costUsd: 0, parked: true, resetsInMs: 3_600_000 },
    ],
    totalRequests: 16,
    totalTokens: 4300,
    totalCostUsd: 0.0012,
  };

  it('flag OFF by default: informative warn with the enable command, never a fail', () => {
    const check = checkGatewayTelemetry(baseConfig, usage);
    expect(check.name).toBe('Telemetry / Usage Health');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('OFF');
    expect(check.fix).toContain('routing.gatewayTelemetry.enabled true');
    expect(check.detail).not.toContain('16 call'); // no metrics leak when off
  });

  it('flag ON without healthFlags: aggregate headline only, no per-provider detail', () => {
    const cfg: BuffConfig = {
      ...baseConfig,
      routing: { gatewayTelemetry: { enabled: true } },
    };
    const check = checkGatewayTelemetry(cfg, usage);
    expect(check.status).toBe('pass');
    expect(check.message).toContain('16 call(s)');
    expect(check.message).toContain('4,300 token(s)');
    // Aggregate privacy default: no per-provider flags unless healthFlags is on
    expect(check.detail).not.toContain('groq:');
  });

  it('flag ON with healthFlags: per-provider usage-health flags rendered (parked + reset shown)', () => {
    const cfg: BuffConfig = {
      ...baseConfig,
      routing: { gatewayTelemetry: { enabled: true, healthFlags: true } },
    };
    const check = checkGatewayTelemetry(cfg, usage);
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('groq: 12 call(s)');
    expect(check.detail).toContain('gemini: 4 call(s)');
    expect(check.detail).toContain('⛔ parked');
    expect(check.detail).toContain('resets in 60m');
  });

  it('flag ON but no tracked usage yet: warn (nothing to report), not a fail', () => {
    const cfg: BuffConfig = {
      ...baseConfig,
      routing: { gatewayTelemetry: { enabled: true, healthFlags: true } },
    };
    const check = checkGatewayTelemetry(cfg, { providers: [], totalRequests: 0, totalTokens: 0, totalCostUsd: 0 });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('ON');
  });

  it('buildEnterpriseChecks includes the M7.4 telemetry check with default-off semantics', () => {
    const checks = buildEnterpriseChecks({
      config: baseConfig,
      env: {},
      gatewayProbe: null,
      gatewayConfigured: false,
      auditFiles: [],
    });
    const telemetry = checks.find((c) => c.name === 'Telemetry / Usage Health');
    expect(telemetry).toBeDefined();
    expect(telemetry?.status).toBe('warn');
    expect(telemetry?.message).toContain('OFF');
  });
});
