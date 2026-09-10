/**
 * MCP Schema Cache — Caches tool/resource schemas from MCP servers.
 *
 * When an MCP server's tools are listed, the schemas are cached locally
 * so subsequent loads don't require re-connecting to the server. This
 * improves startup time and reduces MCP server load.
 *
 * Hermes equivalent: mcp_schema_cache.py
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Schema Cache ─────────────────────────────────────────────────────────
const DEFAULT_CACHE_DIR = join(resolveNuviraHome(), 'mcp', 'cache');
const DEFAULT_TTL_MS = 3600_000; // 1 hour
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const CACHE_FILE = 'schemas.json';
export class MCPSchemaCache {
    cacheDir;
    ttlMs;
    maxSizeBytes;
    cache = new Map();
    constructor(config) {
        this.cacheDir = config?.cacheDir || DEFAULT_CACHE_DIR;
        this.ttlMs = config?.ttlMs || DEFAULT_TTL_MS;
        this.maxSizeBytes = config?.maxSizeBytes || DEFAULT_MAX_SIZE;
        this.loadCache();
    }
    // ─── Cache Operations ────────────────────────────────────────────────
    /**
     * Get cached schemas for a server.
     * Returns null if cache miss or expired.
     */
    get(serverName, configHash) {
        const cached = this.cache.get(serverName);
        if (!cached)
            return null;
        // Check config hash (cache invalidation)
        if (cached.configHash !== configHash) {
            logger.debug(`MCP Schema Cache: Config changed for '${serverName}', cache invalid`);
            this.cache.delete(serverName);
            return null;
        }
        // Check expiration
        if (cached.expiresAt < Date.now()) {
            logger.debug(`MCP Schema Cache: Cache expired for '${serverName}'`);
            this.cache.delete(serverName);
            return null;
        }
        return cached;
    }
    /**
     * Store schemas for a server.
     */
    set(serverName, configHash, tools, resources, prompts) {
        const entry = {
            serverName,
            tools,
            resources,
            prompts,
            configHash,
            cachedAt: Date.now(),
            expiresAt: Date.now() + this.ttlMs,
        };
        this.cache.set(serverName, entry);
        this.saveCache();
    }
    /**
     * Invalidate cache for a server.
     */
    invalidate(serverName) {
        this.cache.delete(serverName);
        this.saveCache();
    }
    /**
     * Clear all cache.
     */
    clear() {
        this.cache.clear();
        this.saveCache();
    }
    /**
     * Get cache statistics.
     */
    getStats() {
        let totalTools = 0;
        let totalResources = 0;
        let totalPrompts = 0;
        for (const entry of this.cache.values()) {
            totalTools += entry.tools.length;
            totalResources += entry.resources.length;
            totalPrompts += entry.prompts.length;
        }
        return {
            servers: this.cache.size,
            totalTools,
            totalResources,
            totalPrompts,
        };
    }
    // ─── Config Hash ─────────────────────────────────────────────────────
    /**
     * Compute a hash of the server config for cache invalidation.
     */
    static computeConfigHash(config) {
        const stable = JSON.stringify(config, Object.keys(config).sort());
        return createHash('sha256').update(stable).digest('hex').slice(0, 16);
    }
    // ─── Persistence ─────────────────────────────────────────────────────
    loadCache() {
        try {
            const cachePath = join(this.cacheDir, CACHE_FILE);
            if (existsSync(cachePath)) {
                const data = readFileSync(cachePath, 'utf-8');
                const parsed = JSON.parse(data);
                // Filter out expired entries
                const now = Date.now();
                for (const [key, value] of Object.entries(parsed)) {
                    if (value.expiresAt > now) {
                        this.cache.set(key, value);
                    }
                }
                logger.debug(`MCP Schema Cache: Loaded ${this.cache.size} cached schemas`);
            }
        }
        catch {
            // Ignore load errors
        }
    }
    saveCache() {
        try {
            if (!existsSync(this.cacheDir)) {
                mkdirSync(this.cacheDir, { recursive: true });
            }
            const data = {};
            for (const [key, value] of this.cache.entries()) {
                data[key] = value;
            }
            const json = JSON.stringify(data, null, 2);
            // Check size limit
            if (Buffer.byteLength(json) > this.maxSizeBytes) {
                // Evict oldest entries
                const entries = [...this.cache.entries()]
                    .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
                this.cache.clear();
                for (let i = Math.floor(entries.length * 0.5); i < entries.length; i++) {
                    this.cache.set(entries[i][0], entries[i][1]);
                }
                this.saveCache();
                return;
            }
            writeFileSync(join(this.cacheDir, CACHE_FILE), json);
        }
        catch (err) {
            logger.warn(`MCP Schema Cache: Failed to save cache: ${err}`);
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getMCPSchemaCache() {
    if (!_instance) {
        _instance = new MCPSchemaCache();
    }
    return _instance;
}
export function resetMCPSchemaCache() {
    _instance = null;
}
//# sourceMappingURL=mcp-schema-cache.js.map