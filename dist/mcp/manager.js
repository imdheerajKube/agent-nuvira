/**
 * MCP Manager — Manages multiple MCP server connections.
 *
 * Discovers MCP server configurations from ~/.buff/mcp/ directory and
 * provides a unified interface for tool discovery and invocation across
 * all connected servers.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { MCPClient } from './client.js';
import { MCP_CONFIG_DIR, } from './types.js';
// ─── MCP Manager ────────────────────────────────────────────────────────────
export class MCPManager {
    clients = new Map();
    configDir;
    constructor(configDir) {
        this.configDir = configDir || join(homedir(), MCP_CONFIG_DIR);
    }
    // ─── Server Discovery ─────────────────────────────────────────────────────
    /**
     * Discover MCP server configurations from the config directory.
     * Looks for *.json files in ~/.buff/mcp/ and subdirectories.
     */
    discoverConfigs() {
        const configs = [];
        if (!existsSync(this.configDir)) {
            return configs;
        }
        try {
            const entries = readdirSync(this.configDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.json')) {
                    try {
                        const filePath = join(this.configDir, entry.name);
                        const raw = readFileSync(filePath, 'utf-8');
                        const config = JSON.parse(raw);
                        configs.push(config);
                    }
                    catch (err) {
                        logger.debug(`MCP: Failed to load config '${entry.name}': ${err}`);
                    }
                }
                // Also check subdirectories for config.json files
                if (entry.isDirectory()) {
                    const subConfigPath = join(this.configDir, entry.name, 'config.json');
                    if (existsSync(subConfigPath)) {
                        try {
                            const raw = readFileSync(subConfigPath, 'utf-8');
                            const config = JSON.parse(raw);
                            configs.push(config);
                        }
                        catch (err) {
                            logger.debug(`MCP: Failed to load sub-config '${entry.name}': ${err}`);
                        }
                    }
                }
            }
        }
        catch (err) {
            logger.debug(`MCP: Failed to scan config directory: ${err}`);
        }
        return configs;
    }
    // ─── Connection Management ────────────────────────────────────────────────
    /**
     * Connect to an MCP server by its name.
     * If already connected, returns the existing client.
     */
    async connect(name) {
        const existing = this.clients.get(name);
        if (existing && existing.connected) {
            return existing;
        }
        // Find the config for this server
        const configs = this.discoverConfigs();
        const config = configs.find((c) => c.name === name && c.enabled !== false);
        if (!config) {
            throw new Error(`MCP server '${name}' not found in ${this.configDir}. Create a JSON config file or check the name.`);
        }
        // Detached stdio children are the ones that need process-level reaping —
        // install the cleanup only for stdio configs so SSE-only setups don't pick
        // up signal-handler side effects.
        if (config.transport !== 'sse')
            installProcessCleanup();
        const client = new MCPClient(config);
        try {
            await client.connect();
        }
        catch (err) {
            // Failed connection: the client may already have spawned a stdio child
            // process or opened an SSE socket. It is NOT yet tracked in this.clients
            // (we only register on success), so disconnectAll() would never reach
            // it — explicitly tear it down here or the child process / socket leaks
            // and keeps the CLI process alive after the pipeline finishes.
            try {
                client.disconnect();
            }
            catch {
                // Best-effort cleanup
            }
            throw err;
        }
        this.clients.set(name, client);
        return client;
    }
    /**
     * Connect to all discovered MCP servers.
     */
    async connectAll() {
        const configs = this.discoverConfigs();
        const connected = [];
        for (const config of configs) {
            if (config.enabled === false)
                continue;
            try {
                const client = await this.connect(config.name);
                connected.push(client);
            }
            catch (err) {
                logger.debug(`MCP: Failed to connect to '${config.name}': ${err}`);
            }
        }
        return connected;
    }
    /**
     * Disconnect from a specific MCP server.
     */
    disconnect(name) {
        const client = this.clients.get(name);
        if (client) {
            client.disconnect();
            this.clients.delete(name);
        }
    }
    /**
     * Disconnect from all MCP servers.
     */
    disconnectAll() {
        for (const [name, client] of this.clients) {
            client.disconnect();
        }
        this.clients.clear();
    }
    // ─── Unified Tool Access ──────────────────────────────────────────────────
    /**
     * Get all tools from all connected MCP servers.
     */
    getAllTools() {
        const all = [];
        for (const [name, client] of this.clients) {
            if (client.connected) {
                for (const tool of client.tools) {
                    all.push({ server: name, tool });
                }
            }
        }
        return all;
    }
    /**
     * Call a tool by its name, searching across all connected servers.
     * If multiple servers have the same tool name, the first found is used.
     */
    async callTool(name, args) {
        for (const [serverName, client] of this.clients) {
            if (!client.connected)
                continue;
            const hasTool = client.tools.some((t) => t.name === name);
            if (hasTool) {
                const result = await client.callTool(name, args);
                return { server: serverName, result };
            }
        }
        return null;
    }
    /**
     * Get the state of all MCP servers (connected or not).
     */
    getAllStates() {
        const states = [];
        const configs = this.discoverConfigs();
        for (const config of configs) {
            const client = this.clients.get(config.name);
            if (client && client.connected) {
                states.push(client.state);
            }
            else {
                states.push({
                    name: config.name,
                    transport: config.transport,
                    status: 'disconnected',
                    tools: [],
                    resources: [],
                    prompts: [],
                });
            }
        }
        // Also include manually connected servers not in config
        for (const [name, client] of this.clients) {
            if (!states.find((s) => s.name === name)) {
                states.push(client.state);
            }
        }
        return states;
    }
    /**
     * Get a connected MCP client by server name.
     * Returns undefined if the server is not connected or doesn't exist.
     */
    getClient(name) {
        const client = this.clients.get(name);
        return client?.connected ? client : undefined;
    }
    /**
     * Check if a specific MCP server is connected.
     */
    isConnected(name) {
        return this.getClient(name) !== undefined;
    }
}
// ─── Singleton ───────────────────────────────────────────────────────────────
let _instance = null;
let processCleanupInstalled = false;
/**
 * Install one-time process-level cleanup for MCP children.
 *
 * stdio MCP children are spawned `detached: true` so disconnect() can SIGKILL
 * the whole process tree (negative pid). But a detached child lives in its own
 * process group, so a plain Ctrl+C / SIGTERM sent to the CLI never reaches it —
 * if the CLI dies without running resetMCPManager() (user interrupt, SIGTERM,
 * terminal close), those children survive as orphans and keep spawning new
 * processes every run. Register handlers that disconnectAll() (group-SIGKILL)
 * on every exit path, however the process dies.
 */
function installProcessCleanup() {
    if (processCleanupInstalled)
        return;
    processCleanupInstalled = true;
    const cleanup = () => {
        try {
            _instance?.disconnectAll();
        }
        catch {
            // Best-effort — the process is exiting anyway.
        }
    };
    // 'exit' covers process.exit() and normal termination. Dev-mode's own SIGINT
    // handler calls process.exit(0), so detached children still get reaped here.
    process.on('exit', cleanup);
    // Signals: clean up, then restore the default action so the process still
    // dies with the conventional signal exit status (130 for SIGINT, etc.).
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
    for (const signal of signals) {
        const onSignal = () => {
            cleanup();
            process.removeListener(signal, onSignal);
            try {
                process.kill(process.pid, signal);
            }
            catch {
                // Re-raise failed (process already dying, ESRCH, etc.) — never leave
                // the CLI alive after it consumed the signal; fall back to exiting
                // with the conventional 128+signo status.
                const code = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 }[signal] ?? 1;
                process.exit(code);
            }
        };
        process.on(signal, onSignal);
    }
}
export function getMCPManager() {
    if (!_instance) {
        _instance = new MCPManager();
    }
    return _instance;
}
export function resetMCPManager() {
    if (_instance) {
        _instance.disconnectAll();
        _instance = null;
    }
}
//# sourceMappingURL=manager.js.map