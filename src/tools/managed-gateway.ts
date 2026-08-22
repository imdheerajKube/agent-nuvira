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

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Managed Gateway ──────────────────────────────────────────────────────

export class ManagedGateway {
  private config: GatewayConfig;
  private requestHistory: GatewayRequest[] = [];
  private responseHistory: GatewayResponse[] = [];
  private rateLimitWindow: Map<number, number> = new Map(); // keyIndex -> request count
  private stats: GatewayStats;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalCost: 0,
      avgDuration: 0,
      rateLimitHits: 0,
    };
  }

  /**
   * Call a managed tool.
   */
  async call(
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<GatewayResponse> {
    const requestId = randomUUID();
    const startTime = Date.now();

    // Check rate limit
    const keyIndex = this.getNextKey();
    if (this.isRateLimited(keyIndex)) {
      this.stats.rateLimitHits++;
      return {
        requestId,
        success: false,
        error: 'Rate limit exceeded',
        durationMs: 0,
        cost: 0,
        endpoint: this.config.endpoint,
        keyIndex,
      };
    }

    // Record request
    const request: GatewayRequest = {
      id: requestId,
      toolName,
      payload,
      keyIndex,
      endpoint: this.config.endpoint,
      timestamp: Date.now(),
    };
    this.requestHistory.push(request);

    // Increment rate limit
    this.incrementRateLimit(keyIndex);

    try {
      // Make the call
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKeys[keyIndex]}`,
        },
        body: JSON.stringify({ tool: toolName, ...payload }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const durationMs = Date.now() - startTime;
      const cost = this.config.costPerRequest;

      const gatewayResponse: GatewayResponse = {
        requestId,
        success: true,
        data,
        durationMs,
        cost,
        endpoint: this.config.endpoint,
        keyIndex,
      };

      this.responseHistory.push(gatewayResponse);
      this.updateStats(gatewayResponse);

      return gatewayResponse;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      // Try fallback
      if (this.config.fallbackEndpoints.length > 0) {
        return this.callWithFallback(requestId, toolName, payload, keyIndex, durationMs);
      }

      const gatewayResponse: GatewayResponse = {
        requestId,
        success: false,
        error: String(err),
        durationMs,
        cost: 0,
        endpoint: this.config.endpoint,
        keyIndex,
      };

      this.responseHistory.push(gatewayResponse);
      this.updateStats(gatewayResponse);

      return gatewayResponse;
    }
  }

  /**
   * Get stats.
   */
  getStats(): GatewayStats {
    return { ...this.stats };
  }

  /**
   * Get request history.
   */
  getRequestHistory(limit: number = 50): GatewayRequest[] {
    return this.requestHistory.slice(-limit);
  }

  /**
   * Get response history.
   */
  getResponseHistory(limit: number = 50): GatewayResponse[] {
    return this.responseHistory.slice(-limit);
  }

  /**
   * Rotate API keys.
   */
  rotateKey(): void {
    this.config.currentKeyIndex = (this.config.currentKeyIndex + 1) % this.config.apiKeys.length;
    logger.info(`Gateway: Rotated to key index ${this.config.currentKeyIndex}`);
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private getNextKey(): number {
    return this.config.currentKeyIndex;
  }

  private isRateLimited(keyIndex: number): boolean {
    const now = Date.now();
    const windowStart = now - 60_000; // 1 minute window
    const count = this.rateLimitWindow.get(keyIndex) || 0;
    return count >= this.config.rateLimit;
  }

  private incrementRateLimit(keyIndex: number): void {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Clean old entries
    for (const [timestamp, _] of this.rateLimitWindow) {
      if (timestamp < windowStart) {
        this.rateLimitWindow.delete(timestamp);
      }
    }

    const count = this.rateLimitWindow.get(now) || 0;
    this.rateLimitWindow.set(now, count + 1);
  }

  private async callWithFallback(
    requestId: string,
    toolName: string,
    payload: Record<string, unknown>,
    keyIndex: number,
    originalDuration: number,
  ): Promise<GatewayResponse> {
    for (const fallbackEndpoint of this.config.fallbackEndpoints) {
      try {
        const response = await fetch(fallbackEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKeys[keyIndex]}`,
          },
          body: JSON.stringify({ tool: toolName, ...payload }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (response.ok) {
          const data = await response.json();
          const durationMs = Date.now() - (Date.now() - originalDuration);

          return {
            requestId,
            success: true,
            data,
            durationMs,
            cost: this.config.costPerRequest,
            endpoint: fallbackEndpoint,
            keyIndex,
          };
        }
      } catch { /* try next fallback */ }
    }

    return {
      requestId,
      success: false,
      error: 'All endpoints failed',
      durationMs: originalDuration,
      cost: 0,
      endpoint: this.config.endpoint,
      keyIndex,
    };
  }

  private updateStats(response: GatewayResponse): void {
    this.stats.totalRequests++;
    if (response.success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }
    this.stats.totalCost += response.cost;
    this.stats.avgDuration =
      (this.stats.avgDuration * (this.stats.totalRequests - 1) + response.durationMs) /
      this.stats.totalRequests;
  }
}

// ─── Gateway Registry ─────────────────────────────────────────────────────

const gateways: Map<string, ManagedGateway> = new Map();

/**
 * Register a managed gateway.
 */
export function registerGateway(config: GatewayConfig): ManagedGateway {
  const gateway = new ManagedGateway(config);
  gateways.set(config.name, gateway);
  return gateway;
}

/**
 * Get a gateway by name.
 */
export function getGateway(name: string): ManagedGateway | null {
  return gateways.get(name) || null;
}

/**
 * List all gateways.
 */
export function listGateways(): ManagedGateway[] {
  return [...gateways.values()];
}
