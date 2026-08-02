/**
 * EditModule — Generates code changes from task descriptions and file context.
 * Phase 7 of the architecture migration: extract from WriterAgent into
 * a pluggable module with EventBus integration.
 *
 * The module reads relevant files, calls an LLM to generate modified versions,
 * parses file changes from the response, validates syntax via AST analysis,
 * and returns structured FileChange objects — without writing to disk.
 *
 * @see ARCHITECTURE.md §3.3 — Edit Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn, FileChange, Artifact } from './agent.js';
/** Parameters for the EditModule.edit() method */
export interface EditParams {
    /** The original user goal / task description */
    goal: string;
    /** Absolute path to the working directory */
    workingDirectory: string;
    /** File artifacts discovered during the inspection phase */
    artifacts: Artifact[];
    /** The LLM call function */
    callLLM: LLMCallFn;
    /** Optional structured context overrides */
    taskDescription?: string;
    /** Optional MCP tools description for the LLM */
    mcpToolsFormatted?: string;
    /** Optional rate limit callback */
    onRateLimit?: (info: {
        retryAfterMs: number;
        modelName?: string;
        agentName: string;
        errorMessage: string;
    }) => Promise<{
        action: 'retry' | 'skip' | 'abort' | 'switch-model';
        callLLM?: LLMCallFn;
    }>;
    /** Whether this is a retry attempt (stricter prompt) */
    isRetry?: boolean;
    /**
     * Enable deterministic tier-0 routing (mechanical edits short-circuit the
     * LLM entirely — remove console.log, rename a symbol, dedupe imports).
     * Default: true. Set to false to always use the LLM.
     */
    useTier0?: boolean;
}
/** Output of the edit phase */
export interface EditOutput {
    /** File changes generated */
    changes: FileChange[];
    /** Human-readable summary */
    summary: string;
    /** How many files were changed */
    changeCount: number;
    /** Syntax warnings, if any */
    warnings?: string[];
}
/**
 * EditModule — Generate code changes from task descriptions and file context.
 *
 * The module reads files, calls the LLM to generate modified versions, parses
 * the response, validates syntax, and returns structured FileChange objects.
 *
 * @example
 * ```typescript
 * const module = new DefaultEditModule();
 * const result = await module.edit({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 *   artifacts: inspectedFiles,
 *   callLLM,
 * });
 * console.log(`Changed ${result.changeCount} files`);
 * ```
 */
export interface EditModule {
    /**
     * Generate file changes from the given task and file context.
     */
    edit(params: EditParams): Promise<EditOutput>;
}
/**
 * DefaultEditModule — Built-in edit module implementation.
 *
 * Builds a prompt from file artifacts and task description; calls the LLM;
 * parses file changes from the response; validates syntax via AST analysis;
 * and returns structured FileChange objects without writing to disk.
 */
export declare class DefaultEditModule implements EditModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Generate file changes from the given task and file context.
     */
    edit(params: EditParams): Promise<EditOutput>;
    /**
     * Build the LLM prompt from file artifacts and task description.
     */
    private buildPrompt;
    /**
     * Select files within the character budget, prioritizing smaller files.
     */
    private selectFilesWithinBudget;
    /**
     * Parse the LLM response to extract file changes.
     */
    private parseFileChanges;
    /**
     * Add a file change entry, comparing with existing content if the file exists.
     */
    private addFileChange;
    /**
     * Validate file changes via AST syntax checking.
     * Returns warning messages for any files with unbalanced syntax.
     */
    private validateChanges;
    /**
     * Check if an error message indicates a rate-limit (429) error.
     */
    private isRateLimitError;
    /**
     * Parse the "try again in Xs" hint from a rate-limit error response.
     */
    private parseRetryAfterHint;
}
//# sourceMappingURL=edit-module.d.ts.map