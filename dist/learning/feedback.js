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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const FEEDBACK_PATH = join(MEMORY_DIR, 'feedback.json');
const CURRENT_VERSION = 1;
const MAX_ENTRIES = 1000;
const TREND_WINDOW = 10; // Last N ratings for trend calculation
// ─── FeedbackStore ──────────────────────────────────────────────────────────
export class FeedbackStore {
    entries = [];
    constructor() {
        this.entries = this.load();
    }
    // ── Public API ──────────────────────────────────────────────────────────
    /**
     * Record a user rating.
     */
    record(trajectoryId, rating, context) {
        const entry = {
            id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            trajectoryId,
            rating,
            goal: context.goal,
            provider: context.provider,
            model: context.model,
            createdAt: Date.now(),
            source: 'cli',
            comment: context.comment,
        };
        this.entries.push(entry);
        // Prune old entries
        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(-MAX_ENTRIES);
        }
        this.save();
        return entry;
    }
    /**
     * Get all feedback entries.
     */
    getAll() {
        return [...this.entries];
    }
    /**
     * Get feedback for a specific trajectory.
     */
    getByTrajectory(trajectoryId) {
        return this.entries.filter((e) => e.trajectoryId === trajectoryId);
    }
    /**
     * Get the most recent rating for a trajectory (if any).
     */
    getLastRating(trajectoryId) {
        const trajectoryFeedback = this.entries
            .filter((e) => e.trajectoryId === trajectoryId)
            .sort((a, b) => b.createdAt - a.createdAt);
        return trajectoryFeedback[0]?.rating;
    }
    /**
     * Convert a user rating to a score multiplier for trajectory ranking.
     * Positive → +0.3, Negative → -0.3, Neutral → 0, Skip → 0
     */
    ratingToScoreDelta(rating) {
        switch (rating) {
            case 'positive': return 0.3;
            case 'negative': return -0.3;
            case 'neutral': return 0;
            case 'skip': return 0;
        }
    }
    /**
     * Get aggregated feedback statistics.
     */
    getStats() {
        const total = this.entries.length;
        if (total === 0) {
            return { totalRatings: 0, positiveRatio: 0, negativeRatio: 0, neutralRatio: 0, recentTrend: 'stable' };
        }
        const positives = this.entries.filter((e) => e.rating === 'positive').length;
        const negatives = this.entries.filter((e) => e.rating === 'negative').length;
        const neutrals = this.entries.filter((e) => e.rating === 'neutral').length;
        // Calculate trend from recent window
        const recent = this.entries.slice(-TREND_WINDOW);
        const recentPositives = recent.filter((e) => e.rating === 'positive').length;
        const recentNegatives = recent.filter((e) => e.rating === 'negative').length;
        const recentRatio = recentNegatives > 0 ? recentPositives / recentNegatives : recentPositives;
        const overallPositives = this.entries.slice(0, -TREND_WINDOW).filter((e) => e.rating === 'positive').length;
        const overallNegatives = this.entries.slice(0, -TREND_WINDOW).filter((e) => e.rating === 'negative').length;
        const overallRatio = overallNegatives > 0 ? overallPositives / overallNegatives : overallPositives;
        let recentTrend;
        if (recentRatio > overallRatio * 1.1) {
            recentTrend = 'improving';
        }
        else if (recentRatio < overallRatio * 0.9) {
            recentTrend = 'declining';
        }
        else {
            recentTrend = 'stable';
        }
        return {
            totalRatings: total,
            positiveRatio: total > 0 ? positives / total : 0,
            negativeRatio: total > 0 ? negatives / total : 0,
            neutralRatio: total > 0 ? neutrals / total : 0,
            recentTrend,
        };
    }
    /**
     * Clear all feedback data.
     */
    clear() {
        this.entries = [];
        this.save();
    }
    // ── Private ────────────────────────────────────────────────────────────
    load() {
        try {
            ensureDir();
            if (!existsSync(FEEDBACK_PATH))
                return [];
            const raw = readFileSync(FEEDBACK_PATH, 'utf-8');
            const data = JSON.parse(raw);
            return data.entries || [];
        }
        catch {
            return [];
        }
    }
    save() {
        ensureDir();
        const data = { entries: this.entries, version: CURRENT_VERSION };
        writeFileSync(FEEDBACK_PATH, JSON.stringify(data, null, 2), 'utf-8');
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let storeInstance = null;
export function getFeedbackStore() {
    if (!storeInstance) {
        storeInstance = new FeedbackStore();
    }
    return storeInstance;
}
export function resetFeedbackStore() {
    storeInstance = null;
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
//# sourceMappingURL=feedback.js.map