/**
 * Bundle 37/39/40 — GET /api/gates, /api/consent, /api/session-grants.
 *
 * Real HTTP against a server on a random port. `/api/gates` must summarize the
 * SAME reasoning-trace file the CLI reads (friction + narration), `/api/consent`
 * must render the one picture of what runs and what asks, and `/api/session-grants`
 * must report the live grants (empty on a fresh server, honestly).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-gates-api-'));
const configDir = join(testDir, '.nuvira');
const memoryDir = join(configDir, 'memory');
mkdirSync(memoryDir, { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = memoryDir;

// A minimal trace file: one verification gate, one confirmation refusal, and a
// final answer that reuses the harness's "state-changing" vocabulary.
writeFileSync(
  join(memoryDir, 'reasoning-traces.json'),
  JSON.stringify({
    traces: [
      {
        id: 't1',
        startedAt: 1,
        events: [
          { kind: 'gate', gate: 'verification', summary: 'the turn mutated the workspace and nothing observed the result' },
          {
            kind: 'refusal',
            gate: 'confirmation',
            tool: 'run_terminal',
            summary: 'declined until the user approves',
            result: 'run_terminal: the command is state-changing and needs explicit confirmation',
          },
        ],
        steps: [{ responsePreview: 'The command guard misfired on a state-changing read-only check.' }],
      },
    ],
  }),
  'utf-8',
);

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;

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

describe('gates / consent API', () => {
  it('summarizes gate friction and narration from the traces', async () => {
    const res = await fetch(`${baseUrl}/api/gates`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      traces: number;
      events: number;
      byGate: Array<{ key: string; count: number }>;
      narration: { turns: number };
    };
    expect(body.ok).toBe(true);
    expect(body.traces).toBe(1);
    expect(body.events).toBe(2);
    const keys = body.byGate.map((g) => g.key);
    expect(keys).toContain('gate:verification');
    expect(keys).toContain('refusal:confirmation');
    // The answer reused "state-changing" from the refusal text.
    expect(body.narration.turns).toBe(1);
  });

  it('serves the one consent picture', async () => {
    const res = await fetch(`${baseUrl}/api/consent`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      picture: { denied: { examples: unknown[] }; grantable: { examples: Array<{ action: string }> }; decided: { examples: unknown[] } };
    };
    expect(body.ok).toBe(true);
    expect(body.picture.denied.examples.length).toBeGreaterThan(0);
    expect(body.picture.decided.examples.length).toBeGreaterThan(0);
    expect(body.picture.grantable.examples.some((e) => e.action.includes('off-machine'))).toBe(true);
  });

  it('reports the live session grants (empty on a fresh server)', async () => {
    const res = await fetch(`${baseUrl}/api/session-grants`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; grants: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.grants)).toBe(true);
  });

  it('refuses a clear without a sessionId', async () => {
    const res = await fetch(`${baseUrl}/api/session-grants/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
