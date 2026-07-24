/**
 * Feedback — User feedback integration for the self-improvement system.
 *
 * Tracks user ratings (👍/👎/skip) on individual trajectory results and
 * injects those scores back into the scoring system. This enables the
 * self-improver to learn which kinds of outputs users actually find useful.
 *
 * Data stored at: ~/.buff/memory/feedback.json
 *
 * The feedback system provides:
 * - Simple rating collection (positive, negative, neutral)
 * - Rating trails (sequences of ratings over time)
 * - Score injection into trajectory search ranking
 * - Feedback-driven pattern validation
 */
/** User rating for a specific execution result */
export type Rating = 'positive' | 'negative' | 'neutral' | 'skip';
/** A single feedback record */
export interface FeedbackEntry {
    /** Unique feedback ID */
    id: string;
    /** Trajectory ID this feedback refers to */
    trajectoryId: string;
    /** User rating */
    rating: Rating;
    /** Optional user comment */
    comment?: string;
    /** Which goal/command was being executed */
    goal: string;
    /** Which provider/model was used */
    provider: string;
    model: string;
    /** Timestamp */
    createdAt: number;
    /** Source of the feedback (cli, api, etc.) */
    source: string;
}
/** Aggregated feedback statistics */
export interface FeedbackStats {
    totalRatings: number;
    positiveRatio: number;
    negativeRatio: number;
    neutralRatio: number;
    recentTrend: 'improving' | 'declining' | 'stable';
}
export declare class FeedbackStore {
    private entries;
    constructor();
    /**
     * Record a user rating.
     */
    record(trajectoryId: string, rating: Rating, context: {
        goal: string;
        provider: string;
        model: string;
        comment?: string;
    }): FeedbackEntry;
    /**
     * Get all feedback entries.
     */
    getAll(): FeedbackEntry[];
    /**
     * Get feedback for a specific trajectory.
     */
    getByTrajectory(trajectoryId: string): FeedbackEntry[];
    /**
     * Get the most recent rating for a trajectory (if any).
     */
    getLastRating(trajectoryId: string): Rating | undefined;
    /**
     * Convert a user rating to a score multiplier for trajectory ranking.
     * Positive → +0.3, Negative → -0.3, Neutral → 0, Skip → 0
     */
    ratingToScoreDelta(rating: Rating): number;
    /**
     * Get aggregated feedback statistics.
     */
    getStats(): FeedbackStats;
    /**
     * Clear all feedback data.
     */
    clear(): void;
    private load;
    private save;
}
export declare function getFeedbackStore(): FeedbackStore;
export declare function resetFeedbackStore(): void;
//# sourceMappingURL=feedback.d.ts.map