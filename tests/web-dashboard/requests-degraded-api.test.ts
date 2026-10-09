/**
 * GET /api/requests — the DERIVED degraded census.
 *
 * The panel's per-pair error rate comes from the hash-chained action log, which
 * records that a provider ANSWERED — so a weak model's unusable reply books as
 * `verified` and reads 0.0%. The correction cannot be an appended log entry
 * (`origin` is only live|test, so it would look exactly like a real provider
 * call), so the truth is DERIVED, read-only, from the traces. This test pins
 * that the census rides on the SAME endpoint the panel reads and that the
 * misleading row is left intact (the measurement is qualified, not rewritten).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-requests-degraded-'));
const configDir = join(testDir, '.nuvira');
const memoryDir = join(configDir, 'memory');
mkdirSync(memoryDir, { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MEMORY_DIR = memoryDir;

// The action-telemetry log the error rate comes from: the weak pair ANSWERED
// (outcome `verified`), so its row reads 0.0% — exactly the counter-signal.
writeFileSync(
  join(memoryDir, 'model-registry-actions.jsonl'),
  JSON.stringify({
    timestamp: Date.now(),
    action: 'chat',
    provider: 'local',
    model: 'qwen2.5:0.5b',
    outcome: 'verified',
    latencyMs: 5946,
  }) + '\n',
  'utf-8',
);

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');
const { beginTrace, recordStep, endTrace } = await import('../../src/learning/reasoning-trace.js');

const step = (provider: string, model: string) => ({
  agentType: 'chat',
  provider,
  model,
  promptDigest: 'd1',
  promptPreview: 'p',
  responsePreview: 'r',
  responseLength: 1,
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 1,
  success: true,
});

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

describe('GET /api/requests — degraded census', () => {
  it('derives the weak pair from the traces and carries it beside the rows', async () => {
    const a = beginTrace({ goal: 'fix the add-document button', source: 'chat', provider: 'gemini' });
    recordStep(a, step('gemini', 'gemma-4-31b-it'));
    recordStep(a, step('local', 'qwen2.5:0.5b'));
    endTrace(a, true);
    const b = beginTrace({ goal: 'another ask', source: 'chat', provider: 'gemini' });
    recordStep(b, step('local', 'qwen2.5:0.5b'));
    endTrace(b, true);

    const body = (await (await fetch(`${baseUrl}/api/requests`)).json()) as {
      degraded: Array<{ provider: string; model: string; steps: number; traces: string[] }>;
      rows: Array<{ provider: string; model: string; action: string; errorRate: number }>;
    };

    expect(body.degraded).toEqual([
      { provider: 'local', model: 'qwen2.5:0.5b', steps: 2, traces: [a, b] },
    ]);
    // An agentic-capable pair is never reported.
    expect(body.degraded.some((d) => d.model === 'gemma-4-31b-it')).toBe(false);
    // The measurement is NOT rewritten — the row is still 0.0%; the census is
    // what qualifies it.
    const row = body.rows.find((r) => r.model === 'qwen2.5:0.5b');
    expect(row).toBeDefined();
    expect(row!.errorRate).toBe(0);
  });

  it('reports an empty census when the traces only served agentic-capable pairs', async () => {
    const { clearTraces } = await import('../../src/learning/reasoning-trace.js');
    clearTraces();
    const c = beginTrace({ goal: 'build a web app', source: 'chat', provider: 'groq' });
    recordStep(c, step('groq', 'openai/gpt-oss-120b'));
    endTrace(c, true);

    const body = (await (await fetch(`${baseUrl}/api/requests`)).json()) as { degraded: unknown[] };
    expect(body.degraded).toEqual([]);
  });
});
