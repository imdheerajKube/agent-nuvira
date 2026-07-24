/**
 * FederationServer — HTTP server that accepts remote agent task delegations.
 *
 * Runs on a configurable port and listens for:
 * - POST /federation/handshake — Authentication and session creation
 * - POST /federation/task — Task delegation (with SSE for progress)
 * - POST /federation/cancel — Cancel a running task
 * - GET  /federation/health — Health check endpoint
 *
 * Uses only Node.js built-in modules (http, crypto) — no external dependencies.
 */
import { createServer } from 'node:http';
import { type FederationConfig } from './protocol.js';
/**
 * Create and start a federation server.
 *
 * @param config — Federation configuration (defaults to reading from env/config)
 * @returns The started HTTP server instance
 */
export declare function createFederationServer(config?: Partial<FederationConfig>): ReturnType<typeof createServer>;
/**
 * Start the federation server on the configured port.
 */
export declare function startFederationServer(config?: Partial<FederationConfig>): Promise<ReturnType<typeof createServer>>;
//# sourceMappingURL=server.d.ts.map