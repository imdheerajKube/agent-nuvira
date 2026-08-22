/**
 * lazy_deps — Lazy dependency loading for tools.
 * Only imports heavy modules when a tool is actually invoked, reducing startup time.
 */

import * as fs from 'fs';
import * as path from 'path';

interface LazyModule {
  name: string;
  loaded: boolean;
  module: any;
  loadTime: number;
}

class LazyDepsManager {
  private modules = new Map<string, LazyModule>();
  private loadHistory: { name: string; time: number; timestamp: number }[] = [];
  private preloadQueue: string[] = [];

  /**
   * Register a lazy module that will only be loaded when first accessed.
   */
  register(name: string, loader: () => Promise<any>): void {
    this.modules.set(name, {
      name,
      loaded: false,
      module: null,
      loadTime: 0,
    });
    // Store loader for later
    (this.modules.get(name) as any)._loader = loader;
  }

  /**
   * Load a module by name (lazy or explicit).
   */
  async load(name: string): Promise<any> {
    const entry = this.modules.get(name);
    if (!entry) {
      throw new Error(`Module '${name}' not registered for lazy loading`);
    }
    if (entry.loaded) {
      return entry.module;
    }

    const start = Date.now();
    const loader = (entry as any)._loader;
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
  getStatus(): { name: string; loaded: boolean; loadTime: number }[] {
    return Array.from(this.modules.values()).map(m => ({
      name: m.name,
      loaded: m.loaded,
      loadTime: m.loadTime,
    }));
  }

  /**
   * Get load statistics.
   */
  getStats(): { total: number; loaded: number; avgLoadTime: number; totalLoadTime: number } {
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
  async preload(names: string[]): Promise<void> {
    this.preloadQueue = names;
    // Don't await — let them load in background
    Promise.all(names.map(n => this.load(n).catch(() => null)));
  }

  /**
   * Get the load history.
   */
  getHistory(): { name: string; time: number; timestamp: number }[] {
    return [...this.loadHistory];
  }

  /**
   * Reset all modules to unloaded state.
   */
  reset(): void {
    for (const entry of this.modules.values()) {
      entry.loaded = false;
      entry.module = null;
      entry.loadTime = 0;
    }
    this.loadHistory = [];
  }
}

let _instance: LazyDepsManager | null = null;

export function getLazyDepsManager(): LazyDepsManager {
  if (!_instance) _instance = new LazyDepsManager();
  return _instance;
}

export { LazyDepsManager };
