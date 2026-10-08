/**
 * Bundle 32 — GET /api/acceptance.
 *
 * Real HTTP against a server on a random port with an isolated memory dir. The
 * endpoint must report the corpus honestly: the labelled counts and per-pair
 * record, and a fit that stays untrained below the floor rather than printing a
 * number. It is the SAME `acceptanceSummary` the CLI renders, so the surfaces
 * cannot disagree.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-acceptance-api-'));
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

function seed(accepted: boolean, provider: string, model: string, verification: string): void {
  const id = beginTrace({ goal: 'a turn', source: 'chat', provider, model });
  recordTurnReport(id, { verification, flags: {} } as never);
  recordTraceVerdict(id, accepted ? 'accepted' : 'rejected', 'cli');
}

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

describe('GET /api/acceptance', () => {
  it('reports an untrained fit below the floor, and never a number', async () => {
    seed(true, 'groq', 'm1', 'verified');
    seed(false, 'groq', 'm1', 'unverified');

    const res = await fetch(`${baseUrl}/api/acceptance`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      labelled: number;
      accepted: number;
      rejected: number;
      byPair: Record<string, { accepted: number; rejected: number }>;
      fit: { ok: boolean; reason?: string; n: number };
    };
    expect(d.labelled).toBe(2);
    expect(d.accepted).toBe(1);
    expect(d.rejected).toBe(1);
    expect(d.byPair['groq/m1']).toEqual({ accepted: 1, rejected: 1 });
    expect(d.fit.ok).toBe(false);
    expect(d.fit.reason).toMatch(/labelled turn/);
  });

  it('trains once both classes clear the floor', async () => {
    for (let i = 0; i < 12; i++) seed(true, 'groq', 'm1', 'verified');
    for (let i = 0; i < 12; i++) seed(false, 'gemini', 'm2', 'unverified');

    const res = await fetch(`${baseUrl}/api/acceptance`);
    const d = (await res.json()) as {
      labelled: number;
      fit: { ok: boolean; n: number; positives: number; negatives: number; weights?: number[] };
    };
    expect(d.labelled).toBe(26);
    expect(d.fit.ok).toBe(true);
    expect(d.fit.n).toBe(26);
    expect(d.fit.positives).toBe(13);
    expect(d.fit.negatives).toBe(13);
    expect(Array.isArray(d.fit.weights)).toBe(true);
  });
});
