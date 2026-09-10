/**
 * Managed Tool Gateway — Vendor API proxying.
 *
 * Routes tool calls through managed services with:
 * - Automatic API key rotation
 * - Rate limiting
 * - Cost tracking
 * - Vendor fallback
 * - Audit logging
 *
 * Hermes equivalent: managed_tool_gateway.py
 */
export interface GatewayConfig {
    /** Gateway name */
    name: string;
    /** Default endpoint */
    endpoint: string;
    /** API keys (rotated automatically) */
    apiKeys: string[];
    /** Current key index */
    currentKeyIndex: number;
    /** Rate limit (requests per minute) */
    rateLimit: number;
    /** Timeout in ms */
    timeoutMs: number;
    /** Fallback endpoints */
    fallbackEndpoints: string[];
    /** Cost per request (in cents) */
    costPerRequest: number;
}
export interface GatewayRequest {
    /** Request ID */
    id: string;
    /** Tool name */
    toolName: string;
    /** Request payload */
    payload: Record<string, unknown>;
    /** Which key was used */
    keyIndex: number;
    /** Which endpoint was used */
    endpoint: string;
    /** Timestamp */
    timestamp: number;
}
export interface GatewayResponse {
    /** Request ID */
    requestId: string;
    /** Success */
    success: boolean;
    /** Response data */
    data?: unknown;
    /** Error */
    error?: string;
    /** Duration in ms */
    durationMs: number;
    /** Cost in cents */
    cost: number;
    /** Which endpoint was used */
    endpoint: string;
    /** Which key was used */
    keyIndex: number;
}
export interface GatewayStats {
    /** Total requests */
    totalRequests: number;
    /** Successful requests */
    successfulRequests: number;
    /** Failed requests */
    failedRequests: number;
    /** Total cost in cents */
    totalCost: number;
    /** Average duration */
    avgDuration: number;
    /** Rate limit hits */
    rateLimitHits: number;
}
export declare class ManagedGateway {
    private config;
    private requestHistory;
    private responseHistory;
    private rateLimitWindow;
    private stats;
    constructor(config: GatewayConfig);
    /**
     * Call a managed tool.
     */
    call(toolName: string, payload: Record<string, unknown>): Promise<GatewayResponse>;
    /**
     * Get stats.
     */
    getStats(): GatewayStats;
    /**
     * Get request history.
     */
    getRequestHistory(limit?: number): GatewayRequest[];
    /**
     * Get response history.
     */
    getResponseHistory(limit?: number): GatewayResponse[];
    /**
     * Rotate API keys.
     */
    rotateKey(): void;
    private getNextKey;
    private isRateLimited;
    private incrementRateLimit;
    private callWithFallback;
    private updateStats;
}
/**
 * Register a managed gateway.
 */
export declare function registerGateway(config: GatewayConfig): ManagedGateway;
/**
 * Get a gateway by name.
 */
export declare function getGateway(name: string): ManagedGateway | null;
/**
 * List all gateways.
 */
export declare function listGateways(): ManagedGateway[];
//# sourceMappingURL=managed-gateway.d.ts.map