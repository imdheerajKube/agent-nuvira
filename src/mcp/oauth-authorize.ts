/**
 * `nuvira mcp authorize <server>` — the interactive half of OAuth for MCP.
 *
 * WHY IT EXISTS. `mcp-oauth.ts` can build an authorization URL and exchange a
 * code, but nothing ever LISTENED for the redirect: the flow was reachable only
 * through a tool that asked a human to paste a code back by hand, and the CLI had
 * no way to authorize a remote server at all. So an OAuth server could be
 * configured and never used. This module closes the loop — start a loopback
 * server on the registered redirect URI, open the consent page, take the `code`
 * the provider redirects with, exchange it, and store the tokens.
 *
 * THE REDIRECT URI IS THE CONTRACT. A provider only redirects to a URI registered
 * on the OAuth client, so the DEFAULT (`http://localhost:3456/mcp/oauth/callback`)
 * is stated in the printed instructions and overridable with `--redirect-uri`.
 * Guessing a port would look like it worked and fail at the provider, which is
 * why the URI is printed before the browser opens rather than after.
 *
 * The tokens land in the OAuth manager's store (never in a server config file),
 * and the access token is refreshed silently afterwards by `oauth-connect.ts`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

import { getMCPOAuthManager, type OAuthConfig, type OAuthTokens } from './mcp-oauth.js';

/** The default loopback redirect — must match the OAuth client's registered URI. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:3456/mcp/oauth/callback';

export interface AuthorizeOptions {
  /** Override the redirect URI (defaults to {@link DEFAULT_REDIRECT_URI}). */
  redirectUri?: string;
  /** How long to wait for the user to finish consent (default 5 minutes). */
  timeoutMs?: number;
  /** Try to open the consent page in a browser (default true). */
  openBrowser?: boolean;
  /** Progress/log sink. Defaults to writing to the terminal. */
  log?: (line: string) => void;
  /** Test seam: how the consent URL is visited. Defaults to a browser spawn. */
  visit?: (url: string) => void;
}

export type AuthorizeResult =
  | { ok: true; tokens: OAuthTokens; redirectUri: string }
  | { ok: false; reason: string; redirectUri: string };

/** Open a URL with the OS handler, best-effort (never throws, never blocks). */
function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // A headless machine has no browser — the URL is already printed.
  }
}

/** The tiny HTML the browser lands on, so a success does not look like a hang. */
function respondPage(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agent-Nuvira</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>${message}</h1><p>You can close this tab and return to the terminal.</p></body></html>`;
}

/**
 * Run the authorization-code flow for one server and store the resulting tokens.
 * Resolves when the provider redirects back; rejects nothing — failures are
 * returned as `{ ok: false, reason }` so the CLI can print them and exit non-zero.
 */
export async function runAuthorizeFlow(
  serverName: string,
  oauth: OAuthConfig,
  options: AuthorizeOptions = {},
): Promise<AuthorizeResult> {
  const redirectUri = options.redirectUri ?? oauth.redirectUri ?? DEFAULT_REDIRECT_URI;
  const log = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { ok: false, redirectUri, reason: `'${redirectUri}' is not a valid redirect URI.` };
  }
  if (!oauth.authorizationEndpoint || !oauth.tokenEndpoint) {
    return {
      ok: false,
      redirectUri,
      reason: `'${serverName}' is missing an authorizationEndpoint or tokenEndpoint — check its oauth block.`,
    };
  }
  if (!oauth.clientId) {
    return { ok: false, redirectUri, reason: `'${serverName}' has no oauth.clientId.` };
  }

  const listener = createServer();

  const manager = getMCPOAuthManager();
  // Persist the config FIRST: the state (PKCE verifier, state param, scopes) is
  // written by startAuthorizationCodeFlow, and a refresh later needs the config.
  manager.setConfig(serverName, { ...oauth, redirectUri });

  const { authorizationUrl, state } = await manager.startAuthorizationCodeFlow(serverName, {
    ...oauth,
    redirectUri,
  });

  const callbackPath = url.pathname;
  const codePromise = new Promise<{ code: string; state: string; error?: string }>((resolve) => {
    listener.on('error', (err) => {
      resolve({ code: '', state: '', error: `could not listen on ${redirectUri}: ${err.message}` });
    });
    listener.on('request', (req, res) => {
      const requestUrl = new URL(req.url ?? '/', redirectUri);
      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404).end('Not the OAuth callback path.');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code') ?? '';
      const returnedState = requestUrl.searchParams.get('state') ?? '';
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        respondPage(error ? `Authorization failed: ${error}` : 'Authorized — Agent-Nuvira can continue.'),
      );
      resolve({ code, state: returnedState, ...(error ? { error } : {}) });
    });
  });

  await new Promise<void>((resolve) => {
    listener.listen(Number(url.port || 80), url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, () => resolve());
  });

  log('');
  log(`🔐 Authorizing '${serverName}' (${redirectUri} must be a registered redirect URI for this client).`);
  log(`   If the browser does not open, visit:\n   ${authorizationUrl}`);
  const open = options.visit ?? (options.openBrowser === false ? () => undefined : openInBrowser);
  open(authorizationUrl);

  const callback = await Promise.race([
    codePromise,
    new Promise<{ code: string; state: string; error: string }>((resolve) => {
      const t = setTimeout(
        () => resolve({ code: '', state: '', error: `timed out after ${Math.round(timeoutMs / 1000)}s` }),
        timeoutMs,
      );
      t.unref?.();
    }),
  ]);
  listener.close();

  if (callback.error) return { ok: false, redirectUri, reason: `Authorization failed: ${callback.error}` };
  if (!callback.code) return { ok: false, redirectUri, reason: 'The provider did not return an authorization code.' };
  if (callback.state !== state) {
    return { ok: false, redirectUri, reason: 'OAuth state mismatch — the response did not come from this request.' };
  }

  try {
    const tokens = await manager.exchangeCode(serverName, callback.code, callback.state);
    return { ok: true, tokens, redirectUri };
  } catch (err) {
    return {
      ok: false,
      redirectUri,
      reason: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
