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

import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';

import { logger } from '../utils/logger.js';
import {
  type FederationConfig,
  type HandshakeResponse,
  type TaskDelegationRequest,
  type TaskDelegationResponse,
  type TaskResult,
  type TaskProgressEvent,
  type FederationHealth,
  DEFAULT_FEDERATION_CONFIG,
} from './protocol.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── FederationClient ───────────────────────────────────────────────────────

export class FederationClient extends EventEmitter {
  private config: FederationConfig;
  private sessionToken: string | null = null;
  private serverId: string | null = null;
  private status: ConnectionStatus = 'disconnected';

  constructor(config: Partial<FederationConfig> = {}) {
    super();
    this.config = { ...DEFAULT_FEDERATION_CONFIG, ...config };
  }

  // ─── Connection Management ───────────────────────────────────────────────

  async connect(): Promise<HandshakeResponse> {
    if (this.status === 'connected' && this.sessionToken) {
      logger.debug('Federation: Already connected');
      return {
        sessionToken: this.sessionToken,
        serverId: this.serverId || this.config.nodeId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        capabilities: this.config.capabilities,
      };
    }

    this.status = 'connecting';

    try {
      const response = await this.makeRequest<HandshakeResponse>(
        '/federation/handshake', 'POST',
        { secret: this.config.secret, clientId: this.config.nodeId, capabilities: this.config.capabilities },
      );

      this.sessionToken = response.sessionToken;
      this.serverId = response.serverId;
      this.status = 'connected';
      logger.success(`Federation: Connected to ${this.config.host}:${this.config.port} (server: ${response.serverId})`);
      this.emit('connected' as any);
      return response;
    } catch (err) {
      this.status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error' as any, new Error(msg));
      throw err;
    }
  }

  disconnect(): void {
    this.sessionToken = null;
    this.serverId = null;
    this.status = 'disconnected';
    this.emit('disconnected' as any);
    logger.info('Federation: Disconnected');
  }

  isConnected(): boolean { return this.status === 'connected' && !!this.sessionToken; }

  getStatus(): ConnectionStatus { return this.status; }

  getServerId(): string | null { return this.serverId; }

  // ─── Task Delegation ─────────────────────────────────────────────────────

  async delegateTask(
    goal: string,
    agentType: string,
    options?: { provider?: string; model?: string; timeoutMs?: number; streamProgress?: boolean },
  ): Promise<TaskResult> {
    if (!this.isConnected()) throw new Error('Not connected to federation server. Call connect() first.');

    const taskRequest: TaskDelegationRequest = {
      goal, agentType,
      provider: options?.provider, model: options?.model,
      timeoutMs: options?.timeoutMs || this.config.taskTimeoutMs,
      streamProgress: options?.streamProgress !== false,
    };

    logger.info(`Federation: Delegating task to ${this.serverId || 'remote'} (${agentType})`);

    try {
      return await this.delegateWithStreaming(taskRequest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Federation: Streaming failed (${msg}), falling back to polling`);
      return this.delegateWithPolling(taskRequest);
    }
  }

  private async delegateWithStreaming(request: TaskDelegationRequest): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      const body = JSON.stringify(request);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Authorization': `Bearer ${this.sessionToken}`,
        'Accept': 'text/event-stream',
      };

      const req = httpRequest(
        {
          hostname: this.config.host,
          port: String(this.config.port),
          path: '/federation/task',
          method: 'POST',
          headers,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => reject(new Error(`Server returned ${res.statusCode}: ${data.slice(0, 200)}`)));
            return;
          }

          let buffer = '';
          let taskResult: TaskResult | null = null;

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            let currentEvent = '';
            let currentData = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
              else if (line.startsWith('data: ')) currentData = line.slice(6).trim();
              else if (line === '' && currentEvent === 'progress' && currentData) {
                try {
                  const event = JSON.parse(currentData) as TaskProgressEvent;
                  this.emit('task-progress' as any, event);
                  if (event.status === 'completed' && event.result) taskResult = event.result;
                  else if (event.status === 'failed' && event.result) taskResult = event.result;
                } catch { /* ignore parse errors */ }
                currentEvent = '';
                currentData = '';
              }
            }
          });

          res.on('end', () => {
            clearTimeout(reqTimer);
            if (taskResult) {
              this.emit(taskResult.success ? 'task-completed' as any : 'task-failed' as any, taskResult);
              resolve(taskResult);
            } else {
              reject(new Error('Task ended without a result'));
            }
          });

          res.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
        },
      );

      const reqTimer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Task timed out after ${request.timeoutMs || this.config.taskTimeoutMs}ms`));
      }, request.timeoutMs || this.config.taskTimeoutMs);

      req.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
      req.write(body);
      req.end();
    });
  }

  private async delegateWithPolling(request: TaskDelegationRequest): Promise<TaskResult> {
    const response = await this.makeRequest<TaskDelegationResponse>('/federation/task', 'POST', request);
    if (response.status === 'rejected') throw new Error(`Task rejected: ${response.reason || 'Unknown reason'}`);

    const taskId = response.taskId;
    const timeout = request.timeoutMs || this.config.taskTimeoutMs;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const health = await this.getHealth();
        if (health.activeTasks === 0) {
          return { taskId, success: true, summary: `Task ${taskId} completed`, durationMs: Date.now() - startTime };
        }
      } catch { /* network error — server may be processing */ }
    }

    throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
  }

  // ─── Task Cancellation ───────────────────────────────────────────────────

  async cancelTask(taskId: string): Promise<void> {
    await this.makeRequest('/federation/cancel', 'POST', { taskId });
    logger.info(`Federation: Cancelled task ${taskId}`);
  }

  // ─── Health Check ────────────────────────────────────────────────────────

  async getHealth(): Promise<FederationHealth> {
    if (this.sessionToken) {
      return this.makeRequest<FederationHealth>('/federation/health', 'GET');
    }
    const response = await fetch(`http://${this.config.host}:${this.config.port}/federation/health`);
    const raw = await response.json() as Record<string, unknown>;
    const payload = (raw?.type === 'response' ? raw.payload : raw) as FederationHealth;
    return payload;
  }

  // ─── Generic Request ─────────────────────────────────────────────────────

  private async makeRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

      if (this.sessionToken) headers['Authorization'] = `Bearer ${this.sessionToken}`;
      if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

      const req = httpRequest(
        { hostname: this.config.host, port: String(this.config.port), path, method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            clearTimeout(reqTimer);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                const payload = parsed.type === 'response' ? parsed.payload : parsed;
                resolve(payload as T);
              } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
            } else {
              reject(new Error(`Federation request failed (${res.statusCode}): ${data.slice(0, 200)}`));
            }
          });
          res.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
        },
      );

      const reqTimer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Request to ${path} timed out`));
      }, 10_000);

      req.on('error', (err: Error) => {
        clearTimeout(reqTimer);
        if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          reject(new Error(`Connection refused to ${this.config.host}:${this.config.port}. Is the federation server running?`));
        } else {
          reject(err);
        }
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}
