/**
 * Service-provider config API — /api/admin/services.
 *
 * Real HTTP against a server on a random port, file-based admin auth (admin +
 * viewer for the RBAC gate), and NUVIRA_ENV_FILE pointing at a temp file so
 * service-key writes stay hermetic. Verifies the section is not cosmetic: a
 * saved key lands in the env file the agent reads, is redacted for viewers, and
 * a keyless service is not writable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-svccfg-api-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });
const envFile = join(testDir, 'env', 'test.env');

// Service keys that might leak in from the outer environment — cleared so the
// assertions are deterministic (the env file is the only source we write).
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'TAVILY_API_KEY', 'GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_ID', 'STABILITY_API_KEY', 'FAL_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'BUFF_IMAGE_API_URL', 'SEARXNG_URL', 'JINA_API_KEY']) {
  delete process.env[k];
}

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
process.env.NUVIRA_ENV_FILE = envFile;

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

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

interface ServiceRow {
  id: string;
  label: string;
  capability: string;
  keyless: boolean;
  configured: boolean;
  envVars: Array<{ varName: string; set: boolean; value: string; secret: boolean }>;
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
  token = setupData.token as string;

  await authedFetch('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  const vLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  viewerToken = ((await vLogin.json()) as { token?: string }).token as string;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('/api/admin/services', () => {
  it('rejects unauthenticated reads (401)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/services`);
    expect(res.status).toBe(401);
  });

  it('lists the service catalog grouped by capability', async () => {
    const res = await authedFetch('/api/admin/services');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; services: ServiceRow[] };
    expect(body.ok).toBe(true);
    const ids = body.services.map((s) => s.id);
    expect(ids).toContain('image-gemini'); // Nano Banana
    expect(ids).toContain('image-stability');
    expect(ids).toContain('video-fal');
    expect(ids).toContain('search-brave');
    expect(ids).toContain('search-tavily');
    expect(ids).toContain('vision-gemini');
    expect(ids).toContain('speech-elevenlabs');
    const caps = new Set(body.services.map((s) => s.capability));
    expect(caps).toEqual(new Set(['image', 'video', 'search', 'vision', 'speech']));
    // Nothing configured yet in the hermetic env file.
    expect(body.services.find((s) => s.id === 'image-gemini')!.configured).toBe(false);
    // Keyless services are always ready.
    expect(body.services.find((s) => s.id === 'image-pollinations')!.configured).toBe(true);
  });

  it('writes a service key to the env file and flips it to configured', async () => {
    const res = await authedFetch('/api/admin/services/image-gemini', 'PUT', {
      values: { GEMINI_API_KEY: 'gemini-secret-key' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; wrote: string[]; service: ServiceRow };
    expect(body.ok).toBe(true);
    expect(body.wrote).toEqual(['GEMINI_API_KEY']);
    expect(body.service.configured).toBe(true);
    expect(readFileSync(envFile, 'utf-8')).toContain('GEMINI_API_KEY=gemini-secret-key');
  });

  it('redacts values for a viewer read while reporting them set', async () => {
    const res = await authedFetch('/api/admin/services', 'GET', undefined, viewerToken);
    const body = (await res.json()) as { services: ServiceRow[] };
    const gemini = body.services.find((s) => s.id === 'image-gemini')!;
    expect(gemini.envVars[0].set).toBe(true);
    expect(gemini.envVars[0].value).not.toContain('gemini-secret-key');
  });

  it('viewer cannot write a service key (403)', async () => {
    const res = await authedFetch('/api/admin/services/search-brave', 'PUT', { values: { BRAVE_SEARCH_API_KEY: 'x' } }, viewerToken);
    expect(res.status).toBe(403);
  });

  it('requires ALL vars for a multi-var service (Google CSE)', async () => {
    const partial = await authedFetch('/api/admin/services/search-google-cse', 'PUT', {
      values: { GOOGLE_CSE_API_KEY: 'gkey' },
    });
    const partialBody = (await partial.json()) as { service: ServiceRow };
    expect(partialBody.service.configured).toBe(false);

    const full = await authedFetch('/api/admin/services/search-google-cse', 'PUT', {
      values: { GOOGLE_CSE_API_KEY: 'gkey', GOOGLE_CSE_ID: 'cx123' },
    });
    const fullBody = (await full.json()) as { service: ServiceRow };
    expect(fullBody.service.configured).toBe(true);
  });

  it('rejects writes to a keyless service and unknown ids/vars', async () => {
    const keyless = await authedFetch('/api/admin/services/image-pollinations', 'PUT', { values: { X: 'y' } });
    expect(keyless.status).toBe(400);
    const unknownId = await authedFetch('/api/admin/services/not-a-service', 'PUT', { values: { X: 'y' } });
    expect(unknownId.status).toBe(404);
    const unknownVar = await authedFetch('/api/admin/services/search-brave', 'PUT', { values: { NOT_A_REAL_VAR: 'x' } });
    expect(unknownVar.status).toBe(400);
  });

  it('removes a service key (DELETE) from the env file', async () => {
    const res = await authedFetch('/api/admin/services/image-gemini', 'DELETE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: string[]; service: ServiceRow };
    expect(body.ok).toBe(true);
    expect(body.removed).toEqual(['GEMINI_API_KEY']);
    expect(body.service.configured).toBe(false);
    expect(readFileSync(envFile, 'utf-8')).not.toContain('GEMINI_API_KEY');
  });

  // ─── Test connection (per-service reachability probe) ───────────────────

  it('reports Not configured before a required key is saved', async () => {
    const res = await authedFetch('/api/admin/services/search-brave/test', 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Not configured/);
  });

  it('probes a keyless service without a network call (ok)', async () => {
    const res = await authedFetch('/api/admin/services/image-pollinations/test', 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail?: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toMatch(/always available/);
  });

  it('viewer cannot run a probe (403)', async () => {
    const res = await authedFetch('/api/admin/services/image-pollinations/test', 'POST', undefined, viewerToken);
    expect(res.status).toBe(403);
  });

  it('rejects a probe for an unknown service (404)', async () => {
    const res = await authedFetch('/api/admin/services/not-a-service/test', 'POST');
    expect(res.status).toBe(404);
  });
});

/**
 * Dashboard workspace — /api/admin/workspace.
 *
 * The directory an UNATTACHED chat turn runs in. The point of the endpoints is
 * that the fallback stops being accidental: unset is a real, reported state
 * (the chat then asks for a folder), a configured path must exist, and a viewer
 * cannot repoint it.
 */
describe('/api/admin/workspace — the unattached-turn workspace', () => {
  const projectDir = join(testDir, 'workspace-fixture');
  mkdirSync(projectDir, { recursive: true });

  beforeAll(() => {
    // A clean slate: NUVIRA_CONFIG_DIR is hermetic, so no real config is touched.
    expect(viewerToken).toBeTruthy();
  });

  it('reports "unset" as a real state, not an empty string', async () => {
    const res = await authedFetch('/api/admin/workspace', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      configured: string | null;
      effective: string | null;
      processCwd: string;
      configuredValid: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.configured).toBeNull();
    expect(body.effective).toBeNull();
    // processCwd is named so an operator can see what "unset" would mean.
    expect(typeof body.processCwd).toBe('string');
    expect(body.processCwd.length).toBeGreaterThan(0);
  });

  it('refuses a path that is not a directory (400)', async () => {
    const res = await authedFetch('/api/admin/workspace', 'PUT', { cwd: '/no/such/dir-xyz-123' });
    expect(res.status).toBe(400);
    // …and the rejection did not half-apply.
    const after = (await (await authedFetch('/api/admin/workspace', 'GET')).json()) as { effective: string | null };
    expect(after.effective).toBeNull();
  });

  it('saves a real directory and reports it as effective', async () => {
    const res = await authedFetch('/api/admin/workspace', 'PUT', { cwd: projectDir });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; configured: string; effective: string; configuredValid: boolean };
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(projectDir);
    expect(body.effective).toBe(projectDir);
    expect(body.configuredValid).toBe(true);

    const after = (await (await authedFetch('/api/admin/workspace', 'GET')).json()) as { effective: string | null };
    expect(after.effective).toBe(projectDir);
  });

  it('clears back to "ask for a folder" with an empty value', async () => {
    const res = await authedFetch('/api/admin/workspace', 'PUT', { cwd: '' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; configured: null; effective: null };
    expect(body.configured).toBeNull();
    expect(body.effective).toBeNull();
  });

  it('surfaces the configured workspace to the project picker as kind "cwd"', async () => {
    await authedFetch('/api/admin/workspace', 'PUT', { cwd: projectDir });
    const res = await authedFetch('/api/projects', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      configuredCwd: string | null;
      projects: Array<{ path: string; kind: string }>;
    };
    expect(body.configuredCwd).toBe(projectDir);
    expect(body.projects.some((p) => p.kind === 'cwd' && p.path === projectDir)).toBe(true);
    await authedFetch('/api/admin/workspace', 'PUT', { cwd: '' });
  });

  it('viewer cannot change the workspace (403)', async () => {
    const res = await authedFetch('/api/admin/workspace', 'PUT', { cwd: projectDir }, viewerToken);
    expect(res.status).toBe(403);
  });
});

/**
 * Response cache, by workspace — /api/admin/cache.
 *
 * A cached answer is a statement about the folder it was produced in, so the
 * dashboard has to show WHERE each answer came from and clear one project
 * without discarding another's still-correct answers.
 */
describe('/api/admin/cache — answers grouped by workspace', () => {
  const repoA = join(testDir, 'cache-repo-a');
  const repoB = join(testDir, 'cache-repo-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  /** Seed entries through the same cache the agent writes (shared file). */
  async function seed(): Promise<void> {
    const { getCache } = await import('../../src/context/cache.js');
    const cache = getCache();
    await cache.clear();
    await cache.set('status of this project', 'answer for A', 'gemini-flash', 'gemini', undefined, repoA);
    await cache.set('add a test', 'answer for B', 'gpt-4o', 'openai', undefined, repoB);
    await cache.set('what is 2 + 2', 'four', 'gemini-flash', 'gemini');
  }

  it('requires a session (prompt previews are conversation content)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/cache`);
    expect(res.status).toBe(401);
  });

  it('lists each workspace with its own answers', async () => {
    await seed();
    const res = await authedFetch('/api/admin/cache', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      total: number;
      workspaces: Array<{ scope: string | null; count: number; samples: Array<{ prompt: string }> }>;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(3);

    const scopes = body.workspaces.map((w) => w.scope);
    expect(scopes).toContain(repoA);
    expect(scopes).toContain(repoB);
    // The unscoped bucket is a workspace like any other, reported as null.
    expect(scopes).toContain(null);

    const a = body.workspaces.find((w) => w.scope === repoA)!;
    expect(a.count).toBe(1);
    expect(a.samples[0].prompt).toContain('status of this project');
  });

  it('clears ONE workspace and leaves the others cached', async () => {
    await seed();
    const res = await authedFetch('/api/admin/cache/clear', 'POST', { scope: repoB });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: number; scope: string | null };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(1);
    expect(body.scope).toBe(repoB);

    const after = (await (await authedFetch('/api/admin/cache', 'GET')).json()) as {
      total: number;
      workspaces: Array<{ scope: string | null }>;
    };
    expect(after.total).toBe(2);
    expect(after.workspaces.map((w) => w.scope)).not.toContain(repoB);
    expect(after.workspaces.map((w) => w.scope)).toContain(repoA);
  });

  it('clears the no-workspace bucket when scope is null', async () => {
    await seed();
    const res = await authedFetch('/api/admin/cache/clear', 'POST', { scope: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number };
    expect(body.removed).toBe(1);

    const after = (await (await authedFetch('/api/admin/cache', 'GET')).json()) as {
      workspaces: Array<{ scope: string | null }>;
    };
    expect(after.workspaces.map((w) => w.scope)).not.toContain(null);
  });

  it('rejects a request with no scope key rather than clearing the wrong set', async () => {
    const res = await authedFetch('/api/admin/cache/clear', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('viewer cannot clear the cache (403)', async () => {
    await seed();
    const res = await authedFetch('/api/admin/cache/clear', 'POST', { scope: repoA }, viewerToken);
    expect(res.status).toBe(403);
    // …and nothing was removed.
    const after = (await (await authedFetch('/api/admin/cache', 'GET')).json()) as { total: number };
    expect(after.total).toBe(3);
    const { getCache } = await import('../../src/context/cache.js');
    await getCache().clear();
  });
});
