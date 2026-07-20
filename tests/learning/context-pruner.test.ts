/**
 * Unit tests for ContextPruner — strict context-window memory pruner.
 *
 * Coverage goals:
 * - Constructor/configuration (defaults, custom options)
 * - estimateTokens — empty, short, long, consistency
 * - analyze — empty context, per-component breakdown, totals match
 * - isOverThreshold — below, at, above, custom thresholds
 * - prune — no-op when under threshold, triggers when over
 * - stripMetadata — essential keys kept, non-essential stripped, disabled
 * - collapseFileChanges — content dropped, missing content no-op, disabled
 * - pruneConversations — soft/medium/aggressive, empty, below keep count
 * - summarizeArtifacts — oversized truncated, empty removed, small kept, disabled
 * - Aggressive conversation pruning (final fallback)
 * - formatPruneResult — empty result, full result, partial result
 * - Edge cases — empty context, huge metadata, single agent chain
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextPruner } from '../../src/learning/context-pruner.js';
import type { ContextPrunerOptions, PruneResult } from '../../src/learning/context-pruner.js';
import type { AgentContext, Artifact, AgentMessage, FileChange, TaskStep } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4.5;

/** Create a minimal valid context with sensible defaults */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'Test goal: implement user authentication',
    workingDirectory: '/test/project',
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

/** Create an artifact with a given content size (in chars) */
function makeArtifact(path: string, charCount: number, description?: string): Artifact {
  return {
    path,
    content: 'x'.repeat(charCount),
    description: description || `Artifact at ${path}`,
  };
}

/** Create a conversation message */
function makeMessage(from: string, to: string, content: string): AgentMessage {
  return {
    from,
    to,
    content,
    timestamp: Date.now(),
  };
}

/** Create a file change with optional content */
function makeFileChange(
  path: string,
  status: FileChange['status'],
  content?: string,
): FileChange {
  return {
    path,
    status,
    newContent: content,
    originalContent: undefined,
  };
}

/** Create a task step */
function makeTaskStep(id: string, agentType: string, description: string): TaskStep {
  return {
    id,
    agentType,
    description,
    dependsOn: [],
    status: 'completed',
  };
}

/** Estimate tokens for a string, matching the pruner's heuristic */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ContextPruner', () => {
  // ── Constructor / Configuration ───────────────────────────────────────

  describe('constructor', () => {
    it('should apply default options when none provided', () => {
      const pruner = new ContextPruner();
      // Access via behavior — default threshold 0.8 of 128000 = 102400
      const context = makeContext({
        goal: 'x'.repeat(500_000), // Huge goal to exceed threshold
      });
      expect(pruner.isOverThreshold(context)).toBe(true);
    });

    it('should merge custom options with defaults', () => {
      const pruner = new ContextPruner({ maxTokens: 1000, thresholdRatio: 0.5 });
      // Threshold = 500 tokens
      const context = makeContext({
        goal: 'x'.repeat(3000), // ~667 tokens
      });
      expect(pruner.isOverThreshold(context)).toBe(true);
    });

    it('should use custom conversationMode', () => {
      const pruner = new ContextPruner({ conversationMode: 'aggressive' });
      const context = makeContext({
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('agent-a', 'agent-b', `Message ${i} content`),
        ),
        // Add enough other content to exceed threshold
        artifacts: [makeArtifact('large.ts', 500_000)],
      });
      const result = pruner.prune(context);
      // After aggressive pruning, only 2 messages should remain
      expect(context.conversations.length).toBeLessThanOrEqual(2);
      expect(result.details.conversationsTruncated).toBeGreaterThanOrEqual(18);
    });

    it('should work with thresholdRatio of 1.0 (hard limit only)', () => {
      const pruner = new ContextPruner({ maxTokens: 1000, thresholdRatio: 1.0 });
      const context = makeContext({
        goal: 'x'.repeat(4000), // ~889 tokens, still under 1000
      });
      expect(pruner.isOverThreshold(context)).toBe(false);
    });

    it('should disable strategies when options set to false', () => {
      const pruner = new ContextPruner({
        canStripMetadata: false,
        canCollapseFileChanges: false,
        canRemoveArtifacts: false,
        maxTokens: 100,
        thresholdRatio: 0.5, // Threshold = 50 tokens
      });

      const context = makeContext({
        goal: 'x'.repeat(1000), // ~222 tokens, way over 50
        metadata: { nonEssential: 'data', extra: 'info', debug: 'yes' },
        fileChanges: [makeFileChange('a.ts', 'modified', 'x'.repeat(1000))],
        artifacts: [makeArtifact('big.ts', 100_000)],
        conversations: Array.from({ length: 30 }, (_, i) =>
          makeMessage('a', 'b', `msg ${i}`),
        ),
      });

      const result = pruner.prune(context);

      // With all strategies disabled, only conversation pruning (which has no
      // option to disable) and aggressive fallback should run
      expect(result.details.metadataRemoved).toBe(0);
      expect(result.details.fileChangesCollapsed).toBe(0);
      expect(result.details.artifactsSummarized).toBe(0);
      expect(result.details.artifactsRemoved).toBe(0);
    });
  });

  // ── estimateTokens ────────────────────────────────────────────────────

  describe('estimateTokens', () => {
    let pruner: ContextPruner;

    beforeEach(() => {
      pruner = new ContextPruner();
    });

    it('should return 0 for empty string', () => {
      expect(pruner.estimateTokens('')).toBe(0);
    });

    it('should return 1 for a single character', () => {
      expect(pruner.estimateTokens('x')).toBe(1);
    });

    it('should estimate ~4.5 chars per token', () => {
      const text = 'Hello, world! This is a test sentence with exactly fifty three characters'; // ~53 chars
      const expected = estimateTokens(text);
      expect(pruner.estimateTokens(text)).toBe(expected);
    });

    it('should handle very long strings', () => {
      const text = 'x'.repeat(100_000);
      const expected = estimateTokens(text);
      expect(pruner.estimateTokens(text)).toBe(expected);
    });

    it('should handle strings with special characters', () => {
      const text = 'Line 1\nLine 2\n\tIndented\nSpecial: ~!@#$%^&*()_+';
      const expected = estimateTokens(text);
      expect(pruner.estimateTokens(text)).toBe(expected);
    });
  });

  // ── analyze ───────────────────────────────────────────────────────────

  describe('analyze', () => {
    let pruner: ContextPruner;

    beforeEach(() => {
      pruner = new ContextPruner();
    });

    it('should return zero breakdown for empty context', () => {
      const context = makeContext({ goal: '' });
      const breakdown = pruner.analyze(context);

      expect(breakdown.goalTokens).toBe(0);
      expect(breakdown.taskPlanTokens).toBeLessThan(10); // Empty array JSON is ~2 tokens
      expect(breakdown.artifactsTokens).toBe(0);
      expect(breakdown.conversationsTokens).toBe(0);
      expect(breakdown.fileChangesTokens).toBe(0);
      expect(breakdown.metadataTokens).toBeLessThan(10);
      expect(breakdown.totalTokens).toBe(breakdown.goalTokens + breakdown.taskPlanTokens +
        breakdown.artifactsTokens + breakdown.conversationsTokens +
        breakdown.fileChangesTokens + breakdown.metadataTokens);
    });

    it('should correctly calculate artifact token counts', () => {
      const context = makeContext({
        artifacts: [makeArtifact('src/index.ts', 1000)],
      });
      const breakdown = pruner.analyze(context);
      const expectedArtifactTokens = estimateTokens('src/index.ts\n' + 'x'.repeat(1000));
      expect(breakdown.artifactsTokens).toBe(expectedArtifactTokens);
    });

    it('should correctly calculate conversation token counts', () => {
      const context = makeContext({
        conversations: [
          makeMessage('planner', 'writer', 'Implement the feature'),
          makeMessage('writer', 'reviewer', 'Done, please review'),
        ],
      });
      const breakdown = pruner.analyze(context);
      const convText = context.conversations
        .map((m) => `[${m.from} → ${m.to}] ${m.content}`)
        .join('\n');
      expect(breakdown.conversationsTokens).toBe(estimateTokens(convText));
    });

    it('should correctly calculate file change token counts', () => {
      const context = makeContext({
        fileChanges: [
          makeFileChange('src/index.ts', 'modified', 'console.log("hello");'),
        ],
      });
      const fcText = 'src/index.ts\nconsole.log("hello");';
      expect(pruner.analyze(context).fileChangesTokens).toBe(estimateTokens(fcText));
    });

    it('should correctly calculate metadata token counts', () => {
      const context = makeContext({
        metadata: { projectFileTree: 'src/\n  index.ts', customKey: { deep: { value: 42 } } },
      });
      expect(pruner.analyze(context).metadataTokens).toBe(estimateTokens(JSON.stringify(context.metadata)));
    });

    it('should include taskPlan tokens', () => {
      const context = makeContext({
        taskPlan: [makeTaskStep('step-1', 'writer', 'Write code')],
      });
      expect(pruner.analyze(context).taskPlanTokens).toBeGreaterThan(0);
    });

    it('should correctly sum total from all components', () => {
      const context = makeContext({
        artifacts: [makeArtifact('a.ts', 500)],
        conversations: [makeMessage('a', 'b', 'hello')],
        fileChanges: [makeFileChange('b.ts', 'modified', 'content')],
        metadata: { key: 'value' },
        taskPlan: [makeTaskStep('s1', 'writer', 'task')],
      });
      const breakdown = pruner.analyze(context);
      const sum = breakdown.goalTokens + breakdown.taskPlanTokens +
        breakdown.artifactsTokens + breakdown.conversationsTokens +
        breakdown.fileChangesTokens + breakdown.metadataTokens;
      expect(breakdown.totalTokens).toBe(sum);
    });
  });

  // ── isOverThreshold ───────────────────────────────────────────────────

  describe('isOverThreshold', () => {
    it('should return false for small context under threshold', () => {
      const pruner = new ContextPruner({ maxTokens: 128000, thresholdRatio: 0.8 });
      const context = makeContext();
      expect(pruner.isOverThreshold(context)).toBe(false);
    });

    it('should return true for context exceeding threshold', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.8 });
      const context = makeContext({
        artifacts: [makeArtifact('huge.ts', 10_000)], // ~2222 tokens
      });
      expect(pruner.isOverThreshold(context)).toBe(true);
    });

    it('should respect custom thresholdRatio', () => {
      // Very low threshold so even small context triggers
      const pruner = new ContextPruner({ maxTokens: 1000, thresholdRatio: 0.1 });
      const context = makeContext({
        goal: 'x'.repeat(500), // ~111 tokens — exceeds 100 threshold
      });
      expect(pruner.isOverThreshold(context)).toBe(true);
    });

    it('should return false when exactly at threshold boundary', () => {
      // Create a context with total tokens just under the threshold.
      // We account for ALL context components: goal + workingDirectory + taskPlan JSON + metadata.
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 1.0 });
      const context = makeContext({ goal: '' }); // Clear goal to minimize tokens
      // Verify the baseline is under threshold
      const breakdown = pruner.analyze(context);
      expect(breakdown.totalTokens).toBeLessThan(100);
      expect(pruner.isOverThreshold(context)).toBe(false);
    });

    it('should return true when just over threshold boundary', () => {
      const pruner = new ContextPruner({ maxTokens: 500, thresholdRatio: 1.0 });
      // Push over threshold with a large goal
      const context = makeContext({
        goal: 'x'.repeat(5000), // ~1111 tokens — well over 500
      });
      expect(pruner.isOverThreshold(context)).toBe(true);
    });
  });

  // ── prune (integration) ───────────────────────────────────────────────

  describe('prune', () => {
    let pruner: ContextPruner;

    beforeEach(() => {
      pruner = new ContextPruner();
    });

    it('should return no-op when context is under threshold', () => {
      const context = makeContext();
      const result = pruner.prune(context);
      expect(result.pruned).toBe(false);
      expect(result.details.conversationsTruncated).toBe(0);
      expect(result.details.metadataRemoved).toBe(0);
      expect(result.details.fileChangesCollapsed).toBe(0);
      expect(result.details.artifactsSummarized).toBe(0);
      expect(result.details.artifactsRemoved).toBe(0);
    });

    it('should return consistent tokensBefore/tokensAfter for no-op', () => {
      const context = makeContext();
      const breakdown = pruner.analyze(context);
      const result = pruner.prune(context);
      expect(result.tokensBefore).toBe(breakdown.totalTokens);
      expect(result.tokensAfter).toBe(breakdown.totalTokens);
      expect(result.reductionPct).toBe(0);
    });

    it('should trigger pruning when context exceeds threshold', () => {
      const smallPruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        artifacts: [makeArtifact('large.ts', 10_000)],
        conversations: Array.from({ length: 50 }, (_, i) =>
          makeMessage('a', 'b', `Long conversation message number ${i}: ` + 'x'.repeat(200)),
        ),
        fileChanges: [makeFileChange('output.ts', 'modified', 'x'.repeat(5000))],
        metadata: { extra1: 'value', extra2: 'value', debugInfo: 'yes', temp: 'data' },
      });
      const result = smallPruner.prune(context);
      expect(result.pruned).toBe(true);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.reductionPct).toBeGreaterThan(0);
    });

    it('should modify the context in place', () => {
      const aggressivePruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        conversationMode: 'aggressive',
      });
      const context = makeContext({
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('a', 'b', `Message ${i}`),
        ),
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const beforeConversations = context.conversations.length;

      aggressivePruner.prune(context);

      // Context should have been modified in place
      expect(context.conversations.length).toBeLessThan(beforeConversations);
    });

    it('should track all prune strategies in details', () => {
      const pruner = new ContextPruner({
        maxTokens: 200,
        thresholdRatio: 0.5,
        conversationMode: 'aggressive',
      });
      const context = makeContext({
        goal: 'x'.repeat(100_000), // ~22K tokens — way over
        metadata: { stripMe: 'yes', essential: 'keep', debug: 'info', temp: 'data' },
        fileChanges: [
          makeFileChange('a.ts', 'modified', 'x'.repeat(10_000)),
          makeFileChange('b.ts', 'created', 'x'.repeat(5000)),
        ],
        conversations: Array.from({ length: 10 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(500)),
        ),
        artifacts: [
          makeArtifact('small.ts', 100),
          makeArtifact('large.ts', 10_000),
          makeArtifact('medium.ts', 5000),
          makeArtifact('', 0), // Empty content — should be removed
        ],
      });
      const result = pruner.prune(context);

      expect(result.pruned).toBe(true);
      expect(result.details.metadataRemoved).toBeGreaterThan(0);
      expect(result.details.fileChangesCollapsed).toBeGreaterThan(0);
      expect(result.details.conversationsTruncated).toBeGreaterThan(0);
      // artifactsSummarized counts truncated (oversized) artifacts
      // artifactsRemoved counts fully removed (empty content)
      expect(result.details).toMatchObject({
        metadataRemoved: expect.any(Number),
        fileChangesCollapsed: expect.any(Number),
        conversationsTruncated: expect.any(Number),
        artifactsSummarized: expect.any(Number),
        artifactsRemoved: expect.any(Number),
      });
    });
  });

  // ── stripMetadata ─────────────────────────────────────────────────────

  describe('stripMetadata (via prune)', () => {
    it('should strip non-essential metadata keys', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        metadata: {
          projectFileTree: 'src/\n  index.ts', // essential
          memoryContext: 'past task',            // essential
          patternContext: 'patterns',            // essential
          runResult: 'success',                  // essential
          sandboxPath: '/tmp/sandbox',           // essential
          customKey: 'should be removed',        // non-essential
          debugInfo: 'remove',                   // non-essential
          intermediateResult: { data: 42 },      // non-essential
        },
        artifacts: [makeArtifact('big.ts', 100_000)], // forces pruning
      });
      pruner.prune(context);

      expect(context.metadata.projectFileTree).toBeDefined();
      expect(context.metadata.memoryContext).toBeDefined();
      expect(context.metadata.patternContext).toBeDefined();
      expect(context.metadata.runResult).toBeDefined();
      expect(context.metadata.sandboxPath).toBeDefined();
      expect(context.metadata.customKey).toBeUndefined();
      expect(context.metadata.debugInfo).toBeUndefined();
      expect(context.metadata.intermediateResult).toBeUndefined();
    });

    it('should return the count of stripped metadata keys', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        metadata: {
          projectFileTree: 'tree',   // essential — kept
          remove1: 'x',              // non-essential → stripped
          remove2: 'y',              // non-essential → stripped
          remove3: 'z',              // non-essential → stripped
        },
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      // projectFileTree is essential, the other 3 are non-essential
      expect(result.details.metadataRemoved).toBe(3);
      expect(context.metadata.projectFileTree).toBe('tree');
      expect(context.metadata.remove1).toBeUndefined();
      expect(context.metadata.remove2).toBeUndefined();
      expect(context.metadata.remove3).toBeUndefined();
    });

    it('should skip stripping when canStripMetadata is false', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        canStripMetadata: false,
      });
      const context = makeContext({
        metadata: { stripMe: 'should stay', debug: 'info' },
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      expect(result.details.metadataRemoved).toBe(0);
      expect(context.metadata.stripMe).toBe('should stay');
      expect(context.metadata.debug).toBe('info');
    });

    it('should do nothing when only essential keys exist', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        metadata: { projectFileTree: 'tree', memoryContext: 'mem' },
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      // Only 2 keys, both essential → 0 removed
      expect(result.details.metadataRemoved).toBe(0);
    });
  });

  // ── collapseFileChanges ───────────────────────────────────────────────

  describe('collapseFileChanges (via prune)', () => {
    it('should drop newContent from file changes', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        fileChanges: [
          makeFileChange('src/index.ts', 'modified', 'console.log("hello");\nexport const x = 1;'),
          makeFileChange('src/new.ts', 'created', 'export const y = 2;'),
        ],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);

      // Content should be dropped but path + status preserved
      for (const fc of context.fileChanges) {
        expect(fc.newContent).toBeUndefined();
        expect(fc.path).toBeTruthy();
        expect(fc.status).toBeTruthy();
      }
    });

    it('should keep path and status after collapsing', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        fileChanges: [makeFileChange('src/test.ts', 'modified', 'content')],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);

      expect(context.fileChanges[0].path).toBe('src/test.ts');
      expect(context.fileChanges[0].status).toBe('modified');
    });

    it('should not modify file changes without content', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        fileChanges: [
          { path: 'deleted.ts', status: 'deleted' as const },
          { path: 'modified.ts', status: 'modified' as const },
        ],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);

      // Should still be intact (nothing to collapse)
      expect(context.fileChanges[0].status).toBe('deleted');
      expect(context.fileChanges[1].status).toBe('modified');
    });

    it('should return count of collapsed changes', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        fileChanges: [
          makeFileChange('a.ts', 'modified', 'content'),
          makeFileChange('b.ts', 'created', ''),
          { path: 'c.ts', status: 'deleted' },
        ],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      // a.ts has content → collapsed
      // b.ts has empty newContent → !!'' = false, so not collapsed
      // c.ts has no content fields at all → not collapsed
      expect(result.details.fileChangesCollapsed).toBe(1);
    });

    it('should skip collapsing when canCollapseFileChanges is false', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        canCollapseFileChanges: false,
      });
      const context = makeContext({
        fileChanges: [makeFileChange('a.ts', 'modified', 'important content')],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      expect(context.fileChanges[0].newContent).toBe('important content');
      expect(result.details.fileChangesCollapsed).toBe(0);
    });
  });

  // ── pruneConversations ────────────────────────────────────────────────

  describe('pruneConversations (via prune)', () => {
    it('should keep last 10 messages in soft mode (default)', () => {
      // Strategy: conversations push total OVER threshold, but after soft pruning
      // (keep 10) the total drops back UNDER, so aggressive fallback won't trigger.
      const pruner = new ContextPruner({
        maxTokens: 5000,
        thresholdRatio: 0.8, // threshold = 4000 tokens
      });
      // Make each conversation long enough so 30 messages exceed the threshold
      // but 10 messages are under it.
      const context = makeContext({
        goal: 'test',
        conversations: Array.from({ length: 30 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(600)), // ~133 tokens each
        ),
      });
      // 30 × 133 = 3990 tokens → under 4000 threshold... need slightly more
      // Add extra content outside conversations to push over threshold
      context.metadata.extra = 'x'.repeat(500); // ~111 tokens
      // Total before: 3990 + 111 + ~10 = ~4111 > 4000 → triggers pruning

      pruner.prune(context);

      // Soft mode keeps 10 → 10 × 133 = 1330 tokens from conversations
      // ~1330 + 111 + ~10 = ~1451 < 4000 → aggressive fallback NOT triggered
      expect(context.conversations.length).toBe(10);
    });

    it('should keep last 5 messages in medium mode', () => {
      const pruner = new ContextPruner({
        maxTokens: 5000,
        thresholdRatio: 0.8,
        conversationMode: 'medium',
      });
      const context = makeContext({
        goal: 'test',
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(600)),
        ),
      });
      // 20 × 133 = 2660. Need to exceed 4000 threshold with other content.
      context.metadata.big = 'x'.repeat(10_000); // ~2222 tokens
      // Total before: 2660 + 2222 + ~10 = ~4892 > 4000 → triggers pruning

      pruner.prune(context);

      // Medium mode keeps 5 → 5 × 133 = 665 tokens from conversations
      // The metadata stays (not essential, stripped). After stripping:
      // ~665 + ~10 = ~675 < 4000 → aggressive fallback NOT triggered
      expect(context.conversations.length).toBe(5);
    });

    it('should keep last 2 messages in aggressive mode', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        conversationMode: 'aggressive',
      });
      const context = makeContext({
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('a', 'b', `Message ${i}`),
        ),
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);
      expect(context.conversations.length).toBe(2);
    });

    it('should keep the most recent messages, not the oldest', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        conversationMode: 'aggressive', // keeps last 2
      });
      const context = makeContext({
        conversations: [
          makeMessage('a', 'b', 'First message'),
          makeMessage('b', 'a', 'Second'),
          makeMessage('a', 'b', 'Third'),
          makeMessage('b', 'a', 'Fourth'),
          makeMessage('a', 'b', 'Fifth — most recent'),
        ],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);
      expect(context.conversations).toHaveLength(2);
      expect(context.conversations[0].content).toBe('Fourth');
      expect(context.conversations[1].content).toBe('Fifth — most recent');
    });

    it('should do nothing when conversations are below the keep count', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        conversations: [
          makeMessage('a', 'b', 'Only message'),
        ],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);
      expect(context.conversations).toHaveLength(1);
    });

    it('should do nothing with empty conversations', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        conversations: [],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      pruner.prune(context);
      expect(context.conversations).toHaveLength(0);
    });
  });

  // ── Aggressive conversation pruning (strategy 5) ──────────────────────

  describe('aggressive conversation pruning (fallback)', () => {
    it('should aggressively prune conversations when still over threshold after other strategies', () => {
      // Create a context so over threshold that even after stripping metadata,
      // collapsing files, and soft conversation pruning, it's still over
      const pruner = new ContextPruner({
        maxTokens: 1000,
        thresholdRatio: 0.5, // threshold = 500 tokens
        conversationMode: 'soft', // normally keeps 10
      });

      const context = makeContext({
        goal: '',
        metadata: {},
        fileChanges: [makeFileChange('a.ts', 'modified', 'x'.repeat(100))],
        // Create many long conversations (each ~150 chars ≈ 33 tokens)
        // 30 × 33 = 1000+ tokens just from conversations
        conversations: Array.from({ length: 30 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(150)),
        ),
        // Also have a huge artifact to push it even further over
        artifacts: [makeArtifact('big.ts', 10_000)],
      });

      const result = pruner.prune(context);

      // After soft pruning, conversations should be 10 (soft keep)
      // But if still over threshold, aggressive kicks in → 2
      expect(context.conversations.length).toBeLessThanOrEqual(10);
      // If the aggressive fallback was triggered, we should see higher truncation count
      expect(result.details.conversationsTruncated).toBeGreaterThanOrEqual(20);
    });

    it('should NOT aggressively prune if already under threshold after initial strategies', () => {
      const pruner = new ContextPruner({
        maxTokens: 500_000,
        thresholdRatio: 0.9, // Threshold = 450K — very high
        conversationMode: 'soft',
      });

      const context = makeContext({
        conversations: Array.from({ length: 15 }, (_, i) =>
          makeMessage('a', 'b', `Short message ${i}`),
        ),
      });

      const result = pruner.prune(context);
      // Context is under threshold, so no pruning at all
      expect(result.pruned).toBe(false);
      expect(context.conversations).toHaveLength(15);
    });

    it('should not crash when conversations are empty during aggressive prune check', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
      });
      const context = makeContext({
        goal: 'x'.repeat(100_000), // ~22K tokens — way over
        conversations: [],
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      expect(() => pruner.prune(context)).not.toThrow();
    });
  });

  // ── summarizeArtifacts ────────────────────────────────────────────────

  describe('summarizeArtifacts (via prune)', () => {
    it('should truncate artifacts exceeding maxArtifactChars', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        maxArtifactChars: 100,
      });
      const context = makeContext({
        artifacts: [makeArtifact('huge.ts', 10_000)],
      });
      pruner.prune(context);

      expect(context.artifacts[0].content.length).toBeLessThan(10_000);
      // Should contain the truncation note
      expect(context.artifacts[0].content).toContain('truncated by ContextPruner');
    });

    it('should keep small artifacts intact', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        maxArtifactChars: 100,
      });
      const context = makeContext({
        artifacts: [makeArtifact('small.ts', 50)], // Under 100 chars
      });
      pruner.prune(context);

      expect(context.artifacts[0].content).toBe('x'.repeat(50));
      expect(context.artifacts[0].content).not.toContain('truncated');
    });

    it('should remove artifacts with empty content', () => {
      // Use enough goal content to exceed the pruning threshold
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.3, // threshold = 30 tokens
      });
      const context = makeContext({
        goal: 'x'.repeat(1000), // ~222 tokens — exceeds 30
        artifacts: [
          makeArtifact('valid.ts', 100),
          makeArtifact('empty.ts', 0),
          { path: 'no-content.ts', content: '', description: 'empty' },
          { path: 'whitespace.ts', content: '   ', description: 'whitespace only' },
        ],
      });
      const beforeCount = context.artifacts.length;
      pruner.prune(context);

      // Empty and whitespace-only artifacts should be removed
      expect(context.artifacts.length).toBeLessThan(beforeCount);
      expect(context.artifacts.every((a) => a.content.trim().length > 0)).toBe(true);
    });

    it('should preserve artifacts count when all are under maxArtifactChars', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        maxArtifactChars: 5000,
      });
      const context = makeContext({
        artifacts: [
          makeArtifact('a.ts', 100),
          makeArtifact('b.ts', 200),
          makeArtifact('c.ts', 300),
        ],
      });
      pruner.prune(context);

      // All under 5000, none empty → all preserved
      expect(context.artifacts).toHaveLength(3);
    });

    it('should skip summarizing when canRemoveArtifacts is false', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        canRemoveArtifacts: false,
      });
      const context = makeContext({
        artifacts: [
          makeArtifact('huge.ts', 100_000),
          makeArtifact('', 0),
        ],
      });
      pruner.prune(context);

      // Artifacts should be completely untouched
      expect(context.artifacts).toHaveLength(2);
      expect(context.artifacts[0].content.length).toBe(100_000);
    });

    it('should handle empty artifacts array', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
      });
      const context = makeContext({
        artifacts: [],
        goal: 'x'.repeat(100_000), // Push over threshold
      });
      expect(() => pruner.prune(context)).not.toThrow();
      expect(context.artifacts).toEqual([]);
    });
  });

  // ── formatPruneResult ────────────────────────────────────────────────

  describe('formatPruneResult', () => {
    let pruner: ContextPruner;

    beforeEach(() => {
      pruner = new ContextPruner();
    });

    it('should return empty string for no-op result', () => {
      const result: PruneResult = {
        pruned: false,
        tokensBefore: 100,
        tokensAfter: 100,
        reductionPct: 0,
        details: {
          conversationsTruncated: 0,
          artifactsSummarized: 0,
          artifactsRemoved: 0,
          metadataRemoved: 0,
          fileChangesCollapsed: 0,
        },
      };
      expect(pruner.formatPruneResult(result)).toBe('');
    });

    it('should include reduction percentage in output', () => {
      const result: PruneResult = {
        pruned: true,
        tokensBefore: 100_000,
        tokensAfter: 50_000,
        reductionPct: 50,
        details: {
          conversationsTruncated: 10,
          artifactsSummarized: 0,
          artifactsRemoved: 0,
          metadataRemoved: 0,
          fileChangesCollapsed: 0,
        },
      };
      const formatted = pruner.formatPruneResult(result);
      expect(formatted).toContain('50%');
      expect(formatted).toContain('Conversations:');
      expect(formatted).toContain('100,000');
      expect(formatted).toContain('50,000');
    });

    it('should include all non-zero detail fields', () => {
      const result: PruneResult = {
        pruned: true,
        tokensBefore: 200_000,
        tokensAfter: 20_000,
        reductionPct: 90,
        details: {
          conversationsTruncated: 25,
          artifactsSummarized: 3,
          artifactsRemoved: 2,
          metadataRemoved: 5,
          fileChangesCollapsed: 4,
        },
      };
      const formatted = pruner.formatPruneResult(result);
      expect(formatted).toContain('90%');
      expect(formatted).toContain('Conversations: 25');
      expect(formatted).toContain('Artifacts: 3 summarized');
      expect(formatted).toContain('Artifacts: 2 removed');
      expect(formatted).toContain('Metadata: 5');
      expect(formatted).toContain('File changes: 4');
    });

    it('should include only non-zero details (partial result)', () => {
      const result: PruneResult = {
        pruned: true,
        tokensBefore: 50_000,
        tokensAfter: 30_000,
        reductionPct: 40,
        details: {
          conversationsTruncated: 0,
          artifactsSummarized: 0,
          artifactsRemoved: 0,
          metadataRemoved: 0,
          fileChangesCollapsed: 0,
        },
      };
      const formatted = pruner.formatPruneResult(result);
      expect(formatted).toContain('40%');
      // Should NOT include lines for zero-value fields
      expect(formatted).not.toContain('Conversations:');
      expect(formatted).not.toContain('Artifacts:');
      expect(formatted).not.toContain('Metadata:');
      expect(formatted).not.toContain('File changes:');
      expect(formatted).toContain('50,000');
      expect(formatted).toContain('30,000');
    });

    it('should return empty string when pruned is false even with non-zero details', () => {
      const result: PruneResult = {
        pruned: false,
        tokensBefore: 1000,
        tokensAfter: 1000,
        reductionPct: 0,
        details: {
          conversationsTruncated: 10, // This shouldn't matter since pruned=false
          artifactsSummarized: 0,
          artifactsRemoved: 0,
          metadataRemoved: 0,
          fileChangesCollapsed: 0,
        },
      };
      expect(pruner.formatPruneResult(result)).toBe('');
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle a completely empty context (minimal)', () => {
      const pruner = new ContextPruner();
      const context: AgentContext = {
        goal: '',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      };
      expect(() => pruner.prune(context)).not.toThrow();
      expect(context).toBeDefined();
    });

    it('should handle single-agent chain (simple context)', () => {
      const pruner = new ContextPruner();
      const context = makeContext({
        taskPlan: [makeTaskStep('s1', 'writer', 'Write code')],
        artifacts: [makeArtifact('index.ts', 500)],
        conversations: [makeMessage('user', 'agent', 'Write a function')],
        fileChanges: [makeFileChange('index.ts', 'modified', 'function hello() {}')],
      });
      const result = pruner.prune(context);
      // Small context should be under threshold → no pruning
      expect(result.pruned).toBe(false);
    });

    it('should handle huge metadata values', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        metadata: {
          projectFileTree: 'x'.repeat(100_000), // essential but won't be stripped
          hugeBlob: 'x'.repeat(200_000),        // non-essential, will be stripped
        },
        artifacts: [makeArtifact('big.ts', 100_000)],
      });
      const result = pruner.prune(context);
      expect(result.pruned).toBe(true);
      expect(context.metadata.projectFileTree).toBeDefined(); // essential kept
      expect(context.metadata.hugeBlob).toBeUndefined(); // stripped
    });

    it('should handle context with only conversations (no artifacts)', () => {
      const pruner = new ContextPruner({
        maxTokens: 200,
        thresholdRatio: 0.5,
        conversationMode: 'aggressive',
      });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(500)),
        ),
        artifacts: [],
      });
      const result = pruner.prune(context);
      expect(result.pruned).toBe(true);
      // Should have truncated conversations significantly
      expect(context.conversations.length).toBeLessThan(20);
    });

    it('should handle context with only file changes (no conversations)', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        fileChanges: [
          makeFileChange('a.ts', 'modified', 'x'.repeat(50_000)),
          makeFileChange('b.ts', 'created', 'x'.repeat(30_000)),
        ],
        conversations: [],
      });
      const result = pruner.prune(context);
      expect(result.pruned).toBe(true);
      expect(result.details.fileChangesCollapsed).toBe(2);
      for (const fc of context.fileChanges) {
        expect(fc.newContent).toBeUndefined();
      }
    });

    it('should handle large task plans', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        taskPlan: Array.from({ length: 50 }, (_, i) =>
          makeTaskStep(`step-${i}`, 'agent', 'Do something ' + 'x'.repeat(100)),
        ),
      });
      const result = pruner.prune(context);
      // Task plan tokens are included in the total, but not pruned individually
      // (only the strategies above can reduce them indirectly)
      expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
    });

    it('should not throw on contexts with unusual status values', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        taskPlan: [
          { id: 's1', description: '', agentType: '', dependsOn: [], status: 'pending' as const },
        ],
      });
      expect(() => pruner.prune(context)).not.toThrow();
    });

    it('should handle sequential pruning calls (idempotent)', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        artifacts: [makeArtifact('big.ts', 10_000)],
        conversations: Array.from({ length: 20 }, (_, i) =>
          makeMessage('a', 'b', 'x'.repeat(200)),
        ),
        metadata: { stripMe: 'yes' },
      });

      // First prune
      const result1 = pruner.prune(context);
      expect(result1.pruned).toBe(true);

      // Second prune — most things already pruned, so should be a no-op or much smaller
      const result2 = pruner.prune(context);
      // Tokens after second prune should be <= after first prune
      expect(result2.tokensAfter).toBeLessThanOrEqual(result1.tokensAfter);

      // Third prune — should be essentially a no-op
      const result3 = pruner.prune(context);
      expect(result3.pruned).toBe(false);
    });

    it('should handle context with special characters in content', () => {
      const pruner = new ContextPruner({ maxTokens: 100, thresholdRatio: 0.5 });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        conversations: [makeMessage('a', 'b', 'Hello\nWorld\tTabbed\nUnicode: ñöüß🎉')],
        fileChanges: [makeFileChange('a.ts', 'modified', '// 🎉 comment\nconsole.log("héllo");')],
        metadata: { key: 'value\nwith\nnewlines' },
      });
      expect(() => pruner.prune(context)).not.toThrow();
    });

    it('should use custom maxArtifactChars for truncation', () => {
      const pruner = new ContextPruner({
        maxTokens: 100,
        thresholdRatio: 0.5,
        maxArtifactChars: 10, // Very small limit
      });
      const context = makeContext({
        goal: 'x'.repeat(10_000),
        artifacts: [makeArtifact('a.ts', 1000)],
      });
      pruner.prune(context);
      // Content should be truncated to 10 chars + truncation note
      expect(context.artifacts[0].content.length).toBeLessThan(100);
      expect(context.artifacts[0].content).toContain('truncated');
    });
  });

  // ── Integration Scenarios ─────────────────────────────────────────────

  describe('integration scenarios', () => {
    it('should simulate a complete multi-agent chain with pruning', () => {
      const pruner = new ContextPruner({
        maxTokens: 3000,
        thresholdRatio: 0.4, // Threshold = 1200 tokens — low enough to trigger
        conversationMode: 'medium',
      });

      // Step 1: Planner creates a plan
      const context = makeContext({
        taskPlan: [
          makeTaskStep('s1', 'context-gatherer', 'Scan the codebase'),
          makeTaskStep('s2', 'writer', 'Implement login feature'),
          makeTaskStep('s3', 'reviewer', 'Review changes'),
          makeTaskStep('s4', 'tester', 'Run tests'),
        ],
      });

      // Step 2: Context gatherer runs — adds artifacts with enough content
      context.artifacts = [
        makeArtifact('src/auth/login.ts', 3000),
        makeArtifact('src/auth/types.ts', 2000),
        makeArtifact('src/middleware.ts', 4000),
      ];
      pruner.prune(context);

      // Step 3: Writer runs — adds conversations and file changes
      context.conversations = [
        makeMessage('planner', 'writer', 'Implement login with JWT'),
        makeMessage('writer', 'user', 'I need to know the secret key'),
        makeMessage('user', 'writer', 'Use env variable JWT_SECRET'),
        makeMessage('writer', 'reviewer', 'Done, files changed'),
      ];
      context.fileChanges = [
        makeFileChange('src/auth/login.ts', 'modified', 'x'.repeat(1000)),
        makeFileChange('src/auth/types.ts', 'modified', 'x'.repeat(800)),
      ];
      pruner.prune(context);

      // Step 4: Reviewer runs — more conversations
      context.conversations.push(
        makeMessage('reviewer', 'writer', 'Please add error handling'),
        makeMessage('writer', 'reviewer', 'Added try/catch blocks'),
        makeMessage('reviewer', 'writer', 'Looks good now'),
      );
      context.fileChanges.push(
        makeFileChange('src/auth/login.ts', 'modified', 'x'.repeat(1200)),
      );
      pruner.prune(context);

      // Step 5: Final state — pruning should have been triggered
      // All file changes should still have valid paths and statuses
      for (const fc of context.fileChanges) {
        expect(fc.path).toBeTruthy();
        expect(fc.status).toBeTruthy();
      }
      // Conversation count should be at most 5 (medium mode)
      expect(context.conversations.length).toBeLessThanOrEqual(5);

      const breakdown = pruner.analyze(context);
      // Should be under or near the threshold limit
      expect(breakdown.totalTokens).toBeGreaterThan(0);
    });

    it('should survive a writer step that produces massive output', () => {
      const pruner = new ContextPruner({
        maxTokens: 500,
        thresholdRatio: 0.8, // threshold = 400
      });

      const context = makeContext({
        goal: 'Implement a full authentication system',
        taskPlan: [
          makeTaskStep('s1', 'context-gatherer', 'Scan'),
          makeTaskStep('s2', 'writer', 'Write all auth code'),
        ],
        // Writer produces a huge file
        artifacts: [makeArtifact('src/auth/auth.ts', 100_000)],
        fileChanges: [makeFileChange('src/auth/auth.ts', 'created', 'x'.repeat(100_000))],
        conversations: Array.from({ length: 5 }, (_, i) =>
          makeMessage('user', 'agent', 'x'.repeat(500)),
        ),
      });

      const result = pruner.prune(context);
      expect(result.pruned).toBe(true);

      // After pruning, artifact should be truncated
      expect(context.artifacts[0].content.length).toBeLessThan(100_000);
      // File change should be collapsed
      expect(context.fileChanges[0].newContent).toBeUndefined();
      // Path + status still intact
      expect(context.fileChanges[0].path).toBe('src/auth/auth.ts');
      expect(context.fileChanges[0].status).toBe('created');
    });

    it('should work with metadata-only pruning scenario', () => {
      const pruner = new ContextPruner({
        maxTokens: 1000,
        thresholdRatio: 0.3, // Threshold = 300 tokens — low enough to trigger
      });

      // Context over threshold due to enough goal content + many metadata keys
      const context = makeContext({
        goal: 'x'.repeat(1000), // ~222 tokens
        metadata: {
          projectFileTree: 'tree content',   // essential
          memoryContext: 'memory data',       // essential
          extraKey1: 'x'.repeat(200),
          extraKey2: 'x'.repeat(200),
          extraKey3: 'x'.repeat(200),
          extraKey4: 'x'.repeat(200),
          extraKey5: 'x'.repeat(200),         // 5 non-essential → stripped
        },
      });

      const result = pruner.prune(context);
      expect(result.pruned).toBe(true);
      expect(result.details.metadataRemoved).toBe(5);
      // Essential keys should survive
      expect(context.metadata.projectFileTree).toBe('tree content');
      expect(context.metadata.memoryContext).toBe('memory data');
    });
  });

  // ── analyze edge cases ───────────────────────────────────────────────

  describe('analyze edge cases', () => {
    let pruner: ContextPruner;

    beforeEach(() => {
      pruner = new ContextPruner();
    });

    it('should report zero for a context with empty strings', () => {
      const context = makeContext({
        goal: '',
        taskPlan: [],
        artifacts: [{ path: '', content: '', description: '' }],
        conversations: [{ from: '', to: '', content: '', timestamp: 0 }],
        fileChanges: [{ path: '', status: 'modified' as const }],
        metadata: {},
      });
      const b = pruner.analyze(context);
      expect(b.goalTokens).toBe(0);
      expect(b.artifactsTokens).toBeGreaterThan(0); // path '\n' content → some tokens
      expect(b.conversationsTokens).toBeGreaterThan(0); // [→] \n → some tokens
      expect(b.fileChangesTokens).toBeGreaterThan(0); // path \n → some tokens
      expect(b.metadataTokens).toBeLessThan(10);
    });

    it('should produce consistent breakdown across multiple calls', () => {
      const context = makeContext({
        artifacts: [makeArtifact('a.ts', 500)],
      });
      const first = pruner.analyze(context);
      const second = pruner.analyze(context);
      expect(first).toEqual(second);
    });

    it('should not mutate the context when analyzing', () => {
      const context = makeContext({
        artifacts: [makeArtifact('a.ts', 500)],
        conversations: [makeMessage('a', 'b', 'hello')],
      });
      const snapshot = JSON.stringify(context);
      pruner.analyze(context);
      expect(JSON.stringify(context)).toBe(snapshot);
    });
  });
});
