/**
 * Context cache for inference results.
 * Uses a simple JSON file — no native dependencies, works everywhere.
 */
export declare class InferenceCache {
    /**
     * Get cached response if available and not expired
     */
    get(prompt: string, model: string, provider: string): Promise<string | null>;
    /**
     * Store a response in the cache
     */
    set(prompt: string, response: string, model: string, provider: string, ttl?: number): Promise<void>;
    /**
     * Clear all cache entries
     */
    clear(): Promise<void>;
    /**
     * Get cache statistics
     */
    stats(): Promise<{
        total: number;
        providers: Record<string, number>;
    }>;
}
export declare function getCache(): InferenceCache;
//# sourceMappingURL=cache.d.ts.map