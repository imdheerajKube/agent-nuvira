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
import { logger } from '../utils/logger.js';
// ─── Watchdog ─────────────────────────────────────────────────────────────
export class MCPStdioWatchdog {
    config;
    healthMap = new Map();
    checkTimer = null;
    eventHandlers = [];
    restartHandlers = new Map();
    constructor(config) {
        this.config = {
            checkIntervalMs: config?.checkIntervalMs || 30_000,
            maxConsecutiveFailures: config?.maxConsecutiveFailures || 3,
            restartDelayMs: config?.restartDelayMs || 1_000,
            maxRestartAttempts: config?.maxRestartAttempts || 5,
            healthCheckTimeoutMs: config?.healthCheckTimeoutMs || 5_000,
        };
    }
    // ─── Server Registration ─────────────────────────────────────────────
    /**
     * Register a server for monitoring.
     */
    register(serverName, pid, restartHandler) {
        this.healthMap.set(serverName, {
            serverName,
            isHealthy: true,
            lastHealthyAt: Date.now(),
            consecutiveFailures: 0,
            restartCount: 0,
            lastError: null,
            pid,
            memoryUsage: null,
            uptimeMs: 0,
        });
        this.restartHandlers.set(serverName, restartHandler);
        logger.debug(`MCP Watchdog: Registered server '${serverName}' (pid: ${pid})`);
    }
    /**
     * Unregister a server from monitoring.
     */
    unregister(serverName) {
        this.healthMap.delete(serverName);
        this.restartHandlers.delete(serverName);
        logger.debug(`MCP Watchdog: Unregistered server '${serverName}'`);
    }
    // ─── Health Checks ──────────────────────────────────────────────────
    /**
     * Report a successful health check.
     */
    reportHealthy(serverName) {
        const health = this.healthMap.get(serverName);
        if (!health)
            return;
        const wasUnhealthy = !health.isHealthy;
        health.isHealthy = true;
        health.lastHealthyAt = Date.now();
        health.consecutiveFailures = 0;
        health.lastError = null;
        if (wasUnhealthy) {
            this.emit({
                type: 'recovered',
                serverName,
                timestamp: Date.now(),
            });
        }
    }
    /**
     * Report a failed health check.
     */
    reportUnhealthy(serverName, error) {
        const health = this.healthMap.get(serverName);
        if (!health)
            return;
        health.consecutiveFailures++;
        health.lastError = error;
        if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
            health.isHealthy = false;
            this.emit({
                type: 'unhealthy',
                serverName,
                timestamp: Date.now(),
                details: error,
            });
            this.attemptRestart(serverName);
        }
    }
    /**
     * Update process metrics.
     */
    updateMetrics(serverName, metrics) {
        const health = this.healthMap.get(serverName);
        if (!health)
            return;
        if (metrics.pid !== undefined)
            health.pid = metrics.pid;
        if (metrics.memoryUsage !== undefined)
            health.memoryUsage = metrics.memoryUsage;
        if (metrics.uptimeMs !== undefined)
            health.uptimeMs = metrics.uptimeMs;
    }
    // ─── Monitoring ──────────────────────────────────────────────────────
    /**
     * Start the watchdog monitoring loop.
     */
    start() {
        if (this.checkTimer)
            return;
        this.checkTimer = setInterval(() => {
            this.checkAllServers();
        }, this.config.checkIntervalMs);
        logger.debug(`MCP Watchdog: Started (interval: ${this.config.checkIntervalMs}ms)`);
    }
    /**
     * Stop the watchdog monitoring loop.
     */
    stop() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        logger.debug('MCP Watchdog: Stopped');
    }
    /**
     * Get health status for all servers.
     */
    getHealth() {
        return [...this.healthMap.values()];
    }
    /**
     * Get health status for a specific server.
     */
    getServerHealth(serverName) {
        return this.healthMap.get(serverName) || null;
    }
    // ─── Events ──────────────────────────────────────────────────────────
    /**
     * Register an event handler.
     */
    onEvent(handler) {
        this.eventHandlers.push(handler);
    }
    /**
     * Remove an event handler.
     */
    offEvent(handler) {
        const idx = this.eventHandlers.indexOf(handler);
        if (idx !== -1)
            this.eventHandlers.splice(idx, 1);
    }
    // ─── Internal ────────────────────────────────────────────────────────
    async checkAllServers() {
        for (const [serverName, health] of this.healthMap.entries()) {
            // Check if server has been unhealthy for too long
            if (!health.isHealthy && health.restartCount >= this.config.maxRestartAttempts) {
                this.emit({
                    type: 'dead',
                    serverName,
                    timestamp: Date.now(),
                    details: `Server '${serverName}' has failed ${health.restartCount} times, giving up`,
                });
                continue;
            }
            // Check if server is responsive (by checking last healthy time)
            if (health.lastHealthyAt) {
                const timeSinceHealthy = Date.now() - health.lastHealthyAt;
                if (timeSinceHealthy > this.config.checkIntervalMs * 2) {
                    this.reportUnhealthy(serverName, `No health check response for ${timeSinceHealthy}ms`);
                }
            }
        }
    }
    async attemptRestart(serverName) {
        const health = this.healthMap.get(serverName);
        const restartHandler = this.restartHandlers.get(serverName);
        if (!health || !restartHandler)
            return;
        if (health.restartCount >= this.config.maxRestartAttempts) {
            logger.warn(`MCP Watchdog: Server '${serverName}' exceeded max restart attempts`);
            return;
        }
        health.restartCount++;
        this.emit({
            type: 'restart',
            serverName,
            timestamp: Date.now(),
            details: `Restart attempt ${health.restartCount}/${this.config.maxRestartAttempts}`,
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, this.config.restartDelayMs));
            await restartHandler();
            logger.info(`MCP Watchdog: Successfully restarted server '${serverName}'`);
        }
        catch (err) {
            logger.error(`MCP Watchdog: Failed to restart server '${serverName}': ${err}`);
            this.reportUnhealthy(serverName, `Restart failed: ${err}`);
        }
    }
    emit(event) {
        for (const handler of this.eventHandlers) {
            try {
                handler(event);
            }
            catch {
                // Ignore handler errors
            }
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getMCPWatchdog() {
    if (!_instance) {
        _instance = new MCPStdioWatchdog();
    }
    return _instance;
}
export function resetMCPWatchdog() {
    if (_instance) {
        _instance.stop();
        _instance = null;
    }
}
//# sourceMappingURL=mcp-watchdog.js.map