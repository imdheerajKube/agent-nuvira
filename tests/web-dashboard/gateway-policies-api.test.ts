/**
 * Gateway Permissions API — /api/admin/gateway/policies (GUI parity with
 * `buff config gateway allow/disallow/reply`).
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * viewer for the RBAC gate), and a temp BUFF_CONFIG_DIR so policy writes stay
 * hermetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-gwpol-api-'));
const memoryDir = join(testDir, '.buff', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.BUFF_DASHBOARD_PORT = '0';
process.env.BUFF_DASHBOARD_HOST = '127.0.0.1';
process.env.BUFF_MEMORY_DIR = memoryDir;
process.env.BUFF_CONFIG_DIR = join(testDir, '.buff');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';

function authedFetch(path: string, method = 'GET', body?: unknown, tok = token): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'test-password-123' }),
  });
  const setupData = (await setup.json()) as { token?: string };
  expect(setupData.token).toBeTruthy();
  token = setupData.token as string;

  const addViewer = await authedFetch('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  expect(addViewer.status).toBe(200);
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  const vData = (await vLogin.json()) as { token?: string };
  viewerToken = vData.token as string;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/admin/gateway/policies', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const get = await fetch(`${baseUrl}/api/admin/gateway/policies`);
    expect(get.status).toBe(401);
    const put = await fetch(`${baseUrl}/api/admin/gateway/policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"policies":{}}',
    });
    expect(put.status).toBe(401);
  });

  it('viewer cannot read or write policies (403 — requires gateway.manage)', async () => {
    const get = await authedFetch('/api/admin/gateway/policies', 'GET', undefined, viewerToken);
    expect(get.status).toBe(403);
    const put = await authedFetch('/api/admin/gateway/policies', 'PUT', { policies: {} }, viewerToken);
    expect(put.status).toBe(403);
  });

  it('GET returns the effective per-platform policies (empty by default)', async () => {
    const res = await authedFetch('/api/admin/gateway/policies');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; policies: Record<string, unknown>; statusRecipients: string[] };
    expect(body.ok).toBe(true);
    expect(body.policies.whatsapp).toEqual({});
    expect(body.policies.telegram).toEqual({});
    // Every platform transport is present for the Permissions page.
    expect(Object.keys(body.policies)).toContain('discord');
    expect(Object.keys(body.policies)).toContain('email');
    expect(body.statusRecipients).toEqual([]);
  });

  it('GET/PUT round-trips status recipients alongside policies', async () => {
    const put = await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: { whatsapp: { allowedUsers: ['u-1'] } },
      statusRecipients: ['whatsapp:Daddy', 'slack:ops'],
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ok: boolean; statusRecipients: string[] };
    expect(putBody.statusRecipients).toEqual(['whatsapp:Daddy', 'slack:ops']);

    const get = await authedFetch('/api/admin/gateway/policies');
    const getBody = (await get.json()) as { statusRecipients: string[] };
    expect(getBody.statusRecipients).toEqual(['whatsapp:Daddy', 'slack:ops']);

    // Persisted to the config file.
    const config = JSON.parse(readFileSync(join(testDir, '.buff', 'buffconfig.json'), 'utf-8'));
    expect(config.gateway.statusRecipients).toEqual(['whatsapp:Daddy', 'slack:ops']);

    // Removing works (whole-array replace).
    await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: {},
      statusRecipients: [],
    });
    const get2 = await authedFetch('/api/admin/gateway/policies');
    const get2Body = (await get2.json()) as { statusRecipients: string[] };
    expect(get2Body.statusRecipients).toEqual([]);
  });

  it('PUT writes per-platform policies and GET reads them back', async () => {
    const put = await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: {
        whatsapp: { allowedUsers: ['918178504516'], silentDrop: true },
        telegram: { allowedGroups: ['g-family'], requireMention: true },
      },
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ok: boolean; policies: Record<string, { allowedUsers?: string[]; silentDrop?: boolean }> };
    expect(putBody.ok).toBe(true);
    expect(putBody.policies.whatsapp).toEqual({ allowedUsers: ['918178504516'], silentDrop: true });

    const get = await authedFetch('/api/admin/gateway/policies');
    const getBody = (await get.json()) as { policies: Record<string, Record<string, unknown>> };
    expect(getBody.policies.whatsapp).toEqual({ allowedUsers: ['918178504516'], silentDrop: true });
    expect(getBody.policies.telegram).toEqual({ allowedGroups: ['g-family'], requireMention: true });
    // The write landed in the config file (persists across restarts).
    const config = JSON.parse(readFileSync(join(testDir, '.buff', 'buffconfig.json'), 'utf-8'));
    expect(config.gateway.policies.whatsapp).toEqual({ allowedUsers: ['918178504516'], silentDrop: true });
  });

  it('PUT ignores unknown platforms and preserves unlisted ones', async () => {
    const put = await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: {
        whatsapp: { allowedUsers: ['u-1'] },
        notreal: { allowedUsers: ['u-x'] },
      },
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { policies: Record<string, Record<string, unknown>> };
    expect(putBody.policies.notreal).toBeUndefined();
    // Per-key merge: allowedUsers is replaced by the draft; any OTHER key the
    // earlier tests wrote (e.g. silentDrop) survives — that's the point.
    expect(putBody.policies.whatsapp).toMatchObject({ allowedUsers: ['u-1'] });

    // A follow-up PUT for only telegram keeps whatsapp intact.
    await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: { telegram: { silentDrop: true } },
    });
    const get = await authedFetch('/api/admin/gateway/policies');
    const getBody = (await get.json()) as { policies: Record<string, { allowedUsers?: string[]; silentDrop?: boolean }> };
    expect(getBody.policies.whatsapp).toMatchObject({ allowedUsers: ['u-1'] });
    expect(getBody.policies.telegram).toMatchObject({ silentDrop: true });
  });

  it('PUT merges per-key — toggling ONE flag never wipes the saved allowedUsers', async () => {
    // Regression: the dashboard sends its draft (a partial diff). A draft that
    // only toggles silentDrop must NOT replace the platform policy wholesale
    // and lose the saved allowed users — that made removed contacts look like
    // they were gone and made others vanish on save.
    await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: { whatsapp: { allowedUsers: ['u-1', 'u-2'], silentDrop: true } },
    });
    const put = await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: { whatsapp: { silentDrop: false } },
    });
    expect(put.status).toBe(200);
    const get = await authedFetch('/api/admin/gateway/policies');
    const getBody = (await get.json()) as { policies: Record<string, { allowedUsers?: string[]; silentDrop?: boolean }> };
    expect(getBody.policies.whatsapp).toEqual({ allowedUsers: ['u-1', 'u-2'], silentDrop: false });
    // An edited allowedUsers list still REPLACES the key (removal works).
    await authedFetch('/api/admin/gateway/policies', 'PUT', {
      policies: { whatsapp: { allowedUsers: ['u-1'] } },
    });
    const get2 = await authedFetch('/api/admin/gateway/policies');
    const get2Body = (await get2.json()) as { policies: Record<string, { allowedUsers?: string[] }> };
    expect(get2Body.policies.whatsapp.allowedUsers).toEqual(['u-1']);
  });

  it('rejects non-GET/PUT methods (405)', async () => {
    const res = await authedFetch('/api/admin/gateway/policies', 'DELETE');
    expect(res.status).toBe(405);
  });
});
