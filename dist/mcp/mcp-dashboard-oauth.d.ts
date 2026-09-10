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
export declare class DashboardOAuthManager {
    private sessions;
    private tokens;
    /**
     * Start an OAuth flow for a server.
     * Returns the authorization URL to redirect the user to.
     */
    startFlow(config: DashboardOAuthConfig): DashboardOAuthSession;
    /**
     * Handle the OAuth callback.
     * Exchange the authorization code for tokens.
     */
    handleCallback(sessionId: string, authorizationCode: string, returnedState: string): Promise<{
        success: boolean;
        error?: string;
        tokens?: {
            accessToken: string;
            refreshToken?: string;
        };
    }>;
    /**
     * Store tokens for a server.
     */
    setTokens(serverName: string, accessToken: string, refreshToken?: string, expiresIn?: number): void;
    /**
     * Get tokens for a server.
     */
    getTokens(serverName: string): {
        accessToken: string;
        refreshToken?: string;
    } | null;
    /**
     * Clear tokens for a server.
     */
    clearTokens(serverName: string): void;
    /**
     * Get all stored tokens.
     */
    getAllTokens(): Array<{
        serverName: string;
        hasRefreshToken: boolean;
        expiresAt: number;
    }>;
    /**
     * Clean up expired sessions.
     */
    cleanup(): number;
}
export declare function getDashboardOAuthManager(): DashboardOAuthManager;
export declare function resetDashboardOAuthManager(): void;
//# sourceMappingURL=mcp-dashboard-oauth.d.ts.map