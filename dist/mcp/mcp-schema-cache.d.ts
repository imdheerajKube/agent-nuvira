/**
 * MCP Schema Cache — Caches tool/resource schemas from MCP servers.
 *
 * When an MCP server's tools are listed, the schemas are cached locally
 * so subsequent loads don't require re-connecting to the server. This
 * improves startup time and reduces MCP server load.
 *
 * Hermes equivalent: mcp_schema_cache.py
 */
import type { Tool, Resource, Prompt } from './types.js';
export interface CachedServerSchema {
    /** Server name */
    serverName: string;
    /** Cached tools */
    tools: Tool[];
    /** Cached resources */
    resources: Resource[];
    /** Cached prompts */
    prompts: Prompt[];
    /** Hash of the server config (for cache invalidation) */
    configHash: string;
    /** When the cache was created */
    cachedAt: number;
    /** When the cache expires (epoch ms) */
    expiresAt: number;
}
export interface SchemaCacheConfig {
    /** Cache directory */
    cacheDir?: string;
    /** Cache TTL in ms (default: 1 hour) */
    ttlMs?: number;
    /** Max cache size in bytes (default: 10MB) */
    maxSizeBytes?: number;
}
export declare class MCPSchemaCache {
    private cacheDir;
    private ttlMs;
    private maxSizeBytes;
    private cache;
    constructor(config?: SchemaCacheConfig);
    /**
     * Get cached schemas for a server.
     * Returns null if cache miss or expired.
     */
    get(serverName: string, configHash: string): CachedServerSchema | null;
    /**
     * Store schemas for a server.
     */
    set(serverName: string, configHash: string, tools: Tool[], resources: Resource[], prompts: Prompt[]): void;
    /**
     * Invalidate cache for a server.
     */
    invalidate(serverName: string): void;
    /**
     * Clear all cache.
     */
    clear(): void;
    /**
     * Get cache statistics.
     */
    getStats(): {
        servers: number;
        totalTools: number;
        totalResources: number;
        totalPrompts: number;
    };
    /**
     * Compute a hash of the server config for cache invalidation.
     */
    static computeConfigHash(config: Record<string, unknown>): string;
    private loadCache;
    private saveCache;
}
export declare function getMCPSchemaCache(): MCPSchemaCache;
export declare function resetMCPSchemaCache(): void;
//# sourceMappingURL=mcp-schema-cache.d.ts.map