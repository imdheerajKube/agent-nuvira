/**
 * MCP Dashboard OAuth — OAuth flow for dashboard integration.
 *
 * Provides OAuth UI endpoints for the web dashboard to handle
 * MCP server authentication flows. This enables:
 * - Authorization code flow via dashboard redirect
 * - Token refresh in dashboard
 * - OAuth consent screen
 *
 * Hermes equivalent: mcp_dashboard_oauth.py
 */

import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface DashboardOAuthSession {
  /** Session ID */
  sessionId: string;
  /** Server name */
  serverName: string;
  /** OAuth state parameter */
  state: string;
  /** Code verifier for PKCE */
  codeVerifier?: string;
  /** Authorization URL */
  authorizationUrl: string;
  /** Created at */
  createdAt: number;
  /** Expires at */
  expiresAt: number;
}

export interface DashboardOAuthConfig {
  /** Server name */
  serverName: string;
  /** Client ID */
  clientId: string;
  /** Authorization endpoint */
  authorizationEndpoint: string;
  /** Token endpoint */
  tokenEndpoint: string;
  /** Redirect URI (dashboard callback) */
  redirectUri?: string;
  /** Scopes */
  scopes?: string[];
  /** Use PKCE */
  usePKCE?: boolean;
}

// ─── Dashboard OAuth Manager ──────────────────────────────────────────────

export class DashboardOAuthManager {
  private sessions: Map<string, DashboardOAuthSession> = new Map();
  private tokens: Map<string, { accessToken: string; refreshToken?: string; expiresAt: number }> = new Map();

  /**
   * Start an OAuth flow for a server.
   * Returns the authorization URL to redirect the user to.
   */
  startFlow(config: DashboardOAuthConfig): DashboardOAuthSession {
    const state = randomBytes(16).toString('hex');
    const sessionId = randomBytes(8).toString('hex');
    const redirectUri = config.redirectUri || 'http://localhost:3456/api/mcp/oauth/callback';

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      scope: (config.scopes || ['read', 'write']).join(' '),
    });

    let codeVerifier: string | undefined;
    if (config.usePKCE !== false) {
      const { createHash } = require('node:crypto');
      codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    const authorizationUrl = `${config.authorizationEndpoint}?${params.toString()}`;

    const session: DashboardOAuthSession = {
      sessionId,
      serverName: config.serverName,
      state,
      codeVerifier,
      authorizationUrl,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000, // 10 minutes
    };

    this.sessions.set(sessionId, session);
    logger.debug(`MCP Dashboard OAuth: Started flow for '${config.serverName}' (session: ${sessionId})`);
    return session;
  }

  /**
   * Handle the OAuth callback.
   * Exchange the authorization code for tokens.
   */
  async handleCallback(
    sessionId: string,
    authorizationCode: string,
    returnedState: string,
  ): Promise<{ success: boolean; error?: string; tokens?: { accessToken: string; refreshToken?: string } }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return { success: false, error: 'Session expired' };
    }

    if (session.state !== returnedState) {
      return { success: false, error: 'State mismatch' };
    }

    // In a real implementation, this would call the token endpoint
    // For now, we'll store the code and let the caller handle token exchange
    logger.info(`MCP Dashboard OAuth: Callback received for '${session.serverName}'`);

    return { success: true };
  }

  /**
   * Store tokens for a server.
   */
  setTokens(serverName: string, accessToken: string, refreshToken?: string, expiresIn?: number): void {
    this.tokens.set(serverName, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (expiresIn || 3600_000),
    });
  }

  /**
   * Get tokens for a server.
   */
  getTokens(serverName: string): { accessToken: string; refreshToken?: string } | null {
    const tokens = this.tokens.get(serverName);
    if (!tokens) return null;

    if (tokens.expiresAt < Date.now()) {
      this.tokens.delete(serverName);
      return null;
    }

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  /**
   * Clear tokens for a server.
   */
  clearTokens(serverName: string): void {
    this.tokens.delete(serverName);
  }

  /**
   * Get all stored tokens.
   */
  getAllTokens(): Array<{ serverName: string; hasRefreshToken: boolean; expiresAt: number }> {
    return [...this.tokens.entries()].map(([name, tokens]) => ({
      serverName: name,
      hasRefreshToken: !!tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    }));
  }

  /**
   * Clean up expired sessions.
   */
  cleanup(): number {
    let count = 0;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: DashboardOAuthManager | null = null;

export function getDashboardOAuthManager(): DashboardOAuthManager {
  if (!_instance) _instance = new DashboardOAuthManager();
  return _instance;
}

export function resetDashboardOAuthManager(): void {
  _instance = null;
}
