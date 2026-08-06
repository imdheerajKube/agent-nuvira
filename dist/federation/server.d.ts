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
import type { OidcAdapter } from '../enterprise/rbac.js';
import { type FederationConfig } from './protocol.js';
export interface FederationServerOptions {
    /**
     * P6 M6.4: the OIDC adapter used when `config.authMode === 'oidc'`.
     * Defaults to none — secret-mode servers (the existing behavior) leave it
     * undefined and never invoke it.
     */
    oidcAdapter?: OidcAdapter;
}
/**
 * Create and start a federation server.
 *
 * @param config — Federation configuration (defaults to reading from env/config)
 * @param options — Server options (OIDC adapter for authMode 'oidc')
 * @returns The started HTTP server instance
 */
export declare function createFederationServer(config?: Partial<FederationConfig>, options?: FederationServerOptions): ReturnType<typeof createServer>;
/**
 * Start the federation server on the configured port.
 */
export declare function startFederationServer(config?: Partial<FederationConfig>, options?: FederationServerOptions): Promise<ReturnType<typeof createServer>>;
//# sourceMappingURL=server.d.ts.map