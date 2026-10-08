/**
 * Bundle 36 — GET /api/decisions and POST /api/decisions/revise.
 *
 * Real HTTP against a server on a random port. The page reads the SAME store the
 * CLI writes (`learning/decision-log.ts`), so the two surfaces cannot disagree;
 * the endpoints must report an empty log honestly, search by relevance, and
 * revise ONE record while keeping the previous answer in its history.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-decisions-api-'));
const configDir = join(testDir, '.nuvira');
const projectDir = join(testDir, 'proj');
mkdirSync(join(configDir, 'memory'), { recursive: true });
mkdirSync(projectDir, { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { recordDecision, readDecisions } = await import('../../src/learning/decision-log.js');

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
const q = (dir: string) => `dir=${encodeURIComponent(dir)}`;

async function getDecisions(dir: string, forText?: string) {
  const res = await fetch(`${baseUrl}/api/decisions?${q(dir)}${forText ? `&for=${encodeURIComponent(forText)}` : ''}`);
  return { res, body: (await res.json()) as { ok: boolean; dir: string; relevant: boolean; decisions: Array<{ id: string; answer: string }> } };
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

describe('decisions API', () => {
  it('reports an empty log honestly', async () => {
    const { res, body } = await getDecisions(projectDir);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.decisions).toEqual([]);
    expect(body.relevant).toBe(false);
  });

  it('lists a project decisions log and searches it by relevance', async () => {
    recordDecision({ question: 'Which database should the service use?', answer: 'SQLite', source: 'ask_user', dir: projectDir });
    recordDecision({ question: 'What colour should the logo be?', answer: 'blue', source: 'ask_user', dir: projectDir });

    const all = await getDecisions(projectDir);
    expect(all.body.decisions).toHaveLength(2);

    const relevant = await getDecisions(projectDir, 'migrate the service database');
    expect(relevant.body.relevant).toBe(true);
    const answers = relevant.body.decisions.map((d) => d.answer);
    expect(answers).toContain('SQLite');
    expect(answers).not.toContain('blue');
  });

  it('revises one decision and keeps the previous answer in history', async () => {
    const rec = recordDecision({ question: 'Which port?', answer: '3000', source: 'ask_user', dir: projectDir })!;
    const res = await fetch(`${baseUrl}/api/decisions/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: projectDir, id: rec.id, answer: '8080', note: 'collided' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: { id: string; answer: string; status: string; revisions?: Array<{ answer: string; note?: string }> } };
    expect(body.ok).toBe(true);
    expect(body.decision.answer).toBe('8080');
    expect(body.decision.status).toBe('revised');
    expect(body.decision.revisions?.[0]).toMatchObject({ answer: '8080', note: 'collided' });

    // Persisted on the project's own store.
    const stored = readDecisions(projectDir).find((d) => d.id === rec.id);
    expect(stored?.answer).toBe('8080');
  });

  it('rejects a revise with no id or answer, and 404s an unknown id', async () => {
    const bad = await fetch(`${baseUrl}/api/decisions/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: projectDir, id: '', answer: '' }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/decisions/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: projectDir, id: 'dec-nope', answer: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('falls back to the configured workspace for a dir that does not exist', async () => {
    const { res, body } = await getDecisions(join(testDir, 'does-not-exist'));
    expect(res.status).toBe(200);
    expect(typeof body.dir).toBe('string');
    expect(body.dir).not.toContain('does-not-exist');
  });
});
