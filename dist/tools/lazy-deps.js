/**
 * lazy_deps — Lazy dependency loading for tools.
 * Only imports heavy modules when a tool is actually invoked, reducing startup time.
 */
class LazyDepsManager {
    modules = new Map();
    loadHistory = [];
    preloadQueue = [];
    /**
     * Register a lazy module that will only be loaded when first accessed.
     */
    register(name, loader) {
        this.modules.set(name, {
            name,
            loaded: false,
            module: null,
            loadTime: 0,
        });
        // Store loader for later
        this.modules.get(name)._loader = loader;
    }
    /**
     * Load a module by name (lazy or explicit).
     */
    async load(name) {
        const entry = this.modules.get(name);
        if (!entry) {
            throw new Error(`Module '${name}' not registered for lazy loading`);
        }
        if (entry.loaded) {
            return entry.module;
        }
        const start = Date.now();
        const loader = entry._loader;
        if (!loader) {
            throw new Error(`No loader registered for module '${name}'`);
        }
        entry.module = await loader();
        entry.loaded = true;
        entry.loadTime = Date.now() - start;
        this.loadHistory.push({ name, time: entry.loadTime, timestamp: Date.now() });
        return entry.module;
    }
    /**
     * Get status of all registered modules.
     */
    getStatus() {
        return Array.from(this.modules.values()).map(m => ({
            name: m.name,
            loaded: m.loaded,
            loadTime: m.loadTime,
        }));
    }
    /**
     * Get load statistics.
     */
    getStats() {
        const all = Array.from(this.modules.values());
        const loaded = all.filter(m => m.loaded);
        const totalTime = loaded.reduce((sum, m) => sum + m.loadTime, 0);
        return {
            total: all.length,
            loaded: loaded.length,
            avgLoadTime: loaded.length > 0 ? Math.round(totalTime / loaded.length) : 0,
            totalLoadTime: totalTime,
        };
    }
    /**
     * Preload modules in background (non-blocking).
     */
    async preload(names) {
        this.preloadQueue = names;
        // Don't await — let them load in background
        Promise.all(names.map(n => this.load(n).catch(() => null)));
    }
    /**
     * Get the load history.
     */
    getHistory() {
        return [...this.loadHistory];
    }
    /**
     * Reset all modules to unloaded state.
     */
    reset() {
        for (const entry of this.modules.values()) {
            entry.loaded = false;
            entry.module = null;
            entry.loadTime = 0;
        }
        this.loadHistory = [];
    }
}
let _instance = null;
export function getLazyDepsManager() {
    if (!_instance)
        _instance = new LazyDepsManager();
    return _instance;
}
export { LazyDepsManager };
//# sourceMappingURL=lazy-deps.js.map