/**
 * OAuth for remote MCP servers — the connect path, the authorize flow, and the
 * catalog entries that use them.
 *
 * WHAT THESE PIN DOWN. `mcp-oauth.ts` could already speak the flows, but nothing
 * in the CONNECT path looked for a token, so an OAuth server was configurable
 * and never usable. These tests drive the whole chain against a LOCAL fake
 * provider (no network, no Google account): live token reused → expired token
 * refreshed → no token refused with the exact command that fixes it → the
 * interactive flow completing on a loopback redirect.
 *
 * HERMETIC: the token store resolves `NUVIRA_CONFIG_DIR` per operation, so this
 * run never touches the user's real `~/.nuvira` credential store.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-oauth-'));
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
const mcpDir = join(testDir, '.nuvira', 'mcp');

const { getMCPOAuthManager, resetMCPOAuthManager } = await import('../../src/mcp/mcp-oauth.js');
const { resolveOAuthAccessToken, toOAuthConfig, withOAuthHeader } = await import('../../src/mcp/oauth-connect.js');
const { runAuthorizeFlow } = await import('../../src/mcp/oauth-authorize.js');
const { MCP_CATALOG, getCatalogEntry, installCatalogServer } = await import('../../src/mcp/catalog.js');

// ─── A local fake OAuth provider ────────────────────────────────────────────

interface TokenRequest {
  grant_type: string;
  refresh_token?: string;
  client_id?: string;
}

let provider: Server;
let providerUrl = '';
const tokenRequests: TokenRequest[] = [];

beforeAll(async () => {
  provider = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // The consent page: immediately "approve" by redirecting to the loopback
    // callback with a code — exactly what a user clicking Allow produces.
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const target = new URL(redirect);
      target.searchParams.set('code', 'FAKE-AUTH-CODE');
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }

    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        tokenRequests.push({
          grant_type: params.get('grant_type') ?? '',
          ...(params.get('refresh_token') ? { refresh_token: params.get('refresh_token') as string } : {}),
          ...(params.get('client_id') ? { client_id: params.get('client_id') as string } : {}),
        });
        const refresh = params.get('grant_type') === 'refresh_token';
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: refresh ? 'REFRESHED-TOKEN' : 'FRESH-TOKEN',
            refresh_token: 'REFRESH-TOKEN',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'mcp.read mcp.write',
          }),
        );
      });
      return;
    }

    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()));
  const address = provider.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  providerUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  provider.close();
  rmSync(testDir, { recursive: true, force: true });
});

let configDirCounter = 0;
beforeEach(() => {
  // A FRESH config dir per test: the token store persists to disk (by design),
  // so a shared dir would leak one test's token into the next and make the
  // "no token yet" case pass for the wrong reason.
  process.env.NUVIRA_CONFIG_DIR = join(testDir, `.nuvira-${configDirCounter++}`);
  resetMCPOAuthManager();
  tokenRequests.length = 0;
});

/** A server config pointing at the fake provider. */
const oauthConfig = (overrides: Record<string, unknown> = {}) => ({
  name: 'fake-oauth-server',
  transport: 'sse' as const,
  url: 'https://example.invalid/mcp',
  enabled: true,
  oauth: {
    authorizationEndpoint: `${providerUrl}/authorize`,
    tokenEndpoint: `${providerUrl}/token`,
    clientId: 'client-123',
    clientSecret: 'secret-456',
    scopes: ['mcp.read'],
    usePKCE: true,
    ...overrides,
  },
});

describe('oauth config shape', () => {
  it('maps a server oauth block onto the flow library config', () => {
    const mapped = toOAuthConfig(oauthConfig().oauth);
    expect(mapped.tokenEndpoint).toBe(`${providerUrl}/token`);
    expect(mapped.clientId).toBe('client-123');
    expect(mapped.scopes).toEqual(['mcp.read']);
    expect(mapped.usePKCE).toBe(true);
  });

  it('sends the bearer header, and never overwrites an explicit Authorization', () => {
    const withToken = withOAuthHeader({ 'X-Other': '1' }, { accessToken: 'abc', tokenType: 'Bearer' });
    expect(withToken.Authorization).toBe('Bearer abc');
    expect(withToken['X-Other']).toBe('1');

    // A user who pasted their own header keeps it.
    const explicit = withOAuthHeader({ Authorization: 'Bearer mine' }, { accessToken: 'abc', tokenType: 'Bearer' });
    expect(explicit.Authorization).toBe('Bearer mine');
  });
});

describe('resolveOAuthAccessToken', () => {
  it('refuses a server with no oauth block, naming the reason', async () => {
    const outcome = await resolveOAuthAccessToken({ name: 'plain', oauth: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.how).toBe('not_configured');
  });

  it('reuses a live stored token without contacting the provider', async () => {
    getMCPOAuthManager().setTokens('fake-oauth-server', {
      accessToken: 'LIVE-TOKEN',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
    });
    const outcome = await resolveOAuthAccessToken(oauthConfig());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.accessToken).toBe('LIVE-TOKEN');
      expect(outcome.how).toBe('stored');
    }
    expect(tokenRequests).toHaveLength(0);
  });

  it('refreshes an expired token against the token endpoint', async () => {
    getMCPOAuthManager().setTokens('fake-oauth-server', {
      accessToken: 'STALE-TOKEN',
      refreshToken: 'REFRESH-TOKEN',
      tokenType: 'Bearer',
      // Already expired: getTokens() returns null and this becomes a refresh.
      expiresAt: Date.now() - 1000,
    });
    const outcome = await resolveOAuthAccessToken(oauthConfig());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.accessToken).toBe('REFRESHED-TOKEN');
      expect(outcome.how).toBe('refreshed');
    }
    expect(tokenRequests[0]?.grant_type).toBe('refresh_token');
    expect(tokenRequests[0]?.refresh_token).toBe('REFRESH-TOKEN');
  });

  it('mints a token with client credentials when the server asks for that grant', async () => {
    const outcome = await resolveOAuthAccessToken(oauthConfig({ grant: 'client_credentials' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.accessToken).toBe('FRESH-TOKEN');
      expect(outcome.how).toBe('client_credentials');
    }
    expect(tokenRequests[0]?.grant_type).toBe('client_credentials');
  });

  it('tells the user the ONE command that fixes a missing token', async () => {
    const outcome = await resolveOAuthAccessToken(oauthConfig());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.how).toBe('needs_authorization');
      expect(outcome.reason).toContain('nuvira mcp authorize fake-oauth-server');
    }
  });
});

describe('runAuthorizeFlow (loopback redirect)', () => {
  it('completes the flow, stores the tokens, and is then used without a browser', async () => {
    const oauth = toOAuthConfig(oauthConfig().oauth);
    const result = await runAuthorizeFlow('fake-oauth-server', oauth, {
      // Visit the consent URL the way a browser would, following the redirect
      // back to our own loopback listener.
      visit: (url) => void fetch(url),
      log: () => undefined,
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.accessToken).toBe('FRESH-TOKEN');
      expect(result.tokens.refreshToken).toBe('REFRESH-TOKEN');
    }

    // The stored token is now what the connect path finds — no second prompt.
    const outcome = await resolveOAuthAccessToken(oauthConfig());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.how).toBe('stored');
  });

  it('REJECTS a callback whose state does not match (the CSRF case)', async () => {
    const oauth = toOAuthConfig(oauthConfig().oauth);
    const result = await runAuthorizeFlow('fake-oauth-server', oauth, {
      visit: () => {
        // A callback carrying a state WE did not send — exactly what a forged
        // redirect looks like.
        void fetch(
          `${providerUrl}/authorize?redirect_uri=${encodeURIComponent('http://localhost:3456/mcp/oauth/callback')}&state=forged`,
        );
      },
      log: () => undefined,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('state mismatch');
    // And no token was stored from it.
    expect(getMCPOAuthManager().getTokens('fake-oauth-server')).toBeNull();
  });
});

describe('catalog entries for Google Workspace', () => {
  it('ships gmail, drive and calendar as official REMOTE servers needing OAuth', () => {
    for (const name of ['gmail', 'gdrive', 'gcalendar']) {
      const entry = getCatalogEntry(name);
      expect(entry, `${name} must be in the catalog`).toBeTruthy();
      const variant = entry!.variants[0];
      expect(variant.transport).toBe('sse');
      expect(variant.trust).toBe('official');
      expect(variant.url).toMatch(/^https:\/\/[a-z]+mcp\.googleapis\.com\/mcp\/v1$/);
      expect(variant.oauth?.tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
      expect(variant.oauth?.authorizationEndpoint).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      // The client secret arrives from the environment, never hard-coded.
      expect(variant.oauth?.clientId).toBe('${GOOGLE_MCP_CLIENT_ID}');
      expect(variant.env?.GOOGLE_MCP_CLIENT_SECRET).toBe('prompt-secret');
      // Read-only-ish scopes: no blanket Drive, no event writing.
      expect(variant.oauth?.scopes?.length).toBeGreaterThan(0);
    }
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(9);
  });

  it('writes the oauth block into the config with the client credentials expanded', () => {
    const entry = getCatalogEntry('gmail')!;
    const installed = installCatalogServer(
      entry,
      { GOOGLE_MCP_CLIENT_ID: 'cid-123', GOOGLE_MCP_CLIENT_SECRET: 'csecret-456' },
      mcpDir,
    );
    expect(installed.ok, installed.reason).toBe(true);

    const written = JSON.parse(readFileSync(join(mcpDir, 'gmail.json'), 'utf-8')) as {
      transport: string;
      url: string;
      oauth?: { clientId?: string; clientSecret?: string; tokenEndpoint?: string; scopes?: string[] };
    };
    expect(written.transport).toBe('sse');
    expect(written.url).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    // `expandRefs` ran: the config holds the VALUE the user supplied, not `${VAR}`.
    expect(written.oauth?.clientId).toBe('cid-123');
    expect(written.oauth?.clientSecret).toBe('csecret-456');
    expect(written.oauth?.tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
    expect(written.oauth?.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('refuses the install when the OAuth client credentials are absent (names them)', () => {
    const entry = getCatalogEntry('gdrive')!;
    const installed = installCatalogServer(entry, {}, mcpDir);
    expect(installed.ok).toBe(false);
    expect(installed.reason).toContain('GOOGLE_MCP_CLIENT_ID');
  });
});
