/**
 * InspectModule — Scans the codebase to discover relevant files, extract
 * structural context, and identify dependencies. Phase 6 adds LLM-based
 * file classification with keyword-scanning fallback.
 *
 * @see ARCHITECTURE.md §3.2 — Inspect Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn } from './agent.js';
/**
 * A discovered file artifact with its content.
 * Prefixed with "Inspect" to avoid collision with agent.ts's Artifact type.
 */
export interface InspectArtifact {
    /** Relative path from the project root */
    path: string;
    /** Full file contents */
    content: string;
    /** Human-readable description (e.g. 'src/index.ts (12.5k characters)') */
    description: string;
}
/** Statistics about the inspection run */
export interface InspectionStats {
    /** Total files in the project */
    totalFiles: number;
    /** Files that were inspected / read */
    inspectedFiles: number;
    /** Number of errors encountered during inspection */
    errors: number;
    /** Whether the LLM-based classification fell back to keyword scanning */
    llmFallbackUsed: boolean;
}
/** Result of a codebase inspection */
export interface InspectionResult {
    /** Discovered file artifacts with full contents */
    artifacts: InspectArtifact[];
    /** Text representation of the project file tree */
    fileTree: string;
    /** File paths that are relevant to the goal */
    relevantPaths: string[];
    /** Inspection statistics */
    stats: InspectionStats;
}
/** Parameters for the InspectModule.inspect() method */
export interface InspectParams {
    /** The user's goal / task description */
    goal: string;
    /** Working directory of the project */
    workingDirectory: string;
    /** Optional list of task plan descriptions for context */
    taskDescriptions?: string[];
    /** Maximum number of files to inspect (default: 10) */
    maxFiles?: number;
    /**
     * Optional LLM call function for LLM-based file classification.
     * When provided, the module first asks the LLM to identify relevant
     * files. Falls back to keyword scanning if the LLM call fails.
     * When omitted, only keyword scanning is used.
     */
    callLLM?: LLMCallFn;
}
/**
 * PlanStep-like interface for dependency-aware planning.
 * A minimal version of what the PlanModule produces.
 */
export interface PlanStepRef {
    id: string;
    description: string;
}
/**
 * InspectModule — Scan the codebase to discover relevant files, extract
 * structural context, and identify dependencies.
 *
 * @example
 * ```typescript
 * const module = new DefaultInspectModule();
 * const result = await module.inspect({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 * });
 * console.log(result.artifacts.length); // Files discovered
 * ```
 */
export interface InspectModule {
    /**
     * Scan the codebase for files relevant to the given goal.
     * Uses LLM-based classification with keyword fallback.
     */
    inspect(params: InspectParams): Promise<InspectionResult>;
    /**
     * Synchronous fallback — scans files by keyword matching against the goal.
     * Used when the LLM call fails or times out.
     */
    scanByKeywords(goal: string, workingDir: string): string[];
}
/**
 * DefaultInspectModule — Built-in inspect module implementation.
 *
 * Wraps the existing keyword-scanning logic (previously private to
 * ContextGathererAgent) into the modular InspectModule interface.
 * The LLM-based file identification is delegated to the agent system
 * via the callLLM parameter — when no callLLM is provided, only
 * keyword-based scanning is used.
 */
export declare class DefaultInspectModule implements InspectModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Scan the codebase for files relevant to the given goal.
     * Phase 6: Uses LLM-based classification with keyword-scanning fallback.
     */
    inspect(params: InspectParams): Promise<InspectionResult>;
    /**
     * Synchronous fallback — scan files by keyword matching against the goal.
     * Used when the LLM call fails or as the base implementation.
     */
    scanByKeywords(goal: string, workingDir: string): string[];
    /**
     * Use the LLM to identify files relevant to the goal.
     * Parses the LLM response as a JSON array of file paths.
     * Throws if parsing fails or file list is empty.
     */
    private classifyFiles;
    /** Build the prompt for LLM-based file classification */
    private buildClassifyPrompt;
    /** Parse the LLM response into an array of file paths. Throws on failure. */
    private parseClassifyResponse;
    /** Walk the directory tree and score files by keyword relevance */
    private walkAndScore;
    /** Format byte count to human-readable string */
    private formatSize;
}
//# sourceMappingURL=inspect-module.d.ts.map