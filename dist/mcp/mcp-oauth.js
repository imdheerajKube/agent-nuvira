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
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── OAuth Manager ────────────────────────────────────────────────────────
const OAUTH_DIR = join(resolveNuviraHome(), 'mcp', 'oauth');
const OAUTH_STATE_FILE = join(OAUTH_DIR, 'oauth-state.json');
export class MCPOAuthManager {
    states = new Map();
    constructor() {
        this.loadStates();
    }
    // ─── Token Management ────────────────────────────────────────────────
    /**
     * Get stored tokens for a server.
     * Returns null if no tokens or tokens are expired (and no refresh token).
     */
    getTokens(serverName) {
        const state = this.states.get(serverName);
        if (!state?.tokens)
            return null;
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
    setTokens(serverName, tokens) {
        const state = this.states.get(serverName) || {
            serverName,
            config: {},
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
    clearTokens(serverName) {
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
    async startAuthorizationCodeFlow(serverName, config) {
        const stateParam = randomBytes(16).toString('hex');
        let codeVerifier;
        let codeChallenge;
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
        const state = {
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
    async exchangeCode(serverName, authorizationCode, returnedState) {
        const state = this.states.get(serverName);
        if (!state) {
            throw new Error(`No OAuth state found for server '${serverName}'`);
        }
        if (state.stateParam !== returnedState) {
            throw new Error(`OAuth state mismatch for server '${serverName}'`);
        }
        const redirectUri = state.config.redirectUri || 'http://localhost:3456/mcp/oauth/callback';
        const body = {
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
        const data = await response.json();
        const tokens = {
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
    async refreshToken(serverName) {
        const state = this.states.get(serverName);
        if (!state?.tokens?.refreshToken || !state.config.tokenEndpoint) {
            return null;
        }
        try {
            const body = {
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
            const data = await response.json();
            const tokens = {
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
        }
        catch (err) {
            logger.warn(`MCP OAuth: Refresh error for '${serverName}': ${err}`);
            return null;
        }
    }
    /**
     * Start Client Credentials flow (no user interaction).
     */
    async startClientCredentialsFlow(serverName, config) {
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
        const data = await response.json();
        const tokens = {
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
    loadStates() {
        try {
            if (existsSync(OAUTH_STATE_FILE)) {
                const data = readFileSync(OAUTH_STATE_FILE, 'utf-8');
                const parsed = JSON.parse(data);
                for (const [key, value] of Object.entries(parsed)) {
                    this.states.set(key, value);
                }
            }
        }
        catch {
            // Ignore load errors
        }
    }
    saveStates() {
        try {
            if (!existsSync(OAUTH_DIR)) {
                mkdirSync(OAUTH_DIR, { recursive: true });
            }
            const data = {};
            for (const [key, value] of this.states.entries()) {
                data[key] = value;
            }
            writeFileSync(OAUTH_STATE_FILE, JSON.stringify(data, null, 2));
        }
        catch (err) {
            logger.warn(`MCP OAuth: Failed to save state: ${err}`);
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getMCPOAuthManager() {
    if (!_instance) {
        _instance = new MCPOAuthManager();
    }
    return _instance;
}
export function resetMCPOAuthManager() {
    _instance = null;
}
//# sourceMappingURL=mcp-oauth.js.map