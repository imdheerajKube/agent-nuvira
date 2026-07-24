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
import { DEFAULT_FEDERATION_CONFIG, } from './protocol.js';
// ─── FederationClient ───────────────────────────────────────────────────────
export class FederationClient extends EventEmitter {
    config;
    sessionToken = null;
    serverId = null;
    status = 'disconnected';
    constructor(config = {}) {
        super();
        this.config = { ...DEFAULT_FEDERATION_CONFIG, ...config };
    }
    // ─── Connection Management ───────────────────────────────────────────────
    async connect() {
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
            const response = await this.makeRequest('/federation/handshake', 'POST', { secret: this.config.secret, clientId: this.config.nodeId, capabilities: this.config.capabilities });
            this.sessionToken = response.sessionToken;
            this.serverId = response.serverId;
            this.status = 'connected';
            logger.success(`Federation: Connected to ${this.config.host}:${this.config.port} (server: ${response.serverId})`);
            this.emit('connected');
            return response;
        }
        catch (err) {
            this.status = 'error';
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('error', new Error(msg));
            throw err;
        }
    }
    disconnect() {
        this.sessionToken = null;
        this.serverId = null;
        this.status = 'disconnected';
        this.emit('disconnected');
        logger.info('Federation: Disconnected');
    }
    isConnected() { return this.status === 'connected' && !!this.sessionToken; }
    getStatus() { return this.status; }
    getServerId() { return this.serverId; }
    // ─── Task Delegation ─────────────────────────────────────────────────────
    async delegateTask(goal, agentType, options) {
        if (!this.isConnected())
            throw new Error('Not connected to federation server. Call connect() first.');
        const taskRequest = {
            goal, agentType,
            provider: options?.provider, model: options?.model,
            timeoutMs: options?.timeoutMs || this.config.taskTimeoutMs,
            streamProgress: options?.streamProgress !== false,
        };
        logger.info(`Federation: Delegating task to ${this.serverId || 'remote'} (${agentType})`);
        try {
            return await this.delegateWithStreaming(taskRequest);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`Federation: Streaming failed (${msg}), falling back to polling`);
            return this.delegateWithPolling(taskRequest);
        }
    }
    async delegateWithStreaming(request) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(request);
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
                'Authorization': `Bearer ${this.sessionToken}`,
                'Accept': 'text/event-stream',
            };
            const req = httpRequest({
                hostname: this.config.host,
                port: String(this.config.port),
                path: '/federation/task',
                method: 'POST',
                headers,
            }, (res) => {
                if (res.statusCode !== 200) {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk.toString(); });
                    res.on('end', () => reject(new Error(`Server returned ${res.statusCode}: ${data.slice(0, 200)}`)));
                    return;
                }
                let buffer = '';
                let taskResult = null;
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    let currentEvent = '';
                    let currentData = '';
                    for (const line of lines) {
                        if (line.startsWith('event: '))
                            currentEvent = line.slice(7).trim();
                        else if (line.startsWith('data: '))
                            currentData = line.slice(6).trim();
                        else if (line === '' && currentEvent === 'progress' && currentData) {
                            try {
                                const event = JSON.parse(currentData);
                                this.emit('task-progress', event);
                                if (event.status === 'completed' && event.result)
                                    taskResult = event.result;
                                else if (event.status === 'failed' && event.result)
                                    taskResult = event.result;
                            }
                            catch { /* ignore parse errors */ }
                            currentEvent = '';
                            currentData = '';
                        }
                    }
                });
                res.on('end', () => {
                    clearTimeout(reqTimer);
                    if (taskResult) {
                        this.emit(taskResult.success ? 'task-completed' : 'task-failed', taskResult);
                        resolve(taskResult);
                    }
                    else {
                        reject(new Error('Task ended without a result'));
                    }
                });
                res.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
            });
            const reqTimer = setTimeout(() => {
                req.destroy();
                reject(new Error(`Task timed out after ${request.timeoutMs || this.config.taskTimeoutMs}ms`));
            }, request.timeoutMs || this.config.taskTimeoutMs);
            req.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
            req.write(body);
            req.end();
        });
    }
    async delegateWithPolling(request) {
        const response = await this.makeRequest('/federation/task', 'POST', request);
        if (response.status === 'rejected')
            throw new Error(`Task rejected: ${response.reason || 'Unknown reason'}`);
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
            }
            catch { /* network error — server may be processing */ }
        }
        throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
    }
    // ─── Task Cancellation ───────────────────────────────────────────────────
    async cancelTask(taskId) {
        await this.makeRequest('/federation/cancel', 'POST', { taskId });
        logger.info(`Federation: Cancelled task ${taskId}`);
    }
    // ─── Health Check ────────────────────────────────────────────────────────
    async getHealth() {
        if (this.sessionToken) {
            return this.makeRequest('/federation/health', 'GET');
        }
        const response = await fetch(`http://${this.config.host}:${this.config.port}/federation/health`);
        const raw = await response.json();
        const payload = (raw?.type === 'response' ? raw.payload : raw);
        return payload;
    }
    // ─── Generic Request ─────────────────────────────────────────────────────
    async makeRequest(path, method, body) {
        return new Promise((resolve, reject) => {
            const bodyStr = body ? JSON.stringify(body) : undefined;
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (this.sessionToken)
                headers['Authorization'] = `Bearer ${this.sessionToken}`;
            if (bodyStr)
                headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
            const req = httpRequest({ hostname: this.config.host, port: String(this.config.port), path, method, headers }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk.toString(); });
                res.on('end', () => {
                    clearTimeout(reqTimer);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(data);
                            const payload = parsed.type === 'response' ? parsed.payload : parsed;
                            resolve(payload);
                        }
                        catch {
                            reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
                        }
                    }
                    else {
                        reject(new Error(`Federation request failed (${res.statusCode}): ${data.slice(0, 200)}`));
                    }
                });
                res.on('error', (err) => { clearTimeout(reqTimer); reject(err); });
            });
            const reqTimer = setTimeout(() => {
                req.destroy();
                reject(new Error(`Request to ${path} timed out`));
            }, 10_000);
            req.on('error', (err) => {
                clearTimeout(reqTimer);
                if (err.code === 'ECONNREFUSED') {
                    reject(new Error(`Connection refused to ${this.config.host}:${this.config.port}. Is the federation server running?`));
                }
                else {
                    reject(err);
                }
            });
            if (bodyStr)
                req.write(bodyStr);
            req.end();
        });
    }
}
//# sourceMappingURL=client.js.map