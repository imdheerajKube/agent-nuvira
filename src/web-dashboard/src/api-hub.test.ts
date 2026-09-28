/**
 * Agent Hub API client tests (I4 + I5).
 *
 * fetchHub() — the aggregated read the hub panel polls. setToolsetEnabled()
 * — the admin-gated write (PUT /api/admin/hub/toolsets/<name>) that persists
 * the toggle to buffconfig. Both follow the same stale-server contract as the
 * other dashboard fetches: HTML-200 / malformed / network failure degrade to
 * null or { ok:false }, never a crash.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DashboardAPI, setAdminToken } from './api';
import type { HubData } from './types';

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const htmlResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

const HUB_PAYLOAD: HubData = {
  toolsets: {
    toolsets: [
      { name: 'core', label: 'Core', description: 'Pipeline actions', enabled: true, tools: ['build'], toolCount: 1 },
      { name: 'web', label: 'Web research', description: 'Search + read', enabled: true, tools: ['web_search'], toolCount: 1 },
    ],
    enabled: 2,
    disabled: 0,
    totalTools: 2,
  },
  channels: {
    delivery: { total: 1, pending: 1, sent: 0, failed: 0, recent: [] },
    aliases: [],
    reachable: [],
    platforms: [
      { platform: 'email', label: 'Email (SMTP)', configured: false, envVars: ['BUFF_SMTP_HOST', 'BUFF_SMTP_USER'] },
      { platform: 'signal', label: 'Signal (signal-cli-rest-api)', configured: true, envVars: ['BUFF_SIGNAL_ACCOUNT'] },
    ],
    policies: {},
    contacts: [],
    statusRecipients: [],
    statusRecipientDisplay: {},
    inbox: { total: 0, pipeline: 0, chat: 0, help: 0, refused: 0, duplicate: 0, attachmentFailed: 0, recent: [] },
  },
  artifacts: { totalSessions: 0, totalArtifacts: 0, sessions: [] },
  skills: { compiled: [], hub: [], total: 0, enabled: 0, disabled: 0 },
  subagents: { total: 0, running: 0, failed: 0, recent: [] },
  adminConfigured: false,
  serverTime: 123,
};

describe('DashboardAPI.fetchHub', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a real /api/hub response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(HUB_PAYLOAD));
    const api = new DashboardAPI('http://test');
    const data = await api.fetchHub();
    expect(data).not.toBeNull();
    expect(data!.toolsets.toolsets).toHaveLength(2);
    expect(data!.adminConfigured).toBe(false);
  });

  it('returns null when the payload lacks the toolsets array (stale server shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ serverTime: 1 }));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchHub()).toBeNull();
  });

  it('returns null on an HTML answer (stale server) — no crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
    const api = new DashboardAPI('http://test');
    expect(await api.fetchHub()).toBeNull();
  });

  it('returns null on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchHub()).toBeNull();
  });
});

describe('DashboardAPI.setToolsetEnabled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAdminToken(null);
  });

  it('PUTs { enabled } to the admin route with the bearer token', async () => {
    setAdminToken('tok-123');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, toolset: 'web', enabled: false }));
    const api = new DashboardAPI('http://test');

    const r = await api.setToolsetEnabled('web', false);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test/api/admin/hub/toolsets/web');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('surfaces 401 as unauthorized (session expired)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Not authenticated' }, 401));
    const api = new DashboardAPI('http://test');
    const r = await api.setToolsetEnabled('web', true);
    expect(r.ok).toBe(false);
    expect(r.unauthorized).toBe(true);
  });

  it('surfaces 403 as forbidden (role cannot change capabilities)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Access denied' }, 403));
    const api = new DashboardAPI('http://test');
    const r = await api.setToolsetEnabled('web', true);
    expect(r.ok).toBe(false);
    expect(r.forbidden).toBe(true);
  });

  it('returns a friendly error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const api = new DashboardAPI('http://test');
    const r = await api.setToolsetEnabled('web', true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Could not reach');
  });
});
