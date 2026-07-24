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
/** Default port for the federation server */
export declare const DEFAULT_FEDERATION_PORT = 8374;
/** Default host to bind to */
export declare const DEFAULT_FEDERATION_HOST = "0.0.0.0";
/** Protocol version */
export declare const FEDERATION_PROTOCOL_VERSION = "1.0";
/** Timeout for task execution (ms) — default 30 min */
export declare const DEFAULT_TASK_TIMEOUT_MS: number;
/** Timeout for HTTP requests (ms) */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** Heartbeat interval for SSE connections (ms) */
export declare const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
/** Federation message envelope */
export interface FederationEnvelope {
    version: string;
    type: 'request' | 'response' | 'error' | 'event';
    payload: unknown;
    timestamp: number;
}
/** Handshake request — sent by client to initiate a session */
export interface HandshakeRequest {
    /** Pre-shared secret key */
    secret: string;
    /** Client identity (hostname, machine name) */
    clientId: string;
    /** Client capabilities (which agent types it can run) */
    capabilities: string[];
}
/** Handshake response — sent by server on successful auth */
export interface HandshakeResponse {
    /** Session token for subsequent requests */
    sessionToken: string;
    /** Server identity */
    serverId: string;
    /** Session expiry timestamp */
    expiresAt: number;
    /** Server capabilities */
    capabilities: string[];
}
/** Task delegation request */
export interface TaskDelegationRequest {
    /** Task prompt/goal */
    goal: string;
    /** Agent type to run (e.g., 'writer', 'planner') */
    agentType: string;
    /** Provider/model override */
    provider?: string;
    model?: string;
    /** Timeout in ms */
    timeoutMs?: number;
    /** File context (base64-encoded tarball or file paths) */
    contextFiles?: string[];
    /** Whether to stream progress via SSE */
    streamProgress?: boolean;
}
/** Task delegation response */
export interface TaskDelegationResponse {
    /** Task ID for tracking */
    taskId: string;
    /** Status: 'accepted' | 'queued' | 'rejected' */
    status: 'accepted' | 'queued' | 'rejected';
    /** Reason if rejected */
    reason?: string;
    /** Estimated wait time (ms) */
    estimatedWaitMs?: number;
}
/** Task result — sent when task completes */
export interface TaskResult {
    taskId: string;
    success: boolean;
    summary: string;
    details?: string;
    error?: string;
    /** Execution duration in ms */
    durationMs: number;
    /** Output files (base64 encoded) */
    outputFiles?: Array<{
        path: string;
        content: string;
    }>;
    /** Cost incurred (USD) */
    costUsd?: number;
}
/** Task progress event (SSE) */
export interface TaskProgressEvent {
    taskId: string;
    status: 'running' | 'completed' | 'failed';
    progress?: number;
    message?: string;
    result?: TaskResult;
}
/** Server health information */
export interface FederationHealth {
    status: 'ok' | 'degraded' | 'offline';
    uptime: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    version: string;
    loadAverage?: number[];
}
/** Configuration for a federation server or client */
export interface FederationConfig {
    /** Whether federation is enabled */
    enabled: boolean;
    /** Secret key for authentication */
    secret: string;
    /** Host to bind/connect to */
    host: string;
    /** Port to bind/connect to */
    port: number;
    /** Maximum concurrent tasks */
    maxConcurrentTasks: number;
    /** Task timeout (ms) */
    taskTimeoutMs: number;
    /** Node identity (hostname) */
    nodeId: string;
    /** Capabilities (which agent types this node can run) */
    capabilities: string[];
}
/** Default federation configuration */
export declare const DEFAULT_FEDERATION_CONFIG: FederationConfig;
//# sourceMappingURL=protocol.d.ts.map