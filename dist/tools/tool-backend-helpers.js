/**
 * tool_backend_helpers — Backend selection, fallback, and load balancing for tools.
 * Routes tool calls to the best available backend (local, cloud, edge, etc.).
 */
class ToolBackendManager {
    backends = new Map();
    routingRules = [];
    callLog = [];
    constructor() {
        // Default backends
        this.backends.set('local', {
            name: 'local',
            type: 'local',
            status: 'healthy',
            latencyMs: 10,
            lastCheck: Date.now(),
            successRate: 1.0,
            totalCalls: 0,
            failedCalls: 0,
            priority: 1,
        });
    }
    /**
     * Register a backend.
     */
    registerBackend(backend) {
        this.backends.set(backend.name, {
            ...backend,
            successRate: 1.0,
            totalCalls: 0,
            failedCalls: 0,
        });
    }
    /**
     * Remove a backend.
     */
    removeBackend(name) {
        return this.backends.delete(name);
    }
    /**
     * Add a routing rule.
     */
    addRoutingRule(rule) {
        // Remove existing rule for same pattern
        this.routingRules = this.routingRules.filter(r => r.toolPattern !== rule.toolPattern);
        this.routingRules.push(rule);
    }
    /**
     * Select the best backend for a tool call.
     */
    selectBackend(toolName) {
        // Check routing rules first
        for (const rule of this.routingRules) {
            if (toolName.includes(rule.toolPattern) || rule.toolPattern === '*') {
                const preferred = this.backends.get(rule.preferredBackend);
                if (preferred && preferred.status === 'healthy' && preferred.latencyMs <= rule.maxLatencyMs) {
                    return rule.preferredBackend;
                }
                // Try fallbacks
                for (const fb of rule.fallbackBackends) {
                    const fallback = this.backends.get(fb);
                    if (fallback && fallback.status === 'healthy') {
                        return fb;
                    }
                }
            }
        }
        // Default: lowest latency healthy backend
        let best = 'local';
        let bestLatency = Infinity;
        for (const [name, backend] of this.backends) {
            if (backend.status === 'healthy' && backend.latencyMs < bestLatency) {
                best = name;
                bestLatency = backend.latencyMs;
            }
        }
        return best;
    }
    /**
     * Record a call result.
     */
    recordCall(tool, backend, latencyMs, success) {
        const b = this.backends.get(backend);
        if (b) {
            b.totalCalls++;
            if (!success)
                b.failedCalls++;
            b.successRate = b.totalCalls > 0 ? (b.totalCalls - b.failedCalls) / b.totalCalls : 1;
        }
        this.callLog.push({ tool, backend, latencyMs, success, timestamp: Date.now() });
        // Keep log bounded
        if (this.callLog.length > 1000) {
            this.callLog = this.callLog.slice(-500);
        }
    }
    /**
     * Check health of all backends.
     */
    async checkHealth() {
        const results = [];
        for (const [name, backend] of this.backends) {
            if (backend.type === 'local') {
                backend.status = 'healthy';
                backend.latencyMs = 10;
                backend.lastCheck = Date.now();
            }
            results.push({ name, status: backend.status, latencyMs: backend.latencyMs });
        }
        return results;
    }
    /**
     * Get backend stats.
     */
    getStats() {
        return Array.from(this.backends.values()).map(b => {
            const calls = this.callLog.filter(c => c.backend === b.name);
            const avgLatency = calls.length > 0
                ? Math.round(calls.reduce((s, c) => s + c.latencyMs, 0) / calls.length)
                : 0;
            return {
                name: b.name,
                totalCalls: b.totalCalls,
                failedCalls: b.failedCalls,
                successRate: Math.round(b.successRate * 100),
                avgLatency,
            };
        });
    }
    /**
     * Get call log (last N calls).
     */
    getCallLog(limit = 50) {
        return this.callLog.slice(-limit);
    }
}
let _instance = null;
export function getToolBackendManager() {
    if (!_instance)
        _instance = new ToolBackendManager();
    return _instance;
}
export { ToolBackendManager };
//# sourceMappingURL=tool-backend-helpers.js.map