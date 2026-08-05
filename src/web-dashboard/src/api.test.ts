/**
 * Unit tests for DashboardAPI.fetchAll() — the initial-data bootstrap path
 * every dashboard panel falls back to when SSE hasn't delivered a snapshot yet.
 *
 * Regression coverage for the reported "Failed to execute 'json' on
 * 'Response': Unexpected token '<'" crash: a STALE dashboard server (older
 * version missing newer routes) answers /api/all with the SPA index.html
 * (HTTP 200, text/html). fetchAll() must degrade to null (App waits for the
 * next SSE snapshot) instead of throwing.
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

describe('DashboardAPI.fetchAll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a real JSON /api/all response', async () => {
    const payload = { serverTime: Date.now(), cost: { totalRequests: 0 } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));

    const api = new DashboardAPI('http://test');
    const data = await api.fetchAll();
    expect(data).toMatchObject(payload);
  });

  it('returns null (no crash) when the server answers /api/all with HTML (stale server)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());

    const api = new DashboardAPI('http://test');
    // Must NOT throw — previously res.json() threw "Unexpected token '<'".
    const data = await api.fetchAll();
    expect(data).toBeNull();
  });

  it('returns null on HTTP non-ok and on malformed JSON bodies', async () => {
    const notOk = new Response('nope', { status: 500, headers: { 'Content-Type': 'application/json' } });
    const malformed = new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(notOk)
      .mockResolvedValueOnce(malformed);

    const api = new DashboardAPI('http://test');
    expect(await api.fetchAll()).toBeNull();
    expect(await api.fetchAll()).toBeNull();
  });
});
