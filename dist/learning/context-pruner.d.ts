/**
 * ContextPruner — Strict context-window memory pruner for multi-agent chains.
 *
 * As agents execute sequentially, the shared AgentContext bus grows with:
 * - Artifacts (file contents read by the context-gatherer)
 * - Conversations (agent-to-agent messages)
 * - File changes (WriterAgent outputs with full file contents)
 * - Metadata (memory context, patterns, etc.)
 *
 * Without pruning, long multi-agent chains can exceed the model's context
 * window (e.g., 128K tokens), causing truncation errors or inflated costs.
 *
 * The ContextPruner:
 * 1. Estimates token counts for each context component
 * 2. Applies pruning strategies when the total exceeds a threshold (default 80%)
 * 3. Logs detailed metrics on what was pruned
 * 4. Supports configurable thresholds and model-specific limits
 *
 * Usage (inside Orchestrator):
 *   const pruner = new ContextPruner({ maxTokens: 128000 });
 *   const result = pruner.prune(vault.context);
 *   if (result.pruned) logger.debug(`Pruned ${result.reduction}% of context`);
 */
import type { AgentContext } from '../agents/agent.js';
export interface ContextPrunerOptions {
    /**
     * Maximum total context tokens before pruning becomes mandatory.
     * Default: 128000 (common for Llama-3, Groq, OpenRouter models).
     * For Gemini (1M context), set higher.
     */
    maxTokens?: number;
    /**
     * Pruning threshold as a ratio of maxTokens (0.0 – 1.0).
     * Default: 0.8 — pruning activates when context reaches 80% of maxTokens.
     * At 1.0, pruning only activates when over the hard limit.
     */
    thresholdRatio?: number;
    /**
     * How aggressively to prune conversations.
     * - 'soft' (default): keep the last N messages, summarize the rest
     * - 'medium': keep only the last 5 messages, drop the rest
     * - 'aggressive': keep only the last 2 messages
     */
    conversationMode?: 'soft' | 'medium' | 'aggressive';
    /**
     * Whether to allow removing large artifacts to stay under limits.
     * Default: true
     */
    canRemoveArtifacts?: boolean;
    /**
     * Whether to collapse file changes to just paths/status (dropping content).
     * Default: true
     */
    canCollapseFileChanges?: boolean;
    /**
     * Whether to strip non-essential metadata keys.
     * Default: true
     */
    canStripMetadata?: boolean;
    /**
     * Maximum chars per artifact before it's summarized.
     * Default: 2000
     */
    maxArtifactChars?: number;
}
export interface ContextTokenBreakdown {
    goalTokens: number;
    taskPlanTokens: number;
    artifactsTokens: number;
    conversationsTokens: number;
    fileChangesTokens: number;
    metadataTokens: number;
    totalTokens: number;
}
export interface PruneDetail {
    /** Number of conversation messages truncated */
    conversationsTruncated: number;
    /** Number of artifacts that were summarized (truncated) */
    artifactsSummarized: number;
    /** Number of artifacts removed entirely */
    artifactsRemoved: number;
    /** Number of metadata keys stripped */
    metadataRemoved: number;
    /** Number of file changes collapsed (content dropped) */
    fileChangesCollapsed: number;
}
export interface PruneResult {
    /** Whether any pruning was applied */
    pruned: boolean;
    /** Token estimate before pruning */
    tokensBefore: number;
    /** Token estimate after pruning */
    tokensAfter: number;
    /** Reduction percentage (0–100) */
    reductionPct: number;
    /** Detailed breakdown of what happened */
    details: PruneDetail;
}
export declare class ContextPruner {
    private options;
    constructor(options?: ContextPrunerOptions);
    /**
     * Estimate the number of tokens in a text string.
     * Uses the same heuristic as the CostTracker for consistency.
     */
    estimateTokens(text: string): number;
    /**
     * Analyze the context and return a token count breakdown per component.
     * Useful for monitoring and display, does NOT modify the context.
     */
    analyze(context: AgentContext): ContextTokenBreakdown;
    /**
     * Check whether the context is over the pruning threshold.
     * An estimate based on string length — faster than a real tokenizer.
     */
    isOverThreshold(context: AgentContext): boolean;
    /**
     * Prune the context if it exceeds the configured threshold.
     * Returns details of what was pruned, or a no-op result if nothing was needed.
     *
     * Strategies applied in order (least-destructive first):
     * 1. Strip non-essential metadata
     * 2. Collapse file changes (drop content, keep paths + status)
     * 3. Truncate conversation history
     * 4. Summarize large artifacts
     * 5. Remove low-priority artifacts (if still over limit)
     */
    prune(context: AgentContext): PruneResult;
    /**
     * Get a human-readable summary of the last prune result.
     */
    formatPruneResult(result: PruneResult): string;
    /**
     * Remove non-essential metadata keys.
     * Keeps: projectFileTree, memoryContext, patternContext, runResult, sandboxPath
     * Strips: LLM responses, intermediate results, debug info
     */
    private stripMetadata;
    /**
     * Collapse file changes to just paths and status, dropping the full content.
     * Keeps the path and status metadata but removes newContent/originalContent
     * strings that can be hundreds of KB.
     */
    private collapseFileChanges;
    /**
     * Truncate conversation history based on the configured mode.
     * - soft: keep last 10 messages
     * - medium: keep last 5 messages
     * - aggressive: keep last 2 messages
     */
    private pruneConversations;
    /**
     * Summarize large artifacts by truncating their content.
     * Artifacts with content exceeding maxArtifactChars get truncated to
     * maxArtifactChars with a note. Artifacts with no content are removed.
     */
    private summarizeArtifacts;
}
//# sourceMappingURL=context-pruner.d.ts.map