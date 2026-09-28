/**
 * Platform transport config API — /api/config/platforms (GUI parity with
 * `nuvira config gateway`).
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * viewer for the RBAC gate), and NUVIRA_ENV_FILE pointing at a temp file so
 * token writes stay hermetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-platcfg-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });
const envFile = join(testDir, 'env', 'test.env');

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
process.env.NUVIRA_ENV_FILE = envFile;

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

describe('/api/config/platforms', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const list = await fetch(`${baseUrl}/api/config/platforms`);
    expect(list.status).toBe(401);
    const post = await fetch(`${baseUrl}/api/config/platforms/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(401);
  });

  it('lists configurable platforms (excludes whatsapp/mock) with per-var status', async () => {
    const res = await authedFetch('/api/config/platforms');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; platforms: Array<{ platform: string; label: string; configured: boolean; envVars: Array<{ varName: string; set: boolean; value: string; prompt: string; secret: boolean }> }> };
    expect(body.ok).toBe(true);
    const ids = body.platforms.map((p) => p.platform);
    expect(ids).toContain('telegram');
    expect(ids).toContain('matrix');
    expect(ids).not.toContain('whatsapp');
    expect(ids).not.toContain('mock');
    const matrix = body.platforms.find((p) => p.platform === 'matrix')!;
    expect(matrix.envVars.map((v) => v.varName)).toEqual(['NUVIRA_MATRIX_HOMESERVER', 'NUVIRA_MATRIX_ACCESS_TOKEN']);
    expect(matrix.configured).toBe(false);
    // Secret metadata rides along for the form.
    const accessToken = matrix.envVars.find((v) => v.varName === 'NUVIRA_MATRIX_ACCESS_TOKEN')!;
    expect(accessToken.secret).toBe(true);
  });

  it('writes a platform config to the env file and reports configured', async () => {
    const res = await authedFetch('/api/config/platforms/telegram', 'POST', {
      values: { NUVIRA_TELEGRAM_TOKEN: '123:ABC-secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; wrote: string[]; status: { configured: boolean; envVars: Array<{ varName: string; value: string }> } };
    expect(body.ok).toBe(true);
    expect(body.wrote).toEqual(['NUVIRA_TELEGRAM_TOKEN']);
    expect(body.status.configured).toBe(true);
    expect(body.status.envVars[0].value).toBe('123:ABC-secret');
    expect(readFileSync(envFile, 'utf-8')).toContain('NUVIRA_TELEGRAM_TOKEN=123:ABC-secret');

    // The GET list now shows it configured with the full value (admin).
    const list = await authedFetch('/api/config/platforms');
    const listBody = (await list.json()) as { platforms: Array<{ platform: string; configured: boolean; envVars: Array<{ value: string }> }> };
    const tg = listBody.platforms.find((p) => p.platform === 'telegram')!;
    expect(tg.configured).toBe(true);
    expect(tg.envVars[0].value).toBe('123:ABC-secret');
  });

  it('viewer cannot write (403) and sees redacted values', async () => {
    const post = await authedFetch('/api/config/platforms/slack', 'POST', { values: { NUVIRA_SLACK_BOT_TOKEN: 'xoxb-123' } }, viewerToken);
    expect(post.status).toBe(403);
    const list = await authedFetch('/api/config/platforms', 'GET', undefined, viewerToken);
    const body = (await list.json()) as { platforms: Array<{ envVars: Array<{ set: boolean; value: string }> }> };
    const tg = body.platforms.find((p) => p.platform === 'telegram')!;
    expect(tg.envVars[0].set).toBe(true);
    expect(tg.envVars[0].value).not.toContain('123:ABC-secret'); // redacted for viewers
  });

  it('accepts, reports and removes the additional transport vars the form renders', async () => {
    // Slack Socket Mode's app-level token is rendered by the Channels form, so the
    // write endpoint must accept it — it used to 400 as an "unknown env var",
    // which made the one key that enables real-time inbound unwritable.
    const res = await authedFetch('/api/config/platforms/slack', 'POST', {
      values: { NUVIRA_SLACK_BOT_TOKEN: 'xoxb-app-test', NUVIRA_SLACK_APP_TOKEN: 'xapp-app-test' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      wrote: string[];
      status: { configured: boolean; envVars: Array<{ varName: string; set: boolean }> };
    };
    expect(body.ok).toBe(true);
    expect([...body.wrote].sort()).toEqual(['NUVIRA_SLACK_APP_TOKEN', 'NUVIRA_SLACK_BOT_TOKEN']);
    expect(body.status.configured).toBe(true);
    expect(body.status.envVars.find((v) => v.varName === 'NUVIRA_SLACK_APP_TOKEN')?.set).toBe(true);

    const del = await authedFetch('/api/config/platforms/slack', 'DELETE');
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { removed: string[] };
    expect(delBody.removed).toContain('NUVIRA_SLACK_APP_TOKEN');
    expect(readFileSync(envFile, 'utf-8')).not.toContain('NUVIRA_SLACK_APP_TOKEN');
  });

  it('rejects unknown env vars and unknown platforms (400)', async () => {
    const badVar = await authedFetch('/api/config/platforms/slack', 'POST', { values: { NOT_A_REAL_VAR: 'x' } });
    expect(badVar.status).toBe(400);
    const badPlatform = await authedFetch('/api/config/platforms/notreal', 'POST', { values: { X: 'y' } });
    expect(badPlatform.status).toBe(400);
    const whatsapp = await authedFetch('/api/config/platforms/whatsapp', 'POST', { values: { NUVIRA_WHATSAPP_SESSION_DIR: '/tmp/x' } });
    expect(whatsapp.status).toBe(400);
  });

  it('removes a platform config (DELETE) and updates the env file', async () => {
    const res = await authedFetch('/api/config/platforms/telegram', 'DELETE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: string[]; status: { configured: boolean } };
    expect(body.ok).toBe(true);
    expect(body.removed).toEqual(['NUVIRA_TELEGRAM_TOKEN']);
    expect(body.status.configured).toBe(false);
    expect(readFileSync(envFile, 'utf-8')).not.toContain('NUVIRA_TELEGRAM_TOKEN');
  });
});
