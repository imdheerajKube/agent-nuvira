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
export declare class MCPOAuthManager {
    private states;
    constructor();
    /**
     * Get stored tokens for a server.
     * Returns null if no tokens or tokens are expired (and no refresh token).
     */
    getTokens(serverName: string): OAuthTokens | null;
    /**
     * Store tokens for a server.
     */
    setTokens(serverName: string, tokens: OAuthTokens): void;
    /**
     * Clear tokens for a server.
     */
    clearTokens(serverName: string): void;
    /**
     * Start the OAuth2 Authorization Code flow.
     * Returns the authorization URL the user should visit.
     */
    startAuthorizationCodeFlow(serverName: string, config: OAuthConfig): Promise<{
        authorizationUrl: string;
        state: string;
    }>;
    /**
     * Exchange authorization code for tokens.
     */
    exchangeCode(serverName: string, authorizationCode: string, returnedState: string): Promise<OAuthTokens>;
    /**
     * Refresh an expired access token.
     */
    refreshToken(serverName: string): Promise<OAuthTokens | null>;
    /**
     * Start Client Credentials flow (no user interaction).
     */
    startClientCredentialsFlow(serverName: string, config: OAuthConfig): Promise<OAuthTokens>;
    private loadStates;
    private saveStates;
}
export declare function getMCPOAuthManager(): MCPOAuthManager;
export declare function resetMCPOAuthManager(): void;
//# sourceMappingURL=mcp-oauth.d.ts.map