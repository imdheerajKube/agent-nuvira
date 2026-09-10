/**
 * MCP Stdio Watchdog — Monitors MCP server process health.
 *
 * Watches over stdio-based MCP server processes and:
 * - Detects hung/unresponsive servers
 * - Auto-restarts failed servers
 * - Monitors memory usage
 * - Enforces timeouts
 * - Logs health metrics
 *
 * Hermes equivalent: mcp_stdio_watchdog.py
 */
export interface WatchdogConfig {
    /** Check interval in ms (default: 30s) */
    checkIntervalMs?: number;
    /** Max consecutive failures before marking as dead (default: 3) */
    maxConsecutiveFailures?: number;
    /** Restart delay in ms (default: 1s) */
    restartDelayMs?: number;
    /** Max restart attempts (default: 5) */
    maxRestartAttempts?: number;
    /** Health check timeout in ms (default: 5s) */
    healthCheckTimeoutMs?: number;
}
export interface ServerHealth {
    /** Server name */
    serverName: string;
    /** Is the server responding? */
    isHealthy: boolean;
    /** Last successful health check (epoch ms) */
    lastHealthyAt: number | null;
    /** Consecutive health check failures */
    consecutiveFailures: number;
    /** Total restart count */
    restartCount: number;
    /** Last error message */
    lastError: string | null;
    /** Process ID (if available) */
    pid: number | null;
    /** Memory usage in bytes (if available) */
    memoryUsage: number | null;
    /** Uptime in ms */
    uptimeMs: number;
}
export interface WatchdogEvent {
    /** Event type */
    type: 'healthy' | 'unhealthy' | 'restart' | 'dead' | 'recovered';
    /** Server name */
    serverName: string;
    /** Timestamp */
    timestamp: number;
    /** Additional details */
    details?: string;
}
export declare class MCPStdioWatchdog {
    private config;
    private healthMap;
    private checkTimer;
    private eventHandlers;
    private restartHandlers;
    constructor(config?: WatchdogConfig);
    /**
     * Register a server for monitoring.
     */
    register(serverName: string, pid: number | null, restartHandler: () => Promise<void>): void;
    /**
     * Unregister a server from monitoring.
     */
    unregister(serverName: string): void;
    /**
     * Report a successful health check.
     */
    reportHealthy(serverName: string): void;
    /**
     * Report a failed health check.
     */
    reportUnhealthy(serverName: string, error: string): void;
    /**
     * Update process metrics.
     */
    updateMetrics(serverName: string, metrics: {
        pid?: number;
        memoryUsage?: number;
        uptimeMs?: number;
    }): void;
    /**
     * Start the watchdog monitoring loop.
     */
    start(): void;
    /**
     * Stop the watchdog monitoring loop.
     */
    stop(): void;
    /**
     * Get health status for all servers.
     */
    getHealth(): ServerHealth[];
    /**
     * Get health status for a specific server.
     */
    getServerHealth(serverName: string): ServerHealth | null;
    /**
     * Register an event handler.
     */
    onEvent(handler: (event: WatchdogEvent) => void): void;
    /**
     * Remove an event handler.
     */
    offEvent(handler: (event: WatchdogEvent) => void): void;
    private checkAllServers;
    private attemptRestart;
    private emit;
}
export declare function getMCPWatchdog(): MCPStdioWatchdog;
export declare function resetMCPWatchdog(): void;
//# sourceMappingURL=mcp-watchdog.d.ts.map