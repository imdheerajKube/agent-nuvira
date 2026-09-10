/**
 * UserProfile — Bounded user model (inspired by Hermes USER.md).
 *
 * Tracks user preferences, decision patterns, and domain expertise.
 * Uses forced consolidation (2000 char limit) to prevent context bloat.
 *
 * Integration with existing memory system:
 * - LocalMemoryProvider.prefetch() injects user profile context
 * - LocalMemoryProvider.syncTurn() updates profile after each turn
 * - Orchestrator includes profile in vault metadata
 *
 * Storage: ~/.nuvira/USER.md (bounded, auto-consolidated)
 */
export interface UserProfile {
    /** User preferences (formatting, detail level, style) */
    preferences: Map<string, string>;
    /** Decision history (what user accepted/rejected) */
    decisions: DecisionPattern[];
    /** Detected domain expertise */
    expertise: DomainExpertise;
    /** Last updated timestamp */
    lastUpdated: number;
}
export interface DecisionPattern {
    /** Goal type (coding, writing, analysis, etc.) */
    goalType: string;
    /** Whether the user accepted the result */
    accepted: boolean;
    /** Timestamp */
    timestamp: number;
}
export interface DomainExpertise {
    /** Detected level: beginner, intermediate, expert */
    level: 'beginner' | 'intermediate' | 'expert' | 'unknown';
    /** Confidence in the detection (0-1) */
    confidence: number;
    /** Detected domains */
    domains: string[];
}
export declare class UserProfileManager {
    private profile;
    private filePath;
    constructor();
    /**
     * Update profile based on user interaction.
     * Called by LocalMemoryProvider.syncTurn() after each turn.
     */
    updateUserProfile(userMessage: string, _assistantText: string, accepted?: boolean): void;
    /**
     * Build user context block for prompt injection.
     * Called by LocalMemoryProvider.prefetch() to include in memory block.
     */
    buildUserContextBlock(): string;
    /**
     * Get profile summary (for dashboard/CLI).
     */
    getSummary(): {
        preferenceCount: number;
        expertise: string;
        domains: string[];
        recentDecisions: number;
        lastUpdated: string;
    };
    /**
     * Extract formatting preferences from user message.
     */
    private extractFormattingPreferences;
    /**
     * Consolidate profile when over limit.
     * Forces prioritization (like Hermes USER.md).
     */
    private consolidateIfNeeded;
    /**
     * Load profile from disk.
     */
    private load;
    /**
     * Save profile to disk.
     */
    private save;
    /**
     * Create default empty profile.
     */
    private createDefault;
}
export declare function getUserProfile(): UserProfileManager;
export declare function resetUserProfile(): void;
//# sourceMappingURL=user-profile.d.ts.map