/**
 * Custom MCP servers (`src/mcp/custom-server.ts`) — the "configuration, not
 * code" path that `nuvira mcp add` and the dashboard's add form both call.
 *
 * Hermetic: every test uses a temp config dir (never `~/.nuvira`), nothing
 * spawns a subprocess, and the one integration test only READS the directory
 * discovery scans — it never connects.
 *
 * The claim under test is not "a validator exists" but: a server this project
 * has never heard of can be written from a name plus a command, is then found by
 * the REAL discovery path, and can be redirected or disabled by configuration
 * alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SERVER_NAME_MAX,
  carriesSecret,
  readServerConfig,
  serverOrigin,
  validateServerSpec,
  writeServerConfig,
} from '../../src/mcp/custom-server.js';
import { MCP_CATALOG } from '../../src/mcp/catalog.js';
import { MCPManager } from '../../src/mcp/manager.js';
import type { MCPServerConfig } from '../../src/mcp/types.js';

let root = '';
let mcpDir = '';

beforeEach(() => {
  // <root>/mcp is the MCP dir and <root>/buffconfig.json is the settings file
  // MCPManager derives from it — the same layout as a real install.
  root = mkdtempSync(join(tmpdir(), 'buff-custom-mcp-'));
  mcpDir = join(root, 'mcp');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Validate-or-throw: a broken fixture must fail inside the test that made it. */
function mustValidate(spec: unknown) {
  const result = validateServerSpec(spec);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function mustRefuse(spec: unknown): string {
  const result = validateServerSpec(spec);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.config)}`);
  return result.error;
}

describe('validateServerSpec — a name that is safe as a filename AND a settings key', () => {
  it('accepts a stdio server and keeps exactly the fields discovery reads', () => {
    const { config, warnings } = mustValidate({
      name: 'my-server_1',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/mine.mjs', '--stdio'],
      env: { TOKEN: 'abc' },
    });
    expect(config).toEqual({
      name: 'my-server_1',
      transport: 'stdio',
      enabled: true,
      command: 'node',
      args: ['/opt/mine.mjs', '--stdio'],
      env: { TOKEN: 'abc' },
    });
    expect(warnings).toEqual([]);
  });

  it('accepts a remote server and infers the transport from the url', () => {
    const { config } = mustValidate({
      name: 'vendor',
      url: 'https://mcp.vendor.example/http',
      headers: { Authorization: 'Bearer sk-live' },
    });
    expect(config.transport).toBe('sse');
    expect(config.url).toBe('https://mcp.vendor.example/http');
    expect(config.headers).toEqual({ Authorization: 'Bearer sk-live' });
  });

  it('refuses a name that would escape the config dir or become unmanageable', () => {
    // Each of these would either write outside the MCP dir or produce a server
    // that `mcp.servers.<name>` can never address, because that grammar is
    // dot-separated.
    for (const name of ['../evil', 'a/b', 'a.b', 'nested/../x', '..']) {
      const error = mustRefuse({ name, command: 'node' });
      expect(error, name).toMatch(/not a usable server name/);
    }
  });

  it('refuses an empty, over-long or space-bearing name', () => {
    expect(mustRefuse({ name: '   ', command: 'node' })).toMatch(/name is required/);
    expect(mustRefuse({ name: 'a'.repeat(SERVER_NAME_MAX + 1), command: 'node' })).toMatch(/limit is 64/);
    expect(mustRefuse({ name: 'my server', command: 'node' })).toMatch(/not a usable server name/);
  });

  it('refuses a spec with nothing to run, or with both shapes at once', () => {
    expect(mustRefuse({ name: 'x' })).toMatch(/Nothing to run/);
    expect(mustRefuse({ name: 'x', command: 'node', url: 'https://a.example/mcp' })).toMatch(
      /either a command .* or a url/,
    );
    expect(mustRefuse({ name: 'x', transport: 'stdio', url: 'https://a.example/mcp' })).toMatch(
      /stdio needs a command/,
    );
    expect(mustRefuse({ name: 'x', transport: 'sse', command: 'node' })).toMatch(/sse needs a url/);
  });

  it('refuses a url that is not http(s), and warns when it is plain http', () => {
    expect(mustRefuse({ name: 'x', transport: 'sse', url: 'file:///etc/passwd' })).toMatch(/must be http\(s\)/);
    expect(mustRefuse({ name: 'x', transport: 'sse', url: 'not a url' })).toMatch(/not a valid URL/);
    const { warnings } = mustValidate({ name: 'x', transport: 'sse', url: 'http://insecure.example/mcp' });
    expect(warnings.join(' ')).toMatch(/plain http/);
  });

  it('refuses field/transport mismatches instead of writing a field that would be ignored', () => {
    expect(mustRefuse({ name: 'x', command: 'node', headers: { 'X-A': '1' } })).toMatch(
      /headers only apply to a remote/,
    );
    expect(mustRefuse({ name: 'x', transport: 'sse', url: 'https://a.example/mcp', args: ['-y'] })).toMatch(
      /sse takes no args/,
    );
  });

  it('checks env and header key shapes, and strings that contain control characters', () => {
    expect(mustRefuse({ name: 'x', command: 'node', env: { 'bad-key': 'v' } })).toMatch(
      /not a valid environment variable name/,
    );
    expect(mustRefuse({ name: 'x', command: 'node', env: { TOKEN: 42 } })).toMatch(/must be a string/);
    expect(mustRefuse({ name: 'x', command: 'node\nrm -rf /' })).toMatch(/command must be a non-empty string/);
    expect(mustRefuse({ name: 'x', command: 'node', args: ['ok', 'bad\narg'] })).toMatch(
      /control character/,
    );
    expect(
      mustRefuse({ name: 'x', transport: 'sse', url: 'https://a.example/mcp', headers: { Authorization: 'a\nb' } }),
    ).toMatch(/control character/);
  });

  it('bounds args and env so a shell loop cannot write an absurd config', () => {
    expect(mustRefuse({ name: 'x', command: 'node', args: Array.from({ length: 65 }, () => 'a') })).toMatch(
      /limit is 64/,
    );
    const env = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']));
    expect(mustRefuse({ name: 'x', command: 'node', env })).toMatch(/limit is 64/);
  });

  it('warns when the name is also a catalog capability (and still writes it)', () => {
    const catalogName = MCP_CATALOG[0]!.name;
    const { config, warnings } = mustValidate({ name: catalogName, command: 'node' });
    expect(config.name).toBe(catalogName);
    expect(warnings.join(' ')).toMatch(/also a catalog capability/);
  });

  it('honours an explicit enabled:false and refuses a non-boolean', () => {
    expect(mustValidate({ name: 'x', command: 'node', enabled: false }).config.enabled).toBe(false);
    expect(mustRefuse({ name: 'x', command: 'node', enabled: 'yes' })).toMatch(/must be true or false/);
  });
});

describe('writeServerConfig — one file, named exactly what discovery scans', () => {
  it('writes the config and is found by the REAL discovery path', () => {
    const { config } = mustValidate({ name: 'hand-rolled', command: 'node', args: ['/opt/srv.mjs'] });
    const result = writeServerConfig(config, { configDir: mcpDir });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(mcpDir, 'hand-rolled.json'));

    const discovered = new MCPManager(mcpDir).discoverConfigs();
    expect(discovered.map((c) => c.name)).toContain('hand-rolled');
    expect(discovered.find((c) => c.name === 'hand-rolled')?.command).toBe('node');
  });

  it('refuses to clobber an existing config unless forced, and leaves it alone', () => {
    const first = mustValidate({ name: 'x', command: 'node' }).config;
    expect(writeServerConfig(first, { configDir: mcpDir }).ok).toBe(true);

    const second = mustValidate({ name: 'x', command: 'python3' }).config;
    const refused = writeServerConfig(second, { configDir: mcpDir });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/already configured/);
    expect(readServerConfig('x', mcpDir)?.command).toBe('node');

    const forced = writeServerConfig(second, { configDir: mcpDir, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.overwrote).toBe(true);
    expect(readServerConfig('x', mcpDir)?.command).toBe('python3');
  });

  it('an exact rewrite names the credentials it replaced instead of dropping them silently', () => {
    writeServerConfig(
      mustValidate({ name: 'x', command: 'node', env: { TOKEN: 'secret', OTHER: 'kept' } }).config,
      { configDir: mcpDir },
    );
    const result = writeServerConfig(mustValidate({ name: 'x', command: 'node' }).config, {
      configDir: mcpDir,
      force: true,
    });
    expect(result.droppedEnvKeys).toEqual(['TOKEN', 'OTHER']);
  });

  it('an EDIT (mergeEnv) keeps credentials it was never allowed to read back', () => {
    writeServerConfig(
      mustValidate({
        name: 'vendor',
        transport: 'sse',
        url: 'https://a.example/mcp',
        headers: { Authorization: 'Bearer secret' },
      }).config,
      { configDir: mcpDir },
    );
    // The page can only send the header NAME (values never leave the server), so
    // a rewrite must keep the value it cannot see.
    const result = writeServerConfig(
      mustValidate({ name: 'vendor', transport: 'sse', url: 'https://b.example/mcp', headers: { 'X-Trace': '1' } })
        .config,
      { configDir: mcpDir, force: true, mergeEnv: true },
    );
    expect(result.ok).toBe(true);
    const stored = readServerConfig('vendor', mcpDir);
    expect(stored?.url).toBe('https://b.example/mcp');
    expect(stored?.headers).toEqual({ Authorization: 'Bearer secret', 'X-Trace': '1' });
    expect(result.warnings?.join(' ')).toMatch(/Kept the credentials/);
  });

  it('an EDIT keeps the fields a page cannot represent: oauth, variant, runtime', () => {
    writeServerConfig(
      {
        name: 'gmail',
        transport: 'sse',
        enabled: true,
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        headers: { Authorization: 'Bearer old' },
        oauth: { tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: 'cid', scopes: ['a'] },
        variant: 'remote',
        runtime: { command: '/opt/node20/bin/node' },
      },
      { configDir: mcpDir },
    );
    const result = writeServerConfig(
      mustValidate({ name: 'gmail', transport: 'sse', url: 'https://gmailmcp.googleapis.com/mcp/v2' }).config,
      { configDir: mcpDir, force: true, mergeEnv: true },
    );
    expect(result.ok).toBe(true);
    const stored = readServerConfig('gmail', mcpDir);
    // The field the edit actually changed…
    expect(stored?.url).toBe('https://gmailmcp.googleapis.com/mcp/v2');
    // …and everything the page has no control over, still intact.
    expect(stored?.oauth?.clientId).toBe('cid');
    expect(stored?.variant).toBe('remote');
    expect(stored?.runtime?.command).toBe('/opt/node20/bin/node');
    expect(stored?.headers?.Authorization).toBe('Bearer old');
  });

  it('a transport switch through an edit drops the other transport’s fields', () => {
    writeServerConfig(
      { name: 'x', transport: 'stdio', enabled: true, command: 'node', args: ['a'] },
      { configDir: mcpDir },
    );
    writeServerConfig(mustValidate({ name: 'x', transport: 'sse', url: 'https://a.example/mcp' }).config, {
      configDir: mcpDir,
      force: true,
      mergeEnv: true,
    });
    const remote = readServerConfig('x', mcpDir);
    expect(remote?.transport).toBe('sse');
    // A leftover `command` on a remote config means two things at once.
    expect(remote?.command).toBeUndefined();
    expect(remote?.args).toBeUndefined();

    writeServerConfig(mustValidate({ name: 'x', command: 'node' }).config, {
      configDir: mcpDir,
      force: true,
      mergeEnv: true,
    });
    const local = readServerConfig('x', mcpDir);
    expect(local?.transport).toBe('stdio');
    expect(local?.url).toBeUndefined();
    expect(local?.headers).toBeUndefined();
  });

  it('an exact rewrite reports an OAuth block it removed', () => {
    writeServerConfig(
      {
        name: 'gmail',
        transport: 'sse',
        enabled: true,
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        oauth: { tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: 'cid' },
      },
      { configDir: mcpDir },
    );
    const result = writeServerConfig(
      mustValidate({ name: 'gmail', transport: 'sse', url: 'https://x.example/mcp' }).config,
      { configDir: mcpDir, force: true },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/OAuth block/);
  });

  it('marks a config file that carries a credential 0600 (and not one that does not)', () => {
    if (process.platform === 'win32') return; // no mode bits on Windows
    const withSecret = mustValidate({ name: 'with-secret', command: 'node', env: { TOKEN: 'x' } }).config;
    const withoutSecret = mustValidate({ name: 'no-secret', command: 'node' }).config;
    expect(carriesSecret(withSecret)).toBe(true);
    expect(carriesSecret(withoutSecret)).toBe(false);
    writeServerConfig(withSecret, { configDir: mcpDir });
    writeServerConfig(withoutSecret, { configDir: mcpDir });
    expect(statSync(join(mcpDir, 'with-secret.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(mcpDir, 'no-secret.json')).mode & 0o777).toBe(0o644);
  });

  it('reports a secret header as a credential, not just an env var', () => {
    expect(carriesSecret({ headers: { authorization: 'Bearer x' } })).toBe(true);
    expect(carriesSecret({ headers: { 'X-Trace-Id': 'y' } })).toBe(false);
  });

  it('the written file is plain JSON a user could have typed', () => {
    writeServerConfig(mustValidate({ name: 'x', command: 'npx', args: ['-y', 'pkg'] }).config, {
      configDir: mcpDir,
    });
    const raw = JSON.parse(readFileSync(join(mcpDir, 'x.json'), 'utf-8')) as MCPServerConfig;
    expect(raw).toEqual({ name: 'x', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'pkg'] });
  });
});

describe('configuration alone redirects or disables a custom server', () => {
  it('mcp.servers.<name>.enabled=false hides it without deleting the file', () => {
    writeServerConfig(mustValidate({ name: 'custom', command: 'node' }).config, { configDir: mcpDir });
    expect(new MCPManager(mcpDir).discoverConfigs().map((c) => c.name)).toContain('custom');

    writeFileSync(
      join(root, 'buffconfig.json'),
      JSON.stringify({ mcp: { servers: { custom: { enabled: false } } } }),
      'utf-8',
    );
    expect(new MCPManager(mcpDir).discoverConfigs()).toHaveLength(0);
    expect(existsSync(join(mcpDir, 'custom.json'))).toBe(true);
  });

  it('a per-server runtime override applies to a hand-written server too', () => {
    writeServerConfig(mustValidate({ name: 'custom', command: 'npx', args: ['-y', 'pkg'] }).config, {
      configDir: mcpDir,
    });
    writeFileSync(
      join(root, 'buffconfig.json'),
      JSON.stringify({
        mcp: { servers: { custom: { runtime: { command: '/opt/node20/bin/node', args: ['/usr/local/bin/npx'] } } } },
      }),
      'utf-8',
    );
    const config = new MCPManager(mcpDir).discoverConfigs()[0];
    expect(config.runtime?.command).toBe('/opt/node20/bin/node');
  });
});

describe('readServerConfig / serverOrigin', () => {
  it('reads back a stored config and refuses to build a path from a bad name', () => {
    writeServerConfig(mustValidate({ name: 'x', command: 'node' }).config, { configDir: mcpDir });
    expect(readServerConfig('x', mcpDir)?.name).toBe('x');
    expect(readServerConfig('absent', mcpDir)).toBeNull();
    // A traversal-shaped name cannot even be read: it is rejected before a path
    // is joined, so no helper here can be pointed outside the config dir.
    expect(readServerConfig('../buffconfig', mcpDir)).toBeNull();
  });

  it('reports where a config came from', () => {
    const catalogName = MCP_CATALOG[0]!.name;
    const variant = MCP_CATALOG[0]!.variants[0]!.id;
    writeServerConfig(
      { name: catalogName, transport: 'stdio', command: 'npx', variant, enabled: true },
      { configDir: mcpDir },
    );
    expect(serverOrigin(catalogName, mcpDir)).toEqual({ origin: 'catalog', variant });
    writeServerConfig(mustValidate({ name: 'mine', command: 'node' }).config, { configDir: mcpDir });
    expect(serverOrigin('mine', mcpDir)).toEqual({ origin: 'custom', variant: null });
  });
});
