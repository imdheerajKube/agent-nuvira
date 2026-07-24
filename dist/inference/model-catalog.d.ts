/**
 * Model Catalog — Categorizes AI models by capability so users can pick
 * the right model for their task.
 *
 * Each model is tagged with one or more categories based on its ID pattern.
 * The model picker uses these categories to group models with icons,
 * descriptions, and recommendation badges.
 */
/** Category identifier used internally */
export type ModelCategory = 'chat' | 'code' | 'reasoning' | 'fast' | 'creative' | 'vision' | 'instruct' | 'agentic' | 'preview' | 'speech' | 'other';
/** Display metadata for each category */
export interface CategoryInfo {
    /** Icon shown next to the category header */
    icon: string;
    /** Short human-readable label */
    label: string;
    /** Explanation of what this category is good for */
    description: string;
}
/**
 * Display info for every category.
 * Ordered roughly by popularity / usefulness.
 */
export declare const CATEGORY_INFO: Record<ModelCategory, CategoryInfo>;
/**
 * Determine the category for a given model ID.
 * Uses pattern matching against known model naming conventions.
 *
 * @param modelId The model identifier (e.g., "llama-3.3-70b-versatile")
 * @param owner   Optional owner/organization hint (e.g., "meta", "google")
 * @returns The best-matching category, defaulting to 'other'
 */
export declare function categorizeModel(modelId: string, _owner?: string): ModelCategory;
/**
 * Get ALL applicable category tags for a model.
 * This returns multiple categories so a model can be shown in multiple groups.
 *
 * Example: "llama-3.1-8b-instant" → ['chat', 'fast', 'instruct']
 */
export declare function getModelTags(modelId: string, _owner?: string): string[];
/**
 * Returns a human-friendly label for a model ID, stripping provider prefixes
 * and formatting nicely.
 *
 * Example: "meta-llama/llama-3.3-70b-instruct" → "Llama 3.3 70B Instruct"
 */
export declare function formatModelName(modelId: string): string;
/**
 * Get a recommendation badge / description for a model.
 * Some well-known models get a short blurb about what they excel at.
 */
export declare function getModelBadge(modelId: string): string | undefined;
//# sourceMappingURL=model-catalog.d.ts.map