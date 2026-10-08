/**
 * Trace verdict API — POST /api/traces/:id/verdict.
 *
 * Real HTTP against a server on a random port, with NUVIRA_MEMORY_DIR pointing at
 * a temp dir so the trace and the quality corpus are written somewhere isolated.
 *
 * The assertions that matter: the verdict lands on the turn it is about, an
 * EXPLICIT acceptance labels the matching corpus row (the positive class the
 * derived correction signal can never produce), and bad input is refused rather
 * than silently recorded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-verdict-api-'));
const configDir = join(testDir, '.nuvira');
mkdirSync(join(configDir, 'memory'), { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { beginTrace, endTrace } = await import('../../src/learning/reasoning-trace.js');
const { recordDeliverableCandidate, readDeliverableCandidates } = await import(
  '../../src/learning/deliverable-corpus.js'
);

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;

const postVerdict = (id: string, body: unknown): Promise<Response> =>
  fetch(`${baseUrl}/api/traces/${encodeURIComponent(id)}/verdict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('POST /api/traces/:id/verdict', () => {
  it('records the verdict on the turn and returns it', async () => {
    const id = beginTrace({ goal: 'write a guide to queues', source: 'chat' });
    endTrace(id, true);

    const res = await postVerdict(id, { verdict: 'accepted' });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean; rated: { traceId: string; verdict: string; source: string } };
    expect(d.ok).toBe(true);
    expect(d.rated).toMatchObject({ traceId: id, verdict: 'accepted', source: 'dashboard' });

    // And it is READABLE back on the detail endpoint the Trace tab uses.
    const detail = (await (await fetch(`${baseUrl}/api/traces/${encodeURIComponent(id)}`)).json()) as {
      userVerdict?: { verdict: string; source: string };
    };
    expect(detail.userVerdict).toMatchObject({ verdict: 'accepted', source: 'dashboard' });
  });

  it('labels the matching quality-corpus row — the positive class', async () => {
    const id = beginTrace({ goal: 'write a guide to queues', source: 'chat' });
    endTrace(id, true);
    recordDeliverableCandidate(
      { ask: 'write a guide', path: 'GUIDE.md', deliveredWords: 5100, excerpt: 'x', traceId: id },
      1,
    );
    const res = await postVerdict(id, { verdict: 'accepted' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rated: { corpusLabeled: boolean } }).rated.corpusLabeled).toBe(true);
    expect(readDeliverableCandidates().find((r) => r.traceId === id)?.verdict).toBe('accepted');
  });

  it('refuses a bad verdict with 400 rather than recording something', async () => {
    const id = beginTrace({ goal: 'x', source: 'chat' });
    endTrace(id, true);
    const res = await postVerdict(id, { verdict: 'maybe' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/accepted/);
  });

  it('404s an unknown trace instead of inventing a verdict', async () => {
    const res = await postVerdict('trace-does-not-exist', { verdict: 'rejected' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
