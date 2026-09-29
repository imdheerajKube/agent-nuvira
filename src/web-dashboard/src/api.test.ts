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

describe('DashboardAPI.chatSend — WS5 (#27) isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A REAL isolated turn's response, captured from a live dashboard POST.
   *
   * The diff's two halves are the point: `files` is the changed PATHS (plain
   * strings), `payload` is the unified diff the card renders. An earlier guard
   * demanded `{path, body}` objects in `files` — which every real payload fails —
   * so the client silently dropped the whole report and the card never appeared.
   */
  const wireWorktree = {
    dir: '/tmp/profile/.nuvira/worktrees/create-a-file-mumhlf8t',
    base: 'b1dd713ae32d16bfb7af2adbf4c6e05e39b2e19c',
    removed: true,
    diff: {
      files: ['dashboard-isolated.txt'],
      summary: '1 file changed against b1dd713',
      unchanged: false,
      payload: {
        files: [{ path: 'dashboard-isolated.txt', body: '@@ -0,0 +1 @@\n+hello\n' }],
        summary: '1 file changed against b1dd713',
      },
    },
  };

  it('sends the isolation request, and keeps the worktree the server reported', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        sessionId: 's1',
        content: 'done',
        followups: [],
        provider: 'local',
        model: 'm',
        generationFailed: false,
        worktree: wireWorktree,
      }),
    );
    const api = new DashboardAPI('http://test');
    const r = await api.chatSend('s1', 'do it', { worktree: true, keepWorktree: true });

    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent.worktree).toBe(true);
    expect(sent.keepWorktree).toBe(true);

    // The report SURVIVES the guard, both halves of it — the paths for the reader
    // and the payload for the diff card.
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.worktree?.dir).toBe(wireWorktree.dir);
    expect(r.worktree?.base).toBe(wireWorktree.base);
    expect(r.worktree?.diff.files).toEqual(['dashboard-isolated.txt']);
    expect(r.worktree?.diff.payload.files[0].body).toContain('+hello');
  });

  it('sends NO isolation keys when the caller has no opinion, so the deployment still decides', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: true, sessionId: 's1', content: 'hi', followups: [], provider: null, model: null, generationFailed: false }),
    );
    const api = new DashboardAPI('http://test');
    await api.chatSend('s1', 'hello');
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    // Absent, not `false`: `false` is an explicit decline that outranks
    // `NUVIRA_ISOLATE` in the server's own resolution.
    expect('worktree' in sent).toBe(false);
    expect('keepWorktree' in sent).toBe(false);
    expect('resume' in sent).toBe(false);
  });

  it('drops a worktree report with no diff body rather than rendering an empty card', async () => {
    const truncated = { ...wireWorktree, diff: { files: ['a.txt'], summary: '1 file changed' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: true, sessionId: 's1', content: 'done', followups: [], provider: null, model: null, generationFailed: false, worktree: truncated }),
    );
    const api = new DashboardAPI('http://test');
    const r = await api.chatSend('s1', 'do it', { worktree: true });
    if (!r.ok) throw new Error('expected ok');
    // A card built from this would say "no changes" about a turn that changed a
    // file, so the report is refused and the turn reads as one that reported no
    // isolation — which is what a stale server actually sent.
    expect(r.worktree).toBeUndefined();
  });
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
