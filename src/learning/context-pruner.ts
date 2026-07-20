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

import type { AgentContext, Artifact, FileChange, AgentMessage } from '../agents/agent.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<ContextPrunerOptions> = {
  maxTokens: 128_000,
  thresholdRatio: 0.8,
  conversationMode: 'soft',
  canRemoveArtifacts: true,
  canCollapseFileChanges: true,
  canStripMetadata: true,
  maxArtifactChars: 2_000,
};

/** Rough heuristic: ~4 characters per token for code, ~5 for prose */
const CHARS_PER_TOKEN = 4.5;

// ─── ContextPruner ──────────────────────────────────────────────────────────

export class ContextPruner {
  private options: Required<ContextPrunerOptions>;

  constructor(options?: ContextPrunerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Estimate the number of tokens in a text string.
   * Uses the same heuristic as the CostTracker for consistency.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Analyze the context and return a token count breakdown per component.
   * Useful for monitoring and display, does NOT modify the context.
   */
  analyze(context: AgentContext): ContextTokenBreakdown {
    const goalTokens = this.estimateTokens(context.goal);
    const taskPlanTokens = this.estimateTokens(JSON.stringify(context.taskPlan));
    const artifactsTokens = this.estimateTokens(
      context.artifacts.map((a) => `${a.path}\n${a.content}`).join('\n\n'),
    );
    const conversationsTokens = this.estimateTokens(
      context.conversations.map((m) => `[${m.from} → ${m.to}] ${m.content}`).join('\n'),
    );
    const fileChangesTokens = this.estimateTokens(
      context.fileChanges
        .map((fc) => `${fc.path}\n${fc.newContent || fc.originalContent || ''}`)
        .join('\n\n'),
    );
    const metadataTokens = this.estimateTokens(JSON.stringify(context.metadata));

    const totalTokens =
      goalTokens + taskPlanTokens + artifactsTokens +
      conversationsTokens + fileChangesTokens + metadataTokens;

    return {
      goalTokens,
      taskPlanTokens,
      artifactsTokens,
      conversationsTokens,
      fileChangesTokens,
      metadataTokens,
      totalTokens,
    };
  }

  /**
   * Check whether the context is over the pruning threshold.
   * An estimate based on string length — faster than a real tokenizer.
   */
  isOverThreshold(context: AgentContext): boolean {
    const breakdown = this.analyze(context);
    const threshold = this.options.maxTokens * this.options.thresholdRatio;
    return breakdown.totalTokens > threshold;
  }

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
  prune(context: AgentContext): PruneResult {
    const before = this.analyze(context);
    const tokensBefore = before.totalTokens;
    const details: PruneDetail = {
      conversationsTruncated: 0,
      artifactsSummarized: 0,
      artifactsRemoved: 0,
      metadataRemoved: 0,
      fileChangesCollapsed: 0,
    };

    if (!this.isOverThreshold(context)) {
      return {
        pruned: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reductionPct: 0,
        details,
      };
    }

    // ── Strategy 1: Strip non-essential metadata ─────────────────────────
    if (this.options.canStripMetadata) {
      details.metadataRemoved = this.stripMetadata(context);
    }

    // ── Strategy 2: Collapse file changes ────────────────────────────────
    if (this.options.canCollapseFileChanges) {
      details.fileChangesCollapsed = this.collapseFileChanges(context);
    }

    // ── Strategy 3: Truncate conversations ───────────────────────────────
    const convBeforeCount = context.conversations.length;
    this.pruneConversations(context);
    details.conversationsTruncated = convBeforeCount - context.conversations.length;

    // ── Strategy 4: Summarize large artifacts ─────────────────────────────
    if (this.options.canRemoveArtifacts) {
      const artBeforeCount = context.artifacts.length;
      details.artifactsSummarized = this.summarizeArtifacts(context);
      // Count how many were fully removed (summarize drops content but keeps the entry)
      // The difference vs original count = fully removed
      details.artifactsRemoved = artBeforeCount - context.artifacts.length;
    }

    // ── Strategy 5: Aggressive conversation pruning if still over threshold ─
    if (this.isOverThreshold(context) && context.conversations.length > 2) {
      const beforeAggressive = context.conversations.length;
      // Keep only the last 2 messages
      context.conversations = context.conversations.slice(-2);
      details.conversationsTruncated += beforeAggressive - context.conversations.length;
    }

    const after = this.analyze(context);
    const tokensAfter = after.totalTokens;
    const reductionPct = tokensBefore > 0
      ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)
      : 0;

    return {
      pruned: tokensBefore !== tokensAfter,
      tokensBefore,
      tokensAfter,
      reductionPct,
      details,
    };
  }

  /**
   * Get a human-readable summary of the last prune result.
   */
  formatPruneResult(result: PruneResult): string {
    if (!result.pruned) return '';

    const parts: string[] = [`📏 Context pruned: ${result.reductionPct}% reduction`];

    if (result.details.conversationsTruncated > 0) {
      parts.push(`   💬 Conversations: ${result.details.conversationsTruncated} message(s) truncated`);
    }
    if (result.details.artifactsSummarized > 0) {
      parts.push(`   📄 Artifacts: ${result.details.artifactsSummarized} summarized`);
    }
    if (result.details.artifactsRemoved > 0) {
      parts.push(`   🗑️  Artifacts: ${result.details.artifactsRemoved} removed`);
    }
    if (result.details.fileChangesCollapsed > 0) {
      parts.push(`   📝 File changes: ${result.details.fileChangesCollapsed} collapsed`);
    }
    if (result.details.metadataRemoved > 0) {
      parts.push(`   🏷️  Metadata: ${result.details.metadataRemoved} key(s) stripped`);
    }

    parts.push(`   📊 ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens`);

    return parts.join('\n');
  }

  // ─── Private Pruning Strategies ─────────────────────────────────────────

  /**
   * Remove non-essential metadata keys.
   * Keeps: projectFileTree, memoryContext, patternContext, runResult, sandboxPath
   * Strips: LLM responses, intermediate results, debug info
   */
  private stripMetadata(context: AgentContext): number {
    const essentialKeys = new Set([
      'projectFileTree',
      'memoryContext',
      'patternContext',
      'runResult',
      'sandboxPath',
    ]);

    const keys = Object.keys(context.metadata);
    let removed = 0;

    for (const key of keys) {
      if (!essentialKeys.has(key)) {
        delete context.metadata[key];
        removed++;
      }
    }

    return removed;
  }

  /**
   * Collapse file changes to just paths and status, dropping the full content.
   * Keeps the path and status metadata but removes newContent/originalContent
   * strings that can be hundreds of KB.
   */
  private collapseFileChanges(context: AgentContext): number {
    let collapsed = 0;

    for (const fc of context.fileChanges) {
      const hasContent = !!fc.newContent || !!fc.originalContent;
      if (hasContent) {
        // Remove content to free tokens.
        // Safe because the orchestrator applies file changes to disk immediately
        // after each writer step, before the pruner runs. The path + status
        // remain for the final diff summary display.
        fc.newContent = undefined;
        fc.originalContent = undefined;
        collapsed++;
      }
    }

    return collapsed;
  }

  /**
   * Truncate conversation history based on the configured mode.
   * - soft: keep last 10 messages
   * - medium: keep last 5 messages
   * - aggressive: keep last 2 messages
   */
  private pruneConversations(context: AgentContext): void {
    if (context.conversations.length === 0) return;

    const keepCount = this.options.conversationMode === 'aggressive'
      ? 2
      : this.options.conversationMode === 'medium'
        ? 5
        : 10;

    if (context.conversations.length <= keepCount) return;

    // Keep only the most recent messages
    context.conversations = context.conversations.slice(-keepCount);
  }

  /**
   * Summarize large artifacts by truncating their content.
   * Artifacts with content exceeding maxArtifactChars get truncated to
   * maxArtifactChars with a note. Artifacts with no content are removed.
   */
  private summarizeArtifacts(context: AgentContext): number {
    const maxChars = this.options.maxArtifactChars;
    let summarized = 0;

    // Separate artifacts: keep those with meaningful content, prune the rest
    const kept: Artifact[] = [];

    for (const artifact of context.artifacts) {
      // Artifacts with empty content — drop entirely
      if (!artifact.content || artifact.content.trim().length === 0) {
        continue;
      }

      // Artifacts with oversized content — truncate
      if (artifact.content.length > maxChars) {
        artifact.content = artifact.content.slice(0, maxChars) +
          `\n\n[...truncated by ContextPruner — original was ${artifact.content.length.toLocaleString()} chars]`;
        kept.push(artifact);
        summarized++;
      } else {
        kept.push(artifact);
      }
    }

    context.artifacts = kept;
    return summarized;
  }
}
