/**
 * Project Tools — Blueprint templates and working diff tracking.
 *
 * Hermes equivalent: blueprints.py + working_diff.py
 *
 * Provides:
 * - Blueprint templates for project scaffolding
 * - Working diff tracking for changes
 */
export interface Blueprint {
    /** Blueprint ID */
    id: string;
    /** Blueprint name */
    name: string;
    /** Description */
    description: string;
    /** Category */
    category: string;
    /** Files to create */
    files: BlueprintFile[];
    /** Variables to substitute */
    variables: BlueprintVariable[];
    /** Created at */
    createdAt: number;
}
export interface BlueprintFile {
    /** File path (relative) */
    path: string;
    /** File content (with {{variable}} placeholders) */
    content: string;
    /** File type */
    type: 'file' | 'directory' | 'template';
}
export interface BlueprintVariable {
    /** Variable name */
    name: string;
    /** Description */
    description: string;
    /** Default value */
    defaultValue?: string;
    /** Whether required */
    required: boolean;
}
export interface WorkingDiff {
    /** Diff ID */
    id: string;
    /** File path */
    filePath: string;
    /** Diff content */
    diff: string;
    /** Whether applied */
    applied: boolean;
    /** Created at */
    createdAt: number;
}
export declare class BlueprintManager {
    private blueprints;
    constructor();
    /**
     * Create a new blueprint.
     */
    create(options: {
        name: string;
        description: string;
        category: string;
        files: BlueprintFile[];
        variables?: BlueprintVariable[];
    }): Blueprint;
    /**
     * Get a blueprint by ID.
     */
    get(blueprintId: string): Blueprint | null;
    /**
     * Get all blueprints.
     */
    getAll(): Blueprint[];
    /**
     * Get blueprints by category.
     */
    getByCategory(category: string): Blueprint[];
    /**
     * Search blueprints.
     */
    search(query: string): Blueprint[];
    /**
     * Scaffold a project from a blueprint.
     */
    scaffold(blueprintId: string, targetDir: string, variables?: Record<string, string>): {
        files: string[];
        errors: string[];
    };
    /**
     * Delete a blueprint.
     */
    delete(blueprintId: string): boolean;
    private seedDefaultBlueprints;
    private load;
    private save;
}
export declare class WorkingDiffTracker {
    private diffs;
    constructor();
    /**
     * Record a working diff.
     */
    record(filePath: string, diff: string): WorkingDiff;
    /**
     * Mark a diff as applied.
     */
    markApplied(diffId: string): boolean;
    /**
     * Get all diffs for a file.
     */
    getFileDiffs(filePath: string): WorkingDiff[];
    /**
     * Get unapplied diffs.
     */
    getUnappliedDiffs(): WorkingDiff[];
    /**
     * Get all diffs.
     */
    getAllDiffs(): WorkingDiff[];
    /**
     * Clear applied diffs.
     */
    clearApplied(): number;
    private load;
    private save;
}
export declare function getBlueprintManager(): BlueprintManager;
export declare function getWorkingDiffTracker(): WorkingDiffTracker;
//# sourceMappingURL=project-tools.d.ts.map