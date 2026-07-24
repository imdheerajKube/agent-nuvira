import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const CACHE_DIR = join(homedir(), '.buff');
const CACHE_PATH = join(CACHE_DIR, 'cache.json');
function ensureDir() {
    if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
    }
}
function readCache() {
    try {
        ensureDir();
        if (!existsSync(CACHE_PATH)) {
            return { entries: {} };
        }
        const raw = readFileSync(CACHE_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { entries: {} };
    }
}
function writeCache(data) {
    ensureDir();
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
/**
 * Remove expired entries from the cache data in-place
 */
function pruneExpired(data) {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, entry] of Object.entries(data.entries)) {
        if (entry.createdAt + entry.ttl < now) {
            delete data.entries[key];
        }
    }
}
/**
 * Generate a cache key from the prompt and options
 */
function generateKey(prompt, model, provider) {
    const hash = createHash('sha256')
        .update(`${provider}:${model}:${prompt}`)
        .digest('hex');
    return hash;
}
/**
 * Context cache for inference results.
 * Uses a simple JSON file — no native dependencies, works everywhere.
 */
export class InferenceCache {
    /**
     * Get cached response if available and not expired
     */
    async get(prompt, model, provider) {
        const data = readCache();
        const key = generateKey(prompt, model, provider);
        const entry = data.entries[key];
        if (!entry)
            return null;
        const now = Math.floor(Date.now() / 1000);
        if (entry.createdAt + entry.ttl < now) {
            // Expired — remove it
            delete data.entries[key];
            writeCache(data);
            return null;
        }
        return entry.response;
    }
    /**
     * Store a response in the cache
     */
    async set(prompt, response, model, provider, ttl = 3600) {
        const data = readCache();
        pruneExpired(data); // Clean up expired entries before writing
        const key = generateKey(prompt, model, provider);
        data.entries[key] = {
            response,
            model,
            provider,
            createdAt: Math.floor(Date.now() / 1000),
            ttl,
        };
        writeCache(data);
    }
    /**
     * Clear all cache entries
     */
    async clear() {
        writeCache({ entries: {} });
    }
    /**
     * Get cache statistics
     */
    async stats() {
        const data = readCache();
        pruneExpired(data);
        const total = Object.keys(data.entries).length;
        const providers = {};
        for (const entry of Object.values(data.entries)) {
            providers[entry.provider] = (providers[entry.provider] || 0) + 1;
        }
        return { total, providers };
    }
}
// Singleton instance
let cacheInstance = null;
export function getCache() {
    if (!cacheInstance) {
        cacheInstance = new InferenceCache();
    }
    return cacheInstance;
}
//# sourceMappingURL=cache.js.map