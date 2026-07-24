/**
 * FederationClient — Connects to a remote federation server and delegates tasks.
 *
 * Provides:
 * - Handshake authentication with pre-shared key
 * - Task delegation with progress streaming via SSE
 * - Task cancellation
 * - Health checks
 *
 * Uses only Node.js built-in modules (http, events) — no external dependencies.
 * Falls back to polling when SSE is not available.
 */
import { EventEmitter } from 'node:events';
import { type FederationConfig, type HandshakeResponse, type TaskResult, type TaskProgressEvent, type FederationHealth } from './protocol.js';
/** Events emitted by the FederationClient */
export interface FederationClientEvents {
    connected: [];
    disconnected: [];
    error: [error: Error];
    'task-progress': [event: TaskProgressEvent];
    'task-completed': [result: TaskResult];
    'task-failed': [result: TaskResult];
}
/** Connection status */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export declare class FederationClient extends EventEmitter {
    private config;
    private sessionToken;
    private serverId;
    private status;
    constructor(config?: Partial<FederationConfig>);
    connect(): Promise<HandshakeResponse>;
    disconnect(): void;
    isConnected(): boolean;
    getStatus(): ConnectionStatus;
    getServerId(): string | null;
    delegateTask(goal: string, agentType: string, options?: {
        provider?: string;
        model?: string;
        timeoutMs?: number;
        streamProgress?: boolean;
    }): Promise<TaskResult>;
    private delegateWithStreaming;
    private delegateWithPolling;
    cancelTask(taskId: string): Promise<void>;
    getHealth(): Promise<FederationHealth>;
    private makeRequest;
}
//# sourceMappingURL=client.d.ts.map