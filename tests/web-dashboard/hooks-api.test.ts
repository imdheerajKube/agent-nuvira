/**
 * Hooks API — /api/hooks (GET vocabulary + declarations, PUT replace).
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * viewer for the RBAC gate), and NUVIRA_CONFIG_DIR pointing at a temp dir so the
 * writes land in an isolated `hooks.json`.
 *
 * The assertions that matter: validation happens on the SERVER (a bad
 * declaration is a 400 and the previous set stays in force), writes are
 * admin/operator only, and a saved hook is LIVE in the shared registry the tool
 * loop actually uses — not merely echoed back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-hooks-api-'));
const configDir = join(testDir, '.nuvira');
mkdirSync(join(configDir, 'memory'), { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { hooks } = await import('../../src/gateway/hooks.js');

const hooksFile = join(configDir, 'hooks.json');

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
  token = ((await setup.json()) as { token: string }).token;

  await authedFetch('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  viewerToken = ((await vLogin.json()) as { token: string }).token;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/hooks', () => {
  it('serves the contract vocabulary and an empty list (reads are open)', async () => {
    const res = await fetch(`${baseUrl}/api/hooks`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      ok: boolean;
      hooks: unknown[];
      events: string[];
      actionKinds: string[];
      eventDescriptions: Record<string, string>;
    };
    expect(d.ok).toBe(true);
    expect(d.hooks).toEqual([]);
    expect(d.events).toEqual(['before_tool_call', 'after_tool_call', 'failed_tool_call', 'on_session_end']);
    expect(d.actionKinds).toEqual(['deny', 'notify', 'scan-args']);
    expect(d.eventDescriptions.before_tool_call).toMatch(/DENY/);
  });

  it('requires auth to write: 401 unauthenticated, 403 for a viewer', async () => {
    const payload = { hooks: [{ id: 'x', label: 'x', event: 'before_tool_call', enabled: true, action: { kind: 'deny' } }] };
    expect((await fetch(`${baseUrl}/api/hooks`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(401);

    const forbidden = await authedFetch('/api/hooks', 'PUT', payload, viewerToken);
    expect(forbidden.status).toBe(403);
    expect(existsSync(hooksFile)).toBe(false);
  });

  it('saves a valid declaration, persists it, and makes it LIVE in the registry', async () => {
    const res = await authedFetch('/api/hooks', 'PUT', {
      hooks: [
        {
          id: 'block-rm-rf',
          label: 'Block rm -rf',
          event: 'before_tool_call',
          enabled: true,
          when: { tool: 'run_terminal', argsMatch: { command: 'rm -rf*' } },
          action: { kind: 'deny', reason: 'destructive command' },
        },
      ],
    });
    expect(res.status).toBe(200);

    // Persisted.
    expect(existsSync(hooksFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(hooksFile, 'utf-8')) as { hooks: Array<{ id: string }> };
    expect(onDisk.hooks.map((h) => h.id)).toEqual(['block-rm-rf']);

    // Round-trips through GET.
    const listed = (await (await fetch(`${baseUrl}/api/hooks`)).json()) as { hooks: Array<{ id: string }> };
    expect(listed.hooks.map((h) => h.id)).toEqual(['block-rm-rf']);

    // LIVE: the shared registry the tool loop uses vetoes the matching call and
    // leaves a non-matching one untouched.
    const denied = await hooks.runBefore({ tool: 'run_terminal', surface: 'cli-chat', args: { command: 'rm -rf /' } });
    expect(denied).toMatchObject({ deny: true, reason: 'destructive command', by: 'hook:block-rm-rf' });
    expect(await hooks.runBefore({ tool: 'read_file' })).toBeNull();
  });

  it('rejects an invalid declaration with 400 and keeps the previous set in force', async () => {
    const res = await authedFetch('/api/hooks', 'PUT', {
      hooks: [{ id: 'bad', label: 'bad', event: 'after_tool_call', enabled: true, action: { kind: 'deny' } }],
    });
    expect(res.status).toBe(400);
    const d = (await res.json()) as { ok: boolean; error: string };
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/deny is only available on before_tool_call/);

    // The earlier good set survives — the registry still blocks.
    expect(await hooks.runBefore({ tool: 'run_terminal', args: { command: 'rm -rf /' } })).toMatchObject({ deny: true });
  });

  it('rejects a duplicate id and a malformed body', async () => {
    const dup = await authedFetch('/api/hooks', 'PUT', {
      hooks: [
        { id: 'same', label: 'a', event: 'before_tool_call', enabled: true, action: { kind: 'notify', message: 'a' } },
        { id: 'same', label: 'b', event: 'after_tool_call', enabled: true, action: { kind: 'notify', message: 'b' } },
      ],
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toMatch(/duplicate hook id/);

    const bad = await authedFetch('/api/hooks', 'PUT', { hooks: 'nope' });
    expect(bad.status).toBe(400);
  });
});
