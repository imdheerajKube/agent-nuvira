/**
 * tool_backend_helpers — Backend selection, fallback, and load balancing for tools.
 * Routes tool calls to the best available backend (local, cloud, edge, etc.).
 */
interface Backend {
    name: string;
    type: 'local' | 'cloud' | 'edge' | 'proxy';
    status: 'healthy' | 'degraded' | 'down';
    latencyMs: number;
    lastCheck: number;
    successRate: number;
    totalCalls: number;
    failedCalls: number;
    priority: number;
}
interface RoutingRule {
    toolPattern: string;
    preferredBackend: string;
    fallbackBackends: string[];
    maxLatencyMs: number;
}
declare class ToolBackendManager {
    private backends;
    private routingRules;
    private callLog;
    constructor();
    /**
     * Register a backend.
     */
    registerBackend(backend: Omit<Backend, 'successRate' | 'totalCalls' | 'failedCalls'>): void;
    /**
     * Remove a backend.
     */
    removeBackend(name: string): boolean;
    /**
     * Add a routing rule.
     */
    addRoutingRule(rule: RoutingRule): void;
    /**
     * Select the best backend for a tool call.
     */
    selectBackend(toolName: string): string;
    /**
     * Record a call result.
     */
    recordCall(tool: string, backend: string, latencyMs: number, success: boolean): void;
    /**
     * Check health of all backends.
     */
    checkHealth(): Promise<{
        name: string;
        status: string;
        latencyMs: number;
    }[]>;
    /**
     * Get backend stats.
     */
    getStats(): {
        name: string;
        totalCalls: number;
        failedCalls: number;
        successRate: number;
        avgLatency: number;
    }[];
    /**
     * Get call log (last N calls).
     */
    getCallLog(limit?: number): typeof this.callLog;
}
export declare function getToolBackendManager(): ToolBackendManager;
export { ToolBackendManager };
//# sourceMappingURL=tool-backend-helpers.d.ts.map