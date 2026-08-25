/**
 * Admin command-runner fetch tests (Session 17).
 *
 * fetchAdminChecks() drives the dashboard's /api/admin/checks endpoint — the
 * on-demand execution of ALL state commands (doctor system + enterprise
 * checks + masked provider summary). Regression coverage for the same
 * parseJsonOrNull contract every other dashboard fetch uses: a stale server
 * answering HTML must degrade to null, never crash.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DashboardAPI } from './api';

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const htmlResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

const VALID_PAYLOAD = {
  system: [{ name: 'Config Directory', status: 'pass', message: '~/.nuvira/ exists' }],
  enterprise: [{ name: 'Secrets Backend', status: 'warn', message: 'keys in config' }],
  providers: [{ type: 'groq', configured: true, keySource: 'env', keyMasked: 'gsk_…abcd' }],
  serverTime: 123,
};

describe('DashboardAPI.fetchAdminChecks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a real /api/admin/checks response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(VALID_PAYLOAD));
    const api = new DashboardAPI('http://test');
    const data = await api.fetchAdminChecks();
    expect(data).toMatchObject({ serverTime: 123 });
    expect(data!.system[0].status).toBe('pass');
    expect(data!.providers[0].keySource).toBe('env');
  });

  it('returns null when the server answers HTML (stale server) — no crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
    const api = new DashboardAPI('http://test');
    const data = await api.fetchAdminChecks();
    expect(data).toBeNull();
  });

  it('returns null when the payload lacks the checks arrays', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ serverTime: 1 }));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchAdminChecks()).toBeNull();
  });

  it('returns null when the payload lacks the providers array (panel would crash on .length)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      system: [],
      enterprise: [],
      serverTime: 1,
    }));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchAdminChecks()).toBeNull();
  });

  it('returns null on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchAdminChecks()).toBeNull();
  });
});
