/**
 * Bundle 34 — GET /api/acceptance/export and POST /api/acceptance/import.
 *
 * The dashboard must ship and join the SAME corpus the CLI does: the export is a
 * download in JSON or CSV, and the import merges a posted file's TEXT (no multipart)
 * idempotently, refusing an empty or unparseable body.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-acc-transfer-'));
const configDir = join(testDir, '.nuvira');
mkdirSync(join(configDir, 'memory'), { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { beginTrace, recordTraceVerdict, recordTurnReport } = await import(
  '../../src/learning/reasoning-trace.js'
);

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;
  for (let i = 0; i < 3; i++) {
    const id = beginTrace({ goal: 'a turn', source: 'chat', provider: 'groq', model: 'm1' });
    recordTurnReport(id, { verification: i === 0 ? 'unverified' : 'verified', flags: {} } as never);
    recordTraceVerdict(id, i === 0 ? 'rejected' : 'accepted', 'cli');
  }
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

const postImport = (body: unknown): Promise<Response> =>
  fetch(`${baseUrl}/api/acceptance/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('acceptance export / import', () => {
  it('exports JSON with the labelled turns, and CSV with a header', async () => {
    const jsonRes = await fetch(`${baseUrl}/api/acceptance/export`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toMatch(/application\/json/);
    expect(jsonRes.headers.get('content-disposition')).toMatch(/attachment/);
    const parsed = (await jsonRes.json()) as { count: number; turns: unknown[] };
    expect(parsed.count).toBe(3);
    expect(parsed.turns).toHaveLength(3);

    const csvRes = await fetch(`${baseUrl}/api/acceptance/export?format=csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await csvRes.text();
    expect(text.split('\n')[0]).toMatch(/^traceId,provider,model,at,accepted,source,/);
  });

  it('imports a posted corpus idempotently', async () => {
    const exported = (await (await fetch(`${baseUrl}/api/acceptance/export`)).json()) as { turns: unknown[] };
    const payload = JSON.stringify({ turns: exported.turns });

    const first = (await (await postImport({ text: payload, format: 'json' })).json()) as {
      ok: boolean;
      imported: number;
      added: number;
      updated: number;
      total: number;
    };
    expect(first.ok).toBe(true);
    expect(first.imported).toBe(3);
    expect(first.added).toBe(3);

    const second = (await (await postImport({ text: payload, format: 'json' })).json()) as {
      added: number;
      updated: number;
      total: number;
    };
    expect(second.added).toBe(0);
    expect(second.updated).toBe(3);
    expect(second.total).toBe(3);
  });

  it('refuses an empty or unparseable body with 400', async () => {
    const empty = await postImport({ text: '   ' });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/corpus text/i);

    const junk = await postImport({ text: 'not json and not csv' });
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as { error: string }).error).toMatch(/no labelled turns/i);
  });
});
