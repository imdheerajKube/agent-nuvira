/**
 * Dynamic Model Catalog — generates badges and descriptions from model metadata
 * patterns, NOT hardcoded model names. This ensures the system adapts when
 * providers add/remove models without code changes.
 *
 * Design principles:
 * 1. Pattern-based: Match model IDs by patterns (e.g., "70b" = large, "flash" = fast)
 * 2. Metadata-driven: Use provider-reported info (context window, capabilities)
 * 3. Self-healing: Stale entries are automatically removed
 * 4. No code changes: Providers can add/remove models freely
 */
import type { ModelDescriptor } from './interface.js';
/**
 * Generate a badge for a model based on its ID pattern.
 * Falls back to context-window-based heuristics if no pattern matches.
 */
export declare function generateDynamicBadge(modelId: string, meta?: ModelDescriptor): string | undefined;
export type ModelCategory = 'chat' | 'code' | 'reasoning' | 'fast' | 'creative' | 'vision' | 'speech' | 'embedding' | 'safety' | 'other';
/**
 * Detect the category of a model based on its ID pattern.
 * This replaces hardcoded category assignments.
 */
export declare function detectModelCategory(modelId: string): ModelCategory;
/**
 * Score a model's quality based on its metadata.
 * Used for automatic model ranking without hardcoded preferences.
 */
export declare function scoreModelQuality(modelId: string, meta?: ModelDescriptor): number;
/**
 * Check if a model is likely stale based on its last-seen timestamp.
 * Models not seen in the provider's listModels() for >7 days are suspect.
 */
export declare function isModelStale(lastProbedAt: number, now?: number): boolean;
/**
 * Check if a model is likely removed by the provider.
 * Models not seen for >30 days with errors are probably gone.
 */
export declare function isModelProbablyRemoved(lastProbedAt: number, errorRate: number, now?: number): boolean;
//# sourceMappingURL=dynamic-catalog.d.ts.map