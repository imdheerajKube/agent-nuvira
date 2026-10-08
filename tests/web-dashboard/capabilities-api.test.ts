/**
 * Bundle 48 — GET /api/capabilities.
 *
 * Real HTTP against a server on a random port. The endpoint must serve the SAME
 * read-model the CLI/module builds: every curated verb with a readiness verdict,
 * the aggregated missing executables, and the per-OS command for this machine.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-capabilities-api-'));
const configDir = join(testDir, '.nuvira');
const memoryDir = join(configDir, 'memory');
mkdirSync(memoryDir, { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = memoryDir;

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { capabilityReadiness } = await import('../../src/learning/capability-readiness.js');

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

describe('GET /api/capabilities', () => {
  it('serves the readiness read-model, matching the module', async () => {
    const res = await fetch(`${baseUrl}/api/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      verbs: Array<{ ref: string; ready: boolean; gaps: string[] }>;
      missingExecutables: unknown[];
      readyCount: number;
      blockedCount: number;
    };
    expect(body.ok).toBe(true);
    const expected = capabilityReadiness();
    expect(body.verbs.map((v) => v.ref).sort()).toEqual(expected.verbs.map((v) => v.ref).sort());
    expect(body.readyCount).toBe(expected.readyCount);
    expect(body.blockedCount).toBe(expected.blockedCount);
    expect(Array.isArray(body.missingExecutables)).toBe(true);
  });
});
