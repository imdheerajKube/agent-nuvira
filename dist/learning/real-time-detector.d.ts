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
export declare class RealTimeSkillDetector {
    /** Sliding window of recent tool calls */
    private buffer;
    /** Detected patterns (hash → pattern) */
    private patterns;
    /** Timestamp of last draft creation (cooldown) */
    private lastDraftAt;
    /** Whether detection is enabled */
    private enabled;
    /** Session ID for draft naming */
    private sessionId;
    constructor(sessionId?: string, enabled?: boolean);
    /**
     * Called after every successful tool call.
     * Buffers the event and triggers async pattern detection.
     * NEVER blocks the caller.
     */
    onToolCallSuccess(raw: {
        tool: string;
        ok: boolean;
        durationMs: number;
    }): void;
    /**
     * Async pattern detection — runs in background.
     * Extracts the recent tool sequence, hashes it, and checks for novelty.
     */
    private detectPatternAsync;
    /**
     * Calculate success rate for a tool sequence from buffer history.
     */
    private calculateSuccessRate;
    /**
     * Create a skill draft from a detected pattern.
     * Uses the existing SkillDraftStore (skill-drafts.ts).
     */
    private createSkillDraft;
    /**
     * Generate a skill name from a detected pattern.
     * Format: `rt-<tool1>-<tool2>-<hash4>`
     */
    private generateSkillName;
    /**
     * Generate a human-readable description from a pattern.
     */
    private generateDescription;
    /**
     * Build SKILL.md content compatible with the existing skill format.
     * Includes YAML frontmatter + markdown body.
     */
    private buildSkillMarkdown;
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
    };
    /**
     * Enable/disable detection.
     */
    setEnabled(enabled: boolean): void;
    /**
     * Clear buffer and patterns (e.g., on session reset).
     */
    reset(): void;
}
/**
 * Get or create the singleton detector.
 * Called by tool-loop.ts after each successful tool call.
 */
export declare function getRealTimeDetector(sessionId?: string): RealTimeSkillDetector;
/**
 * Reset the singleton (e.g., on new session).
 */
export declare function resetRealTimeDetector(): void;
//# sourceMappingURL=real-time-detector.d.ts.map