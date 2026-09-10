/**
 * lazy_deps — Lazy dependency loading for tools.
 * Only imports heavy modules when a tool is actually invoked, reducing startup time.
 */
declare class LazyDepsManager {
    private modules;
    private loadHistory;
    private preloadQueue;
    /**
     * Register a lazy module that will only be loaded when first accessed.
     */
    register(name: string, loader: () => Promise<any>): void;
    /**
     * Load a module by name (lazy or explicit).
     */
    load(name: string): Promise<any>;
    /**
     * Get status of all registered modules.
     */
    getStatus(): {
        name: string;
        loaded: boolean;
        loadTime: number;
    }[];
    /**
     * Get load statistics.
     */
    getStats(): {
        total: number;
        loaded: number;
        avgLoadTime: number;
        totalLoadTime: number;
    };
    /**
     * Preload modules in background (non-blocking).
     */
    preload(names: string[]): Promise<void>;
    /**
     * Get the load history.
     */
    getHistory(): {
        name: string;
        time: number;
        timestamp: number;
    }[];
    /**
     * Reset all modules to unloaded state.
     */
    reset(): void;
}
export declare function getLazyDepsManager(): LazyDepsManager;
export { LazyDepsManager };
//# sourceMappingURL=lazy-deps.d.ts.map