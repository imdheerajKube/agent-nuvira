/**
 * MCP config API — /api/mcp, /api/mcp/settings, /api/mcp/install, /api/mcp/uninstall.
 *
 * WHAT THIS PINS DOWN. The dashboard's MCP surface must write the SAME
 * `buffconfig.json` `mcp.*` section the CLI writes, through the same parser, and
 * must never echo a secret back. Real HTTP against a server on a random port,
 * with NUVIRA_CONFIG_DIR / NUVIRA_MCP_DIR pointed at temp dirs so no user config
 * is read or written, and file-based admin auth (admin + viewer) for the gate.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-mcp-api-'));
const configDir = join(testDir, '.nuvira');
const mcpDir = join(configDir, 'mcp');
mkdirSync(mcpDir, { recursive: true });

process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = join(configDir, 'memory');
process.env.NUVIRA_CONFIG_DIR = configDir;
process.env.NUVIRA_MCP_DIR = mcpDir;
// The probes read the process environment; make the github variant deterministic
// regardless of what the developer has exported.
const savedGithubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

const { createDashboardServer } = await import('../../src/web-dashboard/server.js');

let baseUrl = '';
let server: ReturnType<typeof createDashboardServer>;
let token = '';
let viewerToken = '';

const authed = (path: string, method = 'GET', body?: unknown, tok = token): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

interface SettingsBody {
  ok: boolean;
  settings: { enabled: boolean; maxToolsTotal: number; subagentInheritance: string; servers: Record<string, unknown> };
}
interface McpBody {
  ok: boolean;
  configDir: string;
  settings: SettingsBody['settings'];
  servers: Array<{ name: string; envKeys: string[]; headerKeys: string[]; origin: string; variant: string | null }>;
  catalog: Array<{
    name: string;
    installed: boolean;
    offers: string[];
    variants: Array<{ id: string; optIn: boolean; status: { ok: boolean; problems: string[] } }>;
  }>;
}

const readConfig = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(configDir, 'buffconfig.json'), 'utf-8')) as Record<string, unknown>;

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
  token = ((await setup.json()) as { token: string }).token;

  await authed('/api/admin/users', 'POST', { user: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'viewer', password: 'viewer-pass-123' }),
  });
  viewerToken = ((await login.json()) as { token: string }).token;
});

afterAll(() => {
  server.server.close();
  if (server.ipv6Twin) server.ipv6Twin.close();
  if (savedGithubToken !== undefined) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedGithubToken;
  rmSync(testDir, { recursive: true, force: true });
});

describe('GET /api/mcp', () => {
  it('requires authentication', async () => {
    expect((await fetch(`${baseUrl}/api/mcp`)).status).toBe(401);
  });

  it('returns the resolved settings, the configured servers and the catalog', async () => {
    const res = await authed('/api/mcp');
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpBody;
    expect(body.ok).toBe(true);
    // The SAME defaults the CLI reports.
    expect(body.settings.subagentInheritance).toBe('conservative');
    expect(body.settings.maxToolsPerServer).toBe(15);
    expect(body.configDir).toBe(mcpDir);
    // Catalog slots with their variants, including the opt-in rule.
    const github = body.catalog.find((e) => e.name === 'github');
    expect(github).toBeTruthy();
    expect(github!.variants.find((v) => v.id === 'local-binary')?.optIn).toBe(true);
    expect(github!.variants.find((v) => v.id === 'remote')?.optIn).toBe(false);
    expect(body.catalog.find((e) => e.name === 'fetch')?.variants.map((v) => v.id).sort()).toEqual([
      'docker',
      'npx',
      'uvx',
    ]);
  });

  it('never returns a secret value — only env KEY NAMES', async () => {
    // A HAND-WRITTEN server (as any user may have), so this assertion does not
    // depend on the install path having run first.
    writeFileSync(
      join(mcpDir, 'handwritten.json'),
      JSON.stringify({
        name: 'handwritten',
        transport: 'sse',
        url: 'https://example.invalid/mcp',
        headers: { Authorization: 'Bearer ghp_super_secret_value' },
        env: { SOME_TOKEN: 'another_secret_value' },
        enabled: true,
      }),
      'utf-8',
    );
    const res = await authed('/api/mcp');
    const text = await res.text();
    expect(text).not.toContain('ghp_super_secret_value');
    expect(text).not.toContain('another_secret_value');
    expect(text).not.toContain('Bearer ');
    const body = JSON.parse(text) as McpBody;
    const handwritten = body.servers.find((s) => s.name === 'handwritten');
    expect(handwritten?.envKeys).toEqual(['SOME_TOKEN']);

    rmSync(join(mcpDir, 'handwritten.json'), { force: true });
  });
});

describe('POST /api/mcp/settings', () => {
  it('refuses a viewer token (the gate matches the other capability writes)', async () => {
    const res = await authed('/api/mcp/settings', 'POST', { patch: [{ key: 'mcp.maxToolsTotal', value: '30' }] }, viewerToken);
    expect(res.status).toBe(403);
  });

  it('writes the same mcp.* section the CLI writes, into buffconfig.json', async () => {
    const res = await authed('/api/mcp/settings', 'POST', {
      patch: [
        { key: 'mcp.maxToolsTotal', value: '25' },
        { key: 'mcp.subagent.inherit', value: 'full' },
        { key: 'mcp.servers.context7.runtime.command', value: '/opt/node20/bin/node' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.settings.maxToolsTotal).toBe(25);
    expect(body.settings.subagentInheritance).toBe('full');

    const onDisk = readConfig().mcp as {
      maxToolsTotal: number;
      subagent: { inherit: string };
      servers: Record<string, { runtime?: { command?: string } }>;
    };
    expect(onDisk.maxToolsTotal).toBe(25);
    expect(onDisk.subagent.inherit).toBe('full');
    expect(onDisk.servers.context7.runtime?.command).toBe('/opt/node20/bin/node');
  });

  it('refuses values the CLI would refuse (one validator, two surfaces)', async () => {
    for (const patch of [
      [{ key: 'mcp.subagent.inherit', value: 'everything' }],
      [{ key: 'mcp.maxToolsTotal', value: 'lots' }],
      [{ key: 'mcp.nope', value: '1' }],
      [{ key: 'mcp.servers.github.nope', value: '1' }],
    ]) {
      const res = await authed('/api/mcp/settings', 'POST', { patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error.length).toBeGreaterThan(0);
    }
    // …and the refused values did not land in the file.
    expect((readConfig().mcp as { subagent?: { inherit?: string } }).subagent?.inherit).toBe('full');
  });
});

describe('POST /api/mcp/install', () => {
  it('refuses a viewer token', async () => {
    const res = await authed('/api/mcp/install', 'POST', { name: 'memory' }, viewerToken);
    expect(res.status).toBe(403);
  });

  it('rejects a name that is not in the catalog', async () => {
    const res = await authed('/api/mcp/install', 'POST', { name: 'not-a-server' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not in the catalog');
  });

  it('refuses when a prerequisite is missing, naming the dependency and not writing', async () => {
    // No token in the environment (cleared above) and none supplied here.
    const res = await authed('/api/mcp/install', 'POST', { name: 'github' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(existsSync(join(mcpDir, 'github.json'))).toBe(false);
  });

  it('installs the remote variant when the token is supplied, and reports no secret back', async () => {
    const res = await authed('/api/mcp/install', 'POST', {
      name: 'github',
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_from_dashboard' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('ghp_from_dashboard');
    const body = JSON.parse(text) as { ok: boolean; variantId: string; path: string };
    expect(body.ok).toBe(true);
    expect(body.variantId).toBe('remote');

    const written = JSON.parse(readFileSync(join(mcpDir, 'github.json'), 'utf-8')) as {
      transport: string;
      headers: Record<string, string>;
    };
    expect(written.transport).toBe('sse');
    expect(written.headers.Authorization).toBe('Bearer ghp_from_dashboard');
  });

  it('says the config is already installed rather than overwriting it', async () => {
    const res = await authed('/api/mcp/install', 'POST', {
      name: 'github',
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_again' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toContain('already installed');
  });
});

describe('POST /api/mcp/uninstall', () => {
  it('removes an installed server and reports an absent one honestly', async () => {
    const removed = await authed('/api/mcp/uninstall', 'POST', { name: 'github' });
    expect(removed.status).toBe(200);
    expect(existsSync(join(mcpDir, 'github.json'))).toBe(false);

    const missing = await authed('/api/mcp/uninstall', 'POST', { name: 'github' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { reason: string }).reason).toContain('not installed');
  });
});

/**
 * The Claude-Desktop-parity path: the dashboard configures a server that is NOT
 * in the catalog, through the same validator/writer the CLI's `mcp add` uses.
 * Anything the page can add must therefore be a config the CLI would accept —
 * and vice versa.
 */
describe('POST /api/mcp/servers (a server that is not in the catalog)', () => {
  afterEach(() => {
    rmSync(join(mcpDir, 'my-private-server.json'), { force: true });
    rmSync(join(mcpDir, 'vendor-remote.json'), { force: true });
    rmSync(join(mcpDir, 'not-a-server.json'), { force: true });
  });

  it('refuses a viewer token', async () => {
    const res = await authed(
      '/api/mcp/servers',
      'POST',
      { name: 'my-private-server', command: 'node' },
      viewerToken,
    );
    expect(res.status).toBe(403);
    expect(existsSync(join(mcpDir, 'my-private-server.json'))).toBe(false);
  });

  it('creates a stdio server and never echoes the credential back', async () => {
    const res = await authed('/api/mcp/servers', 'POST', {
      name: 'my-private-server',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/servers/mine.mjs', '--stdio'],
      env: { MY_SUPER_SECRET: 'super_secret_value' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('super_secret_value');
    const body = JSON.parse(text) as { ok: boolean; path: string; overwrote?: boolean };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(join(mcpDir, 'my-private-server.json'));

    // The file is the ordinary shape discovery reads — and it is 0600.
    const written = JSON.parse(readFileSync(join(mcpDir, 'my-private-server.json'), 'utf-8')) as {
      transport: string;
      command: string;
      enabled: boolean;
      env: Record<string, string>;
    };
    expect(written.transport).toBe('stdio');
    expect(written.command).toBe('node');
    expect(written.enabled).toBe(true);
    expect(written.env.MY_SUPER_SECRET).toBe('super_secret_value');
    if (process.platform !== 'win32') {
      expect(statSync(join(mcpDir, 'my-private-server.json')).mode & 0o777).toBe(0o600);
    }

    // …and the READ route reports it as configured, with the key NAME only.
    const view = (await (await authed('/api/mcp')).json()) as McpBody;
    const server = view.servers.find((s) => s.name === 'my-private-server');
    expect(server).toBeTruthy();
    expect(server!.envKeys).toEqual(['MY_SUPER_SECRET']);
    expect(server!.origin).toBe('custom');
  });

  it('creates a remote server with headers and no command', async () => {
    const res = await authed('/api/mcp/servers', 'POST', {
      name: 'vendor-remote',
      transport: 'sse',
      url: 'https://mcp.vendor.example/http',
      headers: { Authorization: 'Bearer vendor_token_value' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('vendor_token_value');
    const written = JSON.parse(readFileSync(join(mcpDir, 'vendor-remote.json'), 'utf-8')) as {
      transport: string;
      url: string;
      headers: Record<string, string>;
      command?: string;
    };
    expect(written.transport).toBe('sse');
    expect(written.url).toBe('https://mcp.vendor.example/http');
    expect(written.headers.Authorization).toBe('Bearer vendor_token_value');
    expect(written.command).toBeUndefined();
  });

  it('refuses a name that would write outside the config directory', async () => {
    const res = await authed('/api/mcp/servers', 'POST', {
      name: '../escaped',
      command: 'node',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a usable server name/);
    expect(existsSync(join(testDir, 'escaped.json'))).toBe(false);
  });

  it('refuses a spec with nothing to run, or with both shapes at once', async () => {
    for (const body of [
      { name: 'not-a-server' },
      { name: 'not-a-server', command: 'node', url: 'https://a.example/mcp' },
      { name: 'not-a-server', transport: 'sse' },
    ]) {
      const res = await authed('/api/mcp/servers', 'POST', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(mcpDir, 'not-a-server.json'))).toBe(false);
  });

  it('says the server already exists rather than overwriting it', async () => {
    await authed('/api/mcp/servers', 'POST', { name: 'my-private-server', command: 'node' });
    const res = await authed('/api/mcp/servers', 'POST', {
      name: 'my-private-server',
      command: 'python3',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/already configured/);
    expect(
      (JSON.parse(readFileSync(join(mcpDir, 'my-private-server.json'), 'utf-8')) as { command: string }).command,
    ).toBe('node');
  });

  it('overwrite replaces the config but keeps a credential the page was never shown', async () => {
    await authed('/api/mcp/servers', 'POST', {
      name: 'my-private-server',
      command: 'node',
      env: { TOKEN: 'kept_secret' },
    });
    const res = await authed('/api/mcp/servers', 'POST', {
      name: 'my-private-server',
      command: 'node20',
      env: { TOKEN: '' },
      overwrite: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; overwrote: boolean };
    expect(body.overwrote).toBe(true);
    const written = JSON.parse(readFileSync(join(mcpDir, 'my-private-server.json'), 'utf-8')) as {
      command: string;
      env: Record<string, string>;
    };
    expect(written.command).toBe('node20');
    expect(written.env.TOKEN).toBe('kept_secret');
  });

  it('uninstalls a hand-written server through the same route as a catalog one', async () => {
    await authed('/api/mcp/servers', 'POST', { name: 'my-private-server', command: 'node' });
    const removed = await authed('/api/mcp/uninstall', 'POST', { name: 'my-private-server' });
    expect(removed.status).toBe(200);
    expect(existsSync(join(mcpDir, 'my-private-server.json'))).toBe(false);
  });
});
