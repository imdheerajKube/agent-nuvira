/**
 * Process Environment API — /api/process-env (+ /delete).
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * viewer for the RBAC gate), and NUVIRA_ENV_FILE pointing at a temp file so the
 * writes stay hermetic.
 *
 * The assertions worth having here are the ones that separate "a curated page"
 * from "a generic env editor with a nicer label":
 *
 *   - a name OFF the allowlist is refused, so this endpoint cannot be used to
 *     append an arbitrary variable to the credential `.env`;
 *   - a value is stored in the CANONICAL spelling its own reader understands
 *     (`NUVIRA_STRICT_MODEL=true` reads as OFF, so `true` must not be stored);
 *   - the file value and the in-process value are reported apart, because
 *     `loadEnv()` lets a shell export outrank the file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-process-env-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });
const envFile = join(testDir, 'env', 'test.env');

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
process.env.NUVIRA_ENV_FILE = envFile;

/**
 * The curated switches are read by the RUNNING server, so a value sitting in the
 * developer's shell would silently change what these assertions observe.
 * Cleared BEFORE the server is created, because `createDashboardServer()` calls
 * `loadEnv()` — which copies file values in but never overrides what is already
 * in the environment.
 */
const ENV_TO_CLEAR = [
  'NUVIRA_ISOLATE',
  'NUVIRA_RESUME',
  'NUVIRA_SESSION_STORE',
  'NUVIRA_SESSION_RECALL',
  'NUVIRA_STRICT_MODEL',
  'NUVIRA_DEBUG_LOG',
  'NUVIRA_OTEL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'NUVIRA_TOOL_HOOK_BEFORE',
  'NUVIRA_TOOL_HOOK_AFTER',
  'NUVIRA_TOOL_HOOK_FAILED',
];
for (const name of ENV_TO_CLEAR) delete process.env[name];

/**
 * The allowlist, in the order the server reports it. Note that
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is deliberately absent: it is a standard
 * OpenTelemetry name rather than one of ours, so it is read (to clear the
 * "nowhere to send spans" warning) but never written by this endpoint.
 */
const CURATED = [
  'NUVIRA_ISOLATE',
  'NUVIRA_RESUME',
  'NUVIRA_SESSION_STORE',
  'NUVIRA_SESSION_RECALL',
  'NUVIRA_EXTRACT_MAX_CHARS',
  'NUVIRA_ATTACHMENT_MAX_BYTES',
  'NUVIRA_CAPABILITY_MODE',
  'NUVIRA_WORK_DIGEST',
  'NUVIRA_STRICT_MODEL',
  'NUVIRA_DEBUG_LOG',
  'NUVIRA_OTEL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'NUVIRA_TOOL_HOOK_BEFORE',
  'NUVIRA_TOOL_HOOK_AFTER',
  'NUVIRA_TOOL_HOOK_FAILED',
];

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

interface Row {
  name: string;
  state: 'on' | 'off' | 'set' | 'unset';
  fileValue: string | null;
  processValue: string | null;
  shadowed: boolean;
  warning?: string;
}

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';

function authedFetch(path: string, method = 'GET', body?: unknown, tok = token): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function rowOf(name: string): Promise<Row> {
  const res = await authedFetch('/api/process-env');
  const body = (await res.json()) as { ok: boolean; vars: Row[] };
  const row = body.vars.find((r) => r.name === name);
  expect(row, `${name} should be on the curated list`).toBeTruthy();
  return row!;
}

function envFileText(): string {
  return existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '';
}

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const setup = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'test-password-123' }),
  });
  const setupData = (await setup.json()) as { token?: string };
  expect(setupData.token).toBeTruthy();
  token = setupData.token as string;

  const addViewer = await authedFetch('/api/admin/users', 'POST', {
    user: 'viewer',
    password: 'viewer-pass-123',
    role: 'viewer',
  });
  expect(addViewer.status).toBe(200);
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  const vData = (await vLogin.json()) as { token?: string };
  viewerToken = vData.token as string;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/process-env — the curated list', () => {
  it('rejects unauthenticated requests (401)', async () => {
    expect((await fetch(`${baseUrl}/api/process-env`)).status).toBe(401);
    const post = await fetch(`${baseUrl}/api/process-env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NUVIRA_OTEL', value: '1' }),
    });
    expect(post.status).toBe(401);
    const del = await fetch(`${baseUrl}/api/process-env/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NUVIRA_OTEL' }),
    });
    expect(del.status).toBe(401);
  });

  it('returns every curated switch with both of its values, all unset to begin', async () => {
    const res = await authedFetch('/api/process-env');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; vars: Row[] };
    expect(body.ok).toBe(true);
    expect(body.vars.map((v) => v.name)).toEqual(CURATED);
    for (const row of body.vars) {
      expect(row.state).toBe('unset');
      expect(row.fileValue).toBeNull();
      expect(row.shadowed).toBe(false);
    }
  });

  it('refuses a name that is not on the allowlist, and writes nothing', async () => {
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_SNEAKY_VALUE', value: '1' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('unknown-name');
    expect(body.error).toContain('curated');
    expect(envFileText()).not.toContain('NUVIRA_SNEAKY_VALUE');

    // Deleting an off-list name is a write wearing a different verb.
    const del = await authedFetch('/api/process-env/delete', 'POST', { name: 'NUVIRA_SNEAKY_VALUE' });
    expect(del.status).toBe(400);
  });

  it('viewer can read but not write (403)', async () => {
    const read = await authedFetch('/api/process-env', 'GET', undefined, viewerToken);
    expect(read.status).toBe(200);
    const write = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_OTEL', value: '1' }, viewerToken);
    expect(write.status).toBe(403);
    const del = await authedFetch('/api/process-env/delete', 'POST', { name: 'NUVIRA_OTEL' }, viewerToken);
    expect(del.status).toBe(403);
    expect(envFileText()).not.toContain('NUVIRA_OTEL');
  });
});

describe('/api/process-env — values are stored in the spelling their reader reads', () => {
  it('stores `1` for a switch, whatever truthy word the user typed', async () => {
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_ISOLATE', value: 'true' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; saved: { value: string }; row: Row };
    expect(body.ok).toBe(true);
    expect(body.saved.value).toBe('1');
    expect(body.row.state).toBe('on');
    expect(body.row.fileValue).toBe('1');
    expect(envFileText()).toContain('NUVIRA_ISOLATE=1');
  });

  it('stores `0` for off, which every one of these readers understands as off', async () => {
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_ISOLATE', value: 'no' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: Row };
    expect(body.row.state).toBe('off');
    expect(envFileText()).toContain('NUVIRA_ISOLATE=0');
  });

  it('refuses `true` for NUVIRA_STRICT_MODEL, which only the literal `1` enables', async () => {
    // The whole reason the canonical spelling exists: `strictModelMode()` compares
    // to '1', so storing `true` would show a switch as on while the run ignores it.
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_STRICT_MODEL', value: 'please' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason: string; error: string };
    expect(body.reason).toBe('not-a-flag');
    expect(body.error).toContain('on (1, true, yes, on)');
    expect(envFileText()).not.toContain('NUVIRA_STRICT_MODEL');

    const ok = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_STRICT_MODEL', value: '1' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { row: Row }).row.state).toBe('on');
  });

  it('accepts a checkpoint id for NUVIRA_RESUME, and reports it as the active resume it is', async () => {
    // `resolveResumeRequest`: anything that is not ''/0/false NAMES a record, so a
    // stored id is an ON state, not an unreadable value.
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_RESUME', value: 'chat-abc123' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: Row };
    expect(body.row.state).toBe('on');
    expect(body.row.fileValue).toBe('chat-abc123');
    expect(envFileText()).toContain('NUVIRA_RESUME=chat-abc123');
  });

  it('refuses an empty value and a value carrying a newline', async () => {
    const empty = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_TOOL_HOOK_BEFORE', value: '   ' });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { reason: string }).reason).toBe('empty');

    // A newline would append a SECOND variable to the file, so it is refused
    // rather than trimmed away.
    const multi = await authedFetch('/api/process-env', 'POST', {
      name: 'NUVIRA_TOOL_HOOK_BEFORE',
      value: 'node ~/hook.mjs\nNUVIRA_OTEL=1',
    });
    expect(multi.status).toBe(400);
    expect(((await multi.json()) as { reason: string }).reason).toBe('multiline');
    expect(envFileText()).not.toContain('NUVIRA_TOOL_HOOK_BEFORE');
  });

  it('stores a hook command, and unsetting removes the line', async () => {
    const set = await authedFetch('/api/process-env', 'POST', {
      name: 'NUVIRA_TOOL_HOOK_BEFORE',
      value: 'node ~/deny-shell.mjs',
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { row: Row };
    expect(setBody.row.state).toBe('set');
    expect(envFileText()).toContain('NUVIRA_TOOL_HOOK_BEFORE=node ~/deny-shell.mjs');

    const del = await authedFetch('/api/process-env/delete', 'POST', { name: 'NUVIRA_TOOL_HOOK_BEFORE' });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { ok: boolean; removed: boolean; row: Row };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toBe(true);
    expect(delBody.row.state).toBe('unset');
    expect(envFileText()).not.toContain('NUVIRA_TOOL_HOOK_BEFORE');
  });

  it('applies a written value to the running process, so the row stops shadowing', async () => {
    const res = await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_DEBUG_LOG', value: '1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: Row };
    expect(body.row.processValue).toBe('1');
    expect(body.row.shadowed).toBe(false);
    expect(process.env.NUVIRA_DEBUG_LOG).toBe('1');
  });
});

describe('/api/process-env — the file is not the whole truth', () => {
  it('reports a process value that disagrees with the file as shadowing it', async () => {
    // `loadEnv()` never overrides an existing variable, so a value in the shell
    // wins for the dashboard AND for every CLI run in that shell. The page has to
    // say so, or "set it to 0" looks like it worked while export stays on.
    await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_OTEL', value: '0' });
    process.env.NUVIRA_OTEL = '1';

    const row = await rowOf('NUVIRA_OTEL');
    expect(row.fileValue).toBe('0');
    expect(row.processValue).toBe('1');
    expect(row.shadowed).toBe(true);
    // `state` stays the file's state: the file is what this page owns and writes.
    expect(row.state).toBe('off');

    delete process.env.NUVIRA_OTEL;
  });

  it('warns when export is on with no endpoint, because the spans are then dropped', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_OTEL', value: '1' });

    const on = await rowOf('NUVIRA_OTEL');
    expect(on.warning).toContain('no OTLP endpoint is set');

    // Naming an endpoint clears it — the warning is about the combination, not
    // about the variable.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const withEndpoint = await rowOf('NUVIRA_OTEL');
    expect(withEndpoint.warning).toBeUndefined();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('leaves a switch that is off unwarned', async () => {
    await authedFetch('/api/process-env', 'POST', { name: 'NUVIRA_OTEL', value: '0' });
    const off = await rowOf('NUVIRA_OTEL');
    expect(off.state).toBe('off');
    expect(off.warning).toBeUndefined();
  });
});
