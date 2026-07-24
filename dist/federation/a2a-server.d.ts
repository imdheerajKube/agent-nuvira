/**
 * A2A Server — HTTP server implementing A2A-compatible endpoints for
 * agent discovery and task delegation.
 *
 * Runs alongside the existing federation server (separate port by default).
 * Provides:
 *   GET  /.well-known/agent-card  — AgentCard discovery
 *   GET  /a2a/agent-card          — Alternative discovery endpoint
 *   POST /a2a/task                — Task delegation
 *   GET  /a2a/task/:id            — Task status polling
 *   GET  /a2a/health              — Health check
 *
 * Uses only Node.js built-in modules (http, crypto) — no external dependencies.
 */
import { createServer } from 'node:http';
import { type AgentCard } from './a2a-types.js';
export interface A2AServerOptions {
    port?: number;
    host?: string;
    agentCard?: AgentCard;
    nodeName?: string;
}
/**
 * Create and start an A2A-compatible HTTP server.
 *
 * @param options — Server configuration
 * @returns The started HTTP server instance
 */
export declare function createA2AServer(options?: A2AServerOptions): ReturnType<typeof createServer>;
/**
 * Start the A2A server on the configured port.
 */
export declare function startA2AServer(options?: A2AServerOptions): Promise<ReturnType<typeof createServer>>;
//# sourceMappingURL=a2a-server.d.ts.map