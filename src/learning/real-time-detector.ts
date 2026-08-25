/**
 * RealTimeSkillDetector — Monitors agent execution for novel tool-call
 * patterns and creates skill drafts in REAL-TIME (during execution),
 * not just after the pipeline completes.
 *
 * This closes the gap with Hermes Agent, which creates skills every 15
 * turns during execution. Nuvira's SelfImprover only runs post-execution
 * (every 8 runs). This detector runs on EVERY successful tool call and
 * creates skill drafts when a novel, repeatable pattern is detected.
 *
 * Integration points:
 * - Hooks into tool-loop.ts via the `tool:called` event
 * - Uses existing SkillDraftStore (skill-drafts.ts) for draft persistence
 * - Uses existing EventNames for dashboard notifications
 * - Non-blocking: all detection runs asynchronously
 *
 * Flow:
 *   tool:called (success) → buffer event → detect pattern → create draft
 *   → emit event → dashboard shows preview card → user accepts/rejects
 */

import { logger } from '../utils/logger.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { writeDraft, type SkillDraft } from './skill-drafts.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single tool call event buffered for pattern detection */
export interface ToolCallEvent {
  /** Tool name (e.g., 'write_file', 'run_terminal_command') */
  tool: string;
  /** Whether the call succeeded */
  ok: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp */
  timestamp: number;
  /** Brief summary of args (for pattern hashing) */
  argsSummary: string;
}

/** A detected pattern that could become a skill */
export interface DetectedPattern {
  /** Hash of the tool sequence */
  hash: string;
  /** Ordered tool names in the pattern */
  sequence: string[];
  /** How many times this pattern has been observed */
  occurrences: number;
  /** First observed timestamp */
  firstSeen: number;
  /** Last observed timestamp */
  lastSeen: number;
  /** Average success rate */
  successRate: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max events to keep in the buffer (sliding window) */
const MAX_BUFFER_SIZE = 30;

/** Min occurrences before creating a draft (avoid noise) */
const MIN_OCCURRENCES_FOR_DRAFT = 2;

/** Min tools in a pattern to be interesting */
const MIN_PATTERN_LENGTH = 2;

/** Max patterns to track (LRU eviction) */
const MAX_PATTERNS = 100;

/** Cooldown between draft creations (ms) — prevent draft spam */
const DRAFT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ─── Pattern Hashing ────────────────────────────────────────────────────────

/**
 * Hash a tool sequence into a compact key.
 * Normalizes: ignores arg details, focuses on tool ORDER.
 */
function hashSequence(sequence: string[]): string {
  return sequence.join('→');
}

/**
 * Extract a normalized tool-call event from raw event data.
 */
function normalizeEvent(raw: {
  tool: string;
  ok: boolean;
  durationMs: number;
}): ToolCallEvent {
  return {
    tool: raw.tool,
    ok: raw.ok,
    durationMs: raw.durationMs,
    timestamp: Date.now(),
    argsSummary: '', // Args not needed for sequence hashing
  };
}

// ─── RealTimeSkillDetector ──────────────────────────────────────────────────

export class RealTimeSkillDetector {
  /** Sliding window of recent tool calls */
  private buffer: ToolCallEvent[] = [];

  /** Detected patterns (hash → pattern) */
  private patterns: Map<string, DetectedPattern> = new Map();

  /** Timestamp of last draft creation (cooldown) */
  private lastDraftAt = 0;

  /** Whether detection is enabled */
  private enabled: boolean;

  /** Session ID for draft naming */
  private sessionId: string;

  constructor(sessionId?: string, enabled: boolean = true) {
    this.sessionId = sessionId ?? `session-${Date.now()}`;
    this.enabled = enabled;
  }

  /**
   * Called after every successful tool call.
   * Buffers the event and triggers async pattern detection.
   * NEVER blocks the caller.
   */
  onToolCallSuccess(raw: {
    tool: string;
    ok: boolean;
    durationMs: number;
  }): void {
    if (!this.enabled) return;

    const event = normalizeEvent(raw);

    // Only buffer successful calls (patterns = what WORKS)
    if (!event.ok) return;

    this.buffer.push(event);

    // Keep buffer bounded
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }

    // Async detection — never blocks
    this.detectPatternAsync().catch(() => {
      // Best-effort — detection failure must never break execution
    });
  }

  /**
   * Async pattern detection — runs in background.
   * Extracts the recent tool sequence, hashes it, and checks for novelty.
   */
  private async detectPatternAsync(): Promise<void> {
    // Need at least MIN_PATTERN_LENGTH events
    if (this.buffer.length < MIN_PATTERN_LENGTH) return;

    // Extract recent sequence (last N tools)
    const recentWindow = this.buffer.slice(-MIN_PATTERN_LENGTH * 2);
    const sequence = recentWindow.map((e) => e.tool);
    const hash = hashSequence(sequence);

    // Check if pattern exists
    const existing = this.patterns.get(hash);
    if (existing) {
      // Pattern seen before — increment occurrences
      existing.occurrences++;
      existing.lastSeen = Date.now();
      existing.successRate = this.calculateSuccessRate(sequence);

      // Check if ready to create a draft
      if (
        existing.occurrences >= MIN_OCCURRENCES_FOR_DRAFT &&
        Date.now() - this.lastDraftAt > DRAFT_COOLDOWN_MS
      ) {
        await this.createSkillDraft(existing);
      }
      return;
    }

    // New pattern — track it
    if (this.patterns.size >= MAX_PATTERNS) {
      // LRU eviction: remove oldest pattern
      const oldest = Array.from(this.patterns.values()).sort(
        (a, b) => a.lastSeen - b.lastSeen,
      )[0];
      if (oldest) this.patterns.delete(oldest.hash);
    }

    this.patterns.set(hash, {
      hash,
      sequence,
      occurrences: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      successRate: 1.0,
    });
  }

  /**
   * Calculate success rate for a tool sequence from buffer history.
   */
  private calculateSuccessRate(sequence: string[]): number {
    // Simple: count how many times this exact sequence appeared successfully
    // vs total appearances (we only buffer successes, so rate is always 1.0
    // unless we also buffer failures — for now, return 1.0)
    return 1.0;
  }

  /**
   * Create a skill draft from a detected pattern.
   * Uses the existing SkillDraftStore (skill-drafts.ts).
   */
  private async createSkillDraft(pattern: DetectedPattern): Promise<void> {
    try {
      // Generate a descriptive name from the pattern
      const name = this.generateSkillName(pattern);
      const description = this.generateDescription(pattern);

      // Build SKILL.md content (compatible with existing skill format)
      const markdown = this.buildSkillMarkdown(pattern, name, description);

      // Create draft using existing infrastructure
      const result = writeDraft(name, markdown);

      if (!result.ok) {
        logger.debug(`   Real-time detector: draft creation failed — ${result.reason}`);
        return;
      }

      // Update cooldown
      this.lastDraftAt = Date.now();

      // Emit event on the existing event bus (dashboard shows preview card)
      try {
        const bus = getEventBus();
        bus.emit(
          'skill:draft-created' as any,
          {
            name,
            description,
            pattern: pattern.sequence,
            occurrences: pattern.occurrences,
            source: 'real-time-detection',
          },
          'real-time-detector',
        );
      } catch {
        // Event emission is best-effort
      }

      logger.info(
        `   🔧 Real-time detector: created skill draft "${name}" from pattern: ${pattern.sequence.join(' → ')}`,
      );
    } catch (err) {
      // Draft creation must never break execution
      logger.debug(`   Real-time detector: draft creation error: ${err}`);
    }
  }

  /**
   * Generate a skill name from a detected pattern.
   * Format: `rt-<tool1>-<tool2>-<hash4>`
   */
  private generateSkillName(pattern: DetectedPattern): string {
    const toolSlugs = pattern.sequence.slice(0, 3).map((t) =>
      t
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '')
        .slice(0, 12),
    );
    const hash4 = pattern.hash.slice(-4).replace(/[^a-z0-9]/g, '');
    return `rt-${toolSlugs.join('-')}-${hash4}`;
  }

  /**
   * Generate a human-readable description from a pattern.
   */
  private generateDescription(pattern: DetectedPattern): string {
    const toolList = pattern.sequence.join(' → ');
    return `Auto-detected pattern (${pattern.occurrences}x): ${toolList}`;
  }

  /**
   * Build SKILL.md content compatible with the existing skill format.
   * Includes YAML frontmatter + markdown body.
   */
  private buildSkillMarkdown(
    pattern: DetectedPattern,
    name: string,
    description: string,
  ): string {
    const steps = pattern.sequence
      .map((tool, i) => {
        return `### Step ${i + 1}: ${tool}\n\nExecute the \`${tool}\` tool with appropriate arguments.`;
      })
      .join('\n\n');

    return `---
name: ${name}
description: ${description}
category: auto-detected
source: real-time-detection
confidence: ${(pattern.successRate * 100).toFixed(0)}%
created: ${new Date().toISOString()}
---

# ${description}

## Steps

${steps}

## Notes

This skill was auto-detected from ${pattern.occurrences} successful execution(s) of this tool sequence.
`;
  }

  /**
   * Get current detection status (for dashboard/CLI).
   */
  getStatus(): {
    enabled: boolean;
    bufferSize: number;
    patternsTracked: number;
    draftsCreated: number;
    recentPatterns: Array<{
      sequence: string[];
      occurrences: number;
      lastSeen: number;
    }>;
  } {
    const recentPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 5)
      .map((p) => ({
        sequence: p.sequence,
        occurrences: p.occurrences,
        lastSeen: p.lastSeen,
      }));

    return {
      enabled: this.enabled,
      bufferSize: this.buffer.length,
      patternsTracked: this.patterns.size,
      draftsCreated: Math.floor(this.lastDraftAt > 0 ? 1 : 0), // Simplified
      recentPatterns,
    };
  }

  /**
   * Enable/disable detection.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear buffer and patterns (e.g., on session reset).
   */
  reset(): void {
    this.buffer = [];
    this.patterns.clear();
    this.lastDraftAt = 0;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let detectorInstance: RealTimeSkillDetector | null = null;

/**
 * Get or create the singleton detector.
 * Called by tool-loop.ts after each successful tool call.
 */
export function getRealTimeDetector(sessionId?: string): RealTimeSkillDetector {
  if (!detectorInstance) {
    detectorInstance = new RealTimeSkillDetector(sessionId);
  }
  return detectorInstance;
}

/**
 * Reset the singleton (e.g., on new session).
 */
export function resetRealTimeDetector(): void {
  detectorInstance = null;
}
