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

import { probeNuviraSidecar } from '../../src/cli/doctor.js';

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
