/**
 * ContextGathererAgent — Scans the codebase to find files relevant to the user's
 * goal and execution plan. It reads file contents and stores them as artifacts
 * in the shared context bus for downstream agents (Writer, Reviewer) to use.
 *
 * Rate-limit handling:
 * - Short waits (<3s): auto-retry silently
 * - Long waits (>=3s): invokes onRateLimit callback (if available) to let the
 *   user choose: wait, switch model, skip (falls back to keyword scan), or abort
 * - Other LLM errors: caught gracefully, falls back to keyword scanning
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * ContextGathererAgent — Discovers and reads relevant files from the codebase.
 */
export declare class ContextGathererAgent extends Agent {
    readonly name = "Context Gatherer";
    readonly description = "Scans the codebase and identifies relevant files";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Call identifyRelevantFiles with a retry loop that handles rate-limit errors
     * via the onRateLimit callback.
     */
    private identifyWithRetry;
    /**
     * Ask the LLM to identify which files are relevant to the goal.
     * Non-rate-limit errors are caught internally (falls back to keyword scanning).
     * Rate-limit errors are re-thrown so identifyWithRetry can handle them.
     */
    private identifyRelevantFiles;
    /**
     * Extract an array of file paths from the LLM response.
     */
    private extractPaths;
    private tryParseJson;
    /** Fallback keyword-based file scanning when LLM is unavailable */
    private scanByKeywords;
    private walkAndScore;
    private formatSize;
}
//# sourceMappingURL=context-gatherer.d.ts.map