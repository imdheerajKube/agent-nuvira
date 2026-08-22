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

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Watchdog ─────────────────────────────────────────────────────────────

export class MCPStdioWatchdog {
  private config: Required<WatchdogConfig>;
  private healthMap: Map<string, ServerHealth> = new Map();
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: Array<(event: WatchdogEvent) => void> = [];
  private restartHandlers: Map<string, () => Promise<void>> = new Map();

  constructor(config?: WatchdogConfig) {
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
  register(
    serverName: string,
    pid: number | null,
    restartHandler: () => Promise<void>,
  ): void {
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
  unregister(serverName: string): void {
    this.healthMap.delete(serverName);
    this.restartHandlers.delete(serverName);
    logger.debug(`MCP Watchdog: Unregistered server '${serverName}'`);
  }

  // ─── Health Checks ──────────────────────────────────────────────────

  /**
   * Report a successful health check.
   */
  reportHealthy(serverName: string): void {
    const health = this.healthMap.get(serverName);
    if (!health) return;

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
  reportUnhealthy(serverName: string, error: string): void {
    const health = this.healthMap.get(serverName);
    if (!health) return;

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
  updateMetrics(serverName: string, metrics: { pid?: number; memoryUsage?: number; uptimeMs?: number }): void {
    const health = this.healthMap.get(serverName);
    if (!health) return;

    if (metrics.pid !== undefined) health.pid = metrics.pid;
    if (metrics.memoryUsage !== undefined) health.memoryUsage = metrics.memoryUsage;
    if (metrics.uptimeMs !== undefined) health.uptimeMs = metrics.uptimeMs;
  }

  // ─── Monitoring ──────────────────────────────────────────────────────

  /**
   * Start the watchdog monitoring loop.
   */
  start(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.checkAllServers();
    }, this.config.checkIntervalMs);

    logger.debug(`MCP Watchdog: Started (interval: ${this.config.checkIntervalMs}ms)`);
  }

  /**
   * Stop the watchdog monitoring loop.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    logger.debug('MCP Watchdog: Stopped');
  }

  /**
   * Get health status for all servers.
   */
  getHealth(): ServerHealth[] {
    return [...this.healthMap.values()];
  }

  /**
   * Get health status for a specific server.
   */
  getServerHealth(serverName: string): ServerHealth | null {
    return this.healthMap.get(serverName) || null;
  }

  // ─── Events ──────────────────────────────────────────────────────────

  /**
   * Register an event handler.
   */
  onEvent(handler: (event: WatchdogEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Remove an event handler.
   */
  offEvent(handler: (event: WatchdogEvent) => void): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx !== -1) this.eventHandlers.splice(idx, 1);
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async checkAllServers(): Promise<void> {
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

  private async attemptRestart(serverName: string): Promise<void> {
    const health = this.healthMap.get(serverName);
    const restartHandler = this.restartHandlers.get(serverName);

    if (!health || !restartHandler) return;

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
    } catch (err) {
      logger.error(`MCP Watchdog: Failed to restart server '${serverName}': ${err}`);
      this.reportUnhealthy(serverName, `Restart failed: ${err}`);
    }
  }

  private emit(event: WatchdogEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: MCPStdioWatchdog | null = null;

export function getMCPWatchdog(): MCPStdioWatchdog {
  if (!_instance) {
    _instance = new MCPStdioWatchdog();
  }
  return _instance;
}

export function resetMCPWatchdog(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
