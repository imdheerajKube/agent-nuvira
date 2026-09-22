/**
 * Forced first-run password change — the gate that makes a published default
 * credential safe.
 *
 * A fresh install bootstraps admin/admin so a GUI-first user has zero setup.
 * That pair is public, so the account is deliberately crippled: while the flag
 * is set, EVERY mutating admin route is refused (403 `password_change_required`)
 * and only change-password/logout stay reachable. This suite proves the gate
 * actually covers a real write route, and that changing the password lifts it.
 *
 * Real HTTP against a server on a random port, hermetic config dir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-admin-default-gate-'));
const configDir = join(testDir, '.nuvira');
mkdirSync(join(configDir, 'memory'), { recursive: true });

// Env MUST be set before importing the server (read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.HOME = testDir;
delete process.env.NUVIRA_DASHBOARD_ADMIN_PASSWORD;
delete process.env.BUFF_DASHBOARD_ADMIN_PASSWORD;

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { writeAdminUser } = await import('../../src/web-dashboard/src/admin-auth.js');

let server: ReturnType<typeof createDashboardServer>;
let baseUrl = '';

/** POST an admin route with a Bearer token; returns status + parsed body. */
async function adminPost(
  path: string,
  token: string | null,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function login(user: string, password: string): Promise<string | null> {
  const { status, body } = await adminPost('/api/admin/login', null, { user, password });
  return status === 200 && typeof body.token === 'string' ? body.token : null;
}

beforeAll(async () => {
  // Bootstrap exactly what the CLI does on a fresh install.
  writeAdminUser('admin', 'admin', 'admin', configDir, { mustChangePassword: true });
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
    server.server.listen(0, '127.0.0.1');
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.server.close(() => resolve()));
  rmSync(testDir, { recursive: true, force: true });
});

describe('forced first-run password change', () => {
  it('reports the flag on auth-status so the GUI can force the change', async () => {
    const token = await login('admin', 'admin');
    expect(token).toBeTruthy();

    const res = await fetch(`${baseUrl}/api/admin/auth-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.mustChangePassword).toBe(true);
  });

  it('refuses a real mutating admin route with 403 while the default stands', async () => {
    const token = await login('admin', 'admin');
    const { status, body } = await adminPost('/api/admin/users', token, {
      user: 'sneaky',
      password: 'a-real-password-1',
      role: 'admin',
    });
    expect(status).toBe(403);
    expect(body.code).toBe('password_change_required');
  });

  it('leaves logout reachable while the gate is up', async () => {
    const token = await login('admin', 'admin');
    const { status } = await adminPost('/api/admin/logout', token);
    expect(status).toBe(200);
  });

  it('rejects a wrong current password and a too-short new one', async () => {
    const token = await login('admin', 'admin');

    const wrong = await adminPost('/api/admin/change-password', token, {
      currentPassword: 'not-admin',
      newPassword: 'a-real-password-1',
    });
    expect(wrong.status).toBe(401);

    const short = await adminPost('/api/admin/change-password', token, {
      currentPassword: 'admin',
      newPassword: 'short',
    });
    expect(short.status).toBe(400);

    // Neither attempt may have lifted the gate.
    const still = await adminPost('/api/admin/users', token, {
      user: 'sneaky',
      password: 'a-real-password-1',
      role: 'viewer',
    });
    expect(still.status).toBe(403);
  });

  it('changing the password lifts the gate for the same session', async () => {
    const token = await login('admin', 'admin');
    const change = await adminPost('/api/admin/change-password', token, {
      currentPassword: 'admin',
      newPassword: 'a-real-password-1',
    });
    expect(change.status).toBe(200);

    const after = await adminPost('/api/admin/users', token, {
      user: 'later-user',
      password: 'another-password-1',
      role: 'viewer',
    });
    expect(after.status).toBe(200);
  });

  it('the published default no longer authenticates', async () => {
    expect(await login('admin', 'admin')).toBeNull();
    expect(await login('admin', 'a-real-password-1')).toBeTruthy();
  });
});
