/**
 * Federation Protocol — Types and constants for agent-to-agent communication.
 *
 * The protocol uses HTTP/SSE with pre-shared key authentication.
 * Messages are JSON-encoded with a standard envelope format.
 *
 * ## Protocol Flow
 *
 * 1. Client connects to remote server: POST /federation/handshake
 *    → Server validates pre-shared key, returns session token
 * 2. Client delegates a task: POST /federation/task
 *    → Server accepts and responds via SSE for progress events
 * 3. Server processes the task and sends progress/results via SSE
 * 4. Client can cancel a task: POST /federation/cancel
 * 5. Health check: GET /federation/health
 *
 * ## Authentication
 *
 * All requests include a pre-shared key in the Authorization header.
 * The key is set via FEDERATION_SECRET env var or config file.
 * First-party requests use Bearer token from handshake.
 *
 * ## Envelope Format
 *
 * All HTTP requests/responses use a standard envelope:
 * {
 *   "version": "1.0",
 *   "type": "request" | "response" | "error" | "event",
 *   "payload": { ... },
 *   "timestamp": 1234567890
 * }
 */
// ─── Configuration ──────────────────────────────────────────────────────────
/** Default port for the federation server */
export const DEFAULT_FEDERATION_PORT = 8374;
/** Default host to bind to */
export const DEFAULT_FEDERATION_HOST = '0.0.0.0';
/** Protocol version */
export const FEDERATION_PROTOCOL_VERSION = '1.0';
/** Timeout for task execution (ms) — default 30 min */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
/** Timeout for HTTP requests (ms) */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Heartbeat interval for SSE connections (ms) */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Default federation configuration */
export const DEFAULT_FEDERATION_CONFIG = {
    enabled: false,
    secret: '',
    host: DEFAULT_FEDERATION_HOST,
    port: DEFAULT_FEDERATION_PORT,
    maxConcurrentTasks: 4,
    taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    nodeId: 'unknown',
    capabilities: ['planner', 'context-gatherer', 'writer', 'reviewer', 'tester', 'debugger', 'runner'],
};
//# sourceMappingURL=protocol.js.map