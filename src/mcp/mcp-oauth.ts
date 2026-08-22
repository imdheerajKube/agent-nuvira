/**
 * MCP OAuth — OAuth2 authentication for MCP servers.
 *
 * Handles the OAuth2 flow when connecting to remote MCP servers that
 * require authentication. Supports:
 * - Authorization Code flow (browser-based)
 * - Client Credentials flow (server-to-server)
 * - Token refresh
 * - Token storage
 *
 * Hermes equivalent: mcp_oauth.py + mcp_oauth_manager.py + mcp_dashboard_oauth.py
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret (optional for PKCE) */
  clientSecret?: string;
  /** Authorization endpoint */
  authorizationEndpoint: string;
  /** Token endpoint */
  tokenEndpoint: string;
  /** Redirect URI */
  redirectUri?: string;
  /** Scopes to request */
  scopes?: string[];
  /** Use PKCE (Proof Key for Code Exchange) */
  usePKCE?: boolean;
}

export interface OAuthTokens {
  /** Access token */
  accessToken: string;
  /** Refresh token */
  refreshToken?: string;
  /** Token type (usually 'Bearer') */
  tokenType: string;
  /** Expires at (epoch ms) */
  expiresAt: number;
  /** Scopes granted */
  scopes?: string[];
}

export interface OAuthState {
  /** Server name */
  serverName: string;
  /** OAuth config */
  config: OAuthConfig;
  /** Current tokens */
  tokens?: OAuthTokens;
  /** PKCE code verifier (if using PKCE) */
  codeVerifier?: string;
  /** PKCE code challenge */
  codeChallenge?: string;
  /** OAuth state parameter */
  stateParam?: string;
  /** When this state was created */
  createdAt: number;
}

// ─── OAuth Manager ────────────────────────────────────────────────────────

const OAUTH_DIR = join(homedir(), '.buff', 'mcp', 'oauth');
const OAUTH_STATE_FILE = join(OAUTH_DIR, 'oauth-state.json');

export class MCPOAuthManager {
  private states: Map<string, OAuthState> = new Map();

  constructor() {
    this.loadStates();
  }

  // ─── Token Management ────────────────────────────────────────────────

  /**
   * Get stored tokens for a server.
   * Returns null if no tokens or tokens are expired (and no refresh token).
   */
  getTokens(serverName: string): OAuthTokens | null {
    const state = this.states.get(serverName);
    if (!state?.tokens) return null;

    // Check if token is expired (with 30s buffer)
    if (state.tokens.expiresAt < Date.now() + 30_000) {
      if (state.tokens.refreshToken) {
        logger.debug(`MCP OAuth: Token expired for '${serverName}', has refresh token`);
        return null; // Caller should refresh
      }
      logger.debug(`MCP OAuth: Token expired for '${serverName}', no refresh token`);
      return null;
    }

    return state.tokens;
  }

  /**
   * Store tokens for a server.
   */
  setTokens(serverName: string, tokens: OAuthTokens): void {
    const state = this.states.get(serverName) || {
      serverName,
      config: {} as OAuthConfig,
      createdAt: Date.now(),
    };
    state.tokens = tokens;
    this.states.set(serverName, state);
    this.saveStates();
    logger.debug(`MCP OAuth: Stored tokens for '${serverName}'`);
  }

  /**
   * Clear tokens for a server.
   */
  clearTokens(serverName: string): void {
    const state = this.states.get(serverName);
    if (state) {
      state.tokens = undefined;
      this.states.set(serverName, state);
      this.saveStates();
    }
  }

  // ─── OAuth Flow ──────────────────────────────────────────────────────

  /**
   * Start the OAuth2 Authorization Code flow.
   * Returns the authorization URL the user should visit.
   */
  async startAuthorizationCodeFlow(
    serverName: string,
    config: OAuthConfig,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const stateParam = randomBytes(16).toString('hex');
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;

    // PKCE support
    if (config.usePKCE !== false) {
      codeVerifier = randomBytes(32).toString('base64url');
      codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    }

    const redirectUri = config.redirectUri || 'http://localhost:3456/mcp/oauth/callback';

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state: stateParam,
      scope: (config.scopes || ['read', 'write']).join(' '),
    });

    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    const authorizationUrl = `${config.authorizationEndpoint}?${params.toString()}`;

    // Store state
    const state: OAuthState = {
      serverName,
      config,
      codeVerifier,
      codeChallenge,
      stateParam,
      createdAt: Date.now(),
    };
    this.states.set(serverName, state);
    this.saveStates();

    return { authorizationUrl, state: stateParam };
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(
    serverName: string,
    authorizationCode: string,
    returnedState: string,
  ): Promise<OAuthTokens> {
    const state = this.states.get(serverName);
    if (!state) {
      throw new Error(`No OAuth state found for server '${serverName}'`);
    }

    if (state.stateParam !== returnedState) {
      throw new Error(`OAuth state mismatch for server '${serverName}'`);
    }

    const redirectUri = state.config.redirectUri || 'http://localhost:3456/mcp/oauth/callback';

    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: state.config.clientId,
    };

    if (state.config.clientSecret) {
      body.client_secret = state.config.clientSecret;
    }

    if (state.codeVerifier) {
      body.code_verifier = state.codeVerifier;
    }

    const response = await fetch(state.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OAuth token exchange failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : Date.now() + 3600_000, // Default 1 hour
      scopes: data.scope?.split(' '),
    };

    this.setTokens(serverName, tokens);
    return tokens;
  }

  /**
   * Refresh an expired access token.
   */
  async refreshToken(serverName: string): Promise<OAuthTokens | null> {
    const state = this.states.get(serverName);
    if (!state?.tokens?.refreshToken || !state.config.tokenEndpoint) {
      return null;
    }

    try {
      const body: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: state.tokens.refreshToken,
        client_id: state.config.clientId,
      };

      if (state.config.clientSecret) {
        body.client_secret = state.config.clientSecret;
      }

      const response = await fetch(state.config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });

      if (!response.ok) {
        logger.warn(`MCP OAuth: Refresh failed for '${serverName}': ${response.status}`);
        return null;
      }

      const data = await response.json() as {
        access_token: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
        scope?: string;
      };

      const tokens: OAuthTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || state.tokens.refreshToken,
        tokenType: data.token_type || 'Bearer',
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : Date.now() + 3600_000,
        scopes: data.scope?.split(' '),
      };

      this.setTokens(serverName, tokens);
      return tokens;
    } catch (err) {
      logger.warn(`MCP OAuth: Refresh error for '${serverName}': ${err}`);
      return null;
    }
  }

  /**
   * Start Client Credentials flow (no user interaction).
   */
  async startClientCredentialsFlow(
    serverName: string,
    config: OAuthConfig,
  ): Promise<OAuthTokens> {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('Client Credentials flow requires clientId and clientSecret');
    }

    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: (config.scopes || []).join(' '),
      }).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Client Credentials flow failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : Date.now() + 3600_000,
      scopes: data.scope?.split(' '),
    };

    this.setTokens(serverName, tokens);
    return tokens;
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private loadStates(): void {
    try {
      if (existsSync(OAUTH_STATE_FILE)) {
        const data = readFileSync(OAUTH_STATE_FILE, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, OAuthState>;
        for (const [key, value] of Object.entries(parsed)) {
          this.states.set(key, value);
        }
      }
    } catch {
      // Ignore load errors
    }
  }

  private saveStates(): void {
    try {
      if (!existsSync(OAUTH_DIR)) {
        mkdirSync(OAUTH_DIR, { recursive: true });
      }
      const data: Record<string, OAuthState> = {};
      for (const [key, value] of this.states.entries()) {
        data[key] = value;
      }
      writeFileSync(OAUTH_STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn(`MCP OAuth: Failed to save state: ${err}`);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: MCPOAuthManager | null = null;

export function getMCPOAuthManager(): MCPOAuthManager {
  if (!_instance) {
    _instance = new MCPOAuthManager();
  }
  return _instance;
}

export function resetMCPOAuthManager(): void {
  _instance = null;
}
