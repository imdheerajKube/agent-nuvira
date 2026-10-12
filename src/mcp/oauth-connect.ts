/**
 * OAuth for MCP servers at CONNECT time — turning a server config's `oauth`
 * block into the `Authorization: Bearer …` header the remote server expects.
 *
 * WHY THIS EXISTS SEPARATELY. `mcp-oauth.ts` owns the FLOW (authorization code,
 * PKCE, client credentials, token storage). It was reachable only through the
 * `mcp_oauth` tool, so a remote server that authenticates with OAuth could be
 * *configured* and never *connected*: nothing in the connect path looked for a
 * token. This module is that missing link, and it is the difference between
 * "we support OAuth" as a claim and as a behaviour.
 *
 * THE CONTRACT
 *   1. A stored, unexpired token is used as-is (`getTokens()` already returns
 *      null for an expired one, with its own safety buffer).
 *   2. An expired one is REFRESHED silently — a refresh token is the whole
 *      reason a remote MCP server keeps working across sessions.
 *   3. `grant: 'client_credentials'` mints a token with no user involved.
 *   4. Otherwise the failure is actionable: it names the exact command that
 *      obtains a token, instead of surfacing as an opaque 401 from the server.
 *
 * Nothing here logs a token value, and no token is ever written into a server
 * config — the credential lives in the OAuth manager's own store.
 */

import { getMCPOAuthManager, type OAuthConfig } from './mcp-oauth.js';
import type { MCPServerConfig, MCPOAuthServerConfig } from './types.js';

export interface OAuthTokenSuccess {
  ok: true;
  accessToken: string;
  tokenType: string;
  /** Where the token came from — recorded so a trace can explain a reconnect. */
  how: 'stored' | 'refreshed' | 'client_credentials';
}

export interface OAuthTokenFailure {
  ok: false;
  /** Why no token could be produced, phrased for the user. */
  reason: string;
  how: 'not_configured' | 'needs_authorization' | 'refresh_failed' | 'client_credentials_failed';
}

export type OAuthTokenOutcome = OAuthTokenSuccess | OAuthTokenFailure;

/** The server config's `oauth` block in the shape `mcp-oauth` expects. */
export function toOAuthConfig(oauth: MCPOAuthServerConfig): OAuthConfig {
  return {
    clientId: oauth.clientId ?? '',
    ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
    authorizationEndpoint: oauth.authorizationEndpoint ?? '',
    tokenEndpoint: oauth.tokenEndpoint,
    ...(oauth.scopes ? { scopes: oauth.scopes } : {}),
    ...(oauth.usePKCE !== undefined ? { usePKCE: oauth.usePKCE } : {}),
  };
}

/**
 * Resolve a usable access token for a server, or explain why there is none.
 * Never throws: a connect path must be able to report a credential problem as a
 * message rather than as a crash inside a transport.
 */
export async function resolveOAuthAccessToken(
  config: Pick<MCPServerConfig, 'name' | 'oauth'>,
): Promise<OAuthTokenOutcome> {
  const oauth = config.oauth;
  if (!oauth?.tokenEndpoint) {
    return {
      ok: false,
      how: 'not_configured',
      reason: `'${config.name}' has no OAuth configuration (a tokenEndpoint is required).`,
    };
  }

  const manager = getMCPOAuthManager();
  // Seed the manager's per-server config so a REFRESH works in a process that
  // never ran the interactive flow (a scheduled turn, the gateway, the
  // dashboard) — see MCPOAuthManager.setConfig. Deliberately does NOT touch
  // tokens: this is the how, not the credential.
  manager.setConfig(config.name, toOAuthConfig(oauth));

  // 1) A live token, straight from the store. `getTokens()` returns null once
  //    the token is expired (its own 30s buffer), which is exactly the signal
  //    that a refresh is worth attempting.
  const stored = manager.getTokens(config.name);
  if (stored?.accessToken) {
    return { ok: true, accessToken: stored.accessToken, tokenType: stored.tokenType || 'Bearer', how: 'stored' };
  }

  // 2) Silent refresh. Returns null when there is no refresh token to use.
  const refreshed = await manager.refreshToken(config.name);
  if (refreshed?.accessToken) {
    return { ok: true, accessToken: refreshed.accessToken, tokenType: refreshed.tokenType || 'Bearer', how: 'refreshed' };
  }

  // 3) Server-to-server, no user involved.
  if (oauth.grant === 'client_credentials') {
    try {
      const minted = await manager.startClientCredentialsFlow(config.name, toOAuthConfig(oauth));
      return {
        ok: true,
        accessToken: minted.accessToken,
        tokenType: minted.tokenType || 'Bearer',
        how: 'client_credentials',
      };
    } catch (err) {
      return {
        ok: false,
        how: 'client_credentials_failed',
        reason:
          `'${config.name}': the client-credentials token request failed — ` +
          `${err instanceof Error ? err.message : String(err)}. Verify clientId/clientSecret and the token endpoint.`,
      };
    }
  }

  // 4) The honest dead end, with the one command that fixes it.
  return {
    ok: false,
    how: 'needs_authorization',
    reason:
      `${config.name}: no valid OAuth token. Authorize it once with \`nuvira mcp authorize ${config.name}\` ` +
      '(afterwards it refreshes automatically), or set an explicit Authorization header in its config.',
  };
}

/** Merge an OAuth access token into a remote server's headers (explicit header wins). */
export function withOAuthHeader(
  headers: Record<string, string> | undefined,
  token: { accessToken: string; tokenType: string },
): Record<string, string> {
  const hasAuthorization = Object.keys(headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
  if (hasAuthorization) return headers ?? {};
  return { ...(headers ?? {}), Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}` };
}
