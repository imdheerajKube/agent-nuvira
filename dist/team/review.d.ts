/**
 * Team Review — Review workflow (agent PR → review → merge).
 *
 * The review workflow enables team members to review agent-generated changes
 * before applying them. It mimics a simplified PR workflow:
 *
 * 1. PR Creation: Agent proposes changes → saved as a "review bundle"
 * 2. Review: Team member reviews the proposed changes
 * 3. Merge: Approved changes are applied to the working directory
 *
 * Review bundles are stored in ~/.buff/team/reviews/ and can be shared
 * via git (if team memory is set up) or locally.
 *
 * Each bundle contains:
 *   - Metadata (author, timestamp, goal, provider)
 *   - Proposed file changes (path, original, new content)
 *   - Review comments (status, feedback)
 */
/** Status of a review */
export type ReviewStatus = 'pending' | 'approved' | 'changes-requested' | 'merged' | 'rejected';
/** A single file change in a review bundle */
export interface ReviewFileChange {
    path: string;
    originalContent?: string;
    newContent?: string;
    status: 'created' | 'modified' | 'deleted';
}
/** A review comment */
export interface ReviewComment {
    reviewer: string;
    status: 'approve' | 'request-changes' | 'comment';
    comment: string;
    timestamp: number;
}
/** A complete review bundle */
export interface ReviewBundle {
    /** Unique review ID */
    id: string;
    /** Title/summary of the proposed changes */
    title: string;
    /** The original user goal that produced these changes */
    goal: string;
    /** Author (git user or hostname) */
    author: string;
    /** Current review status */
    status: ReviewStatus;
    /** When the bundle was created */
    createdAt: number;
    /** Provider used */
    provider: string;
    /** Model used */
    model: string;
    /** The proposed file changes */
    changes: ReviewFileChange[];
    /** Review comments */
    comments: ReviewComment[];
    /** Execution summary from the orchestrator */
    summary?: string;
    /** Tags for categorization */
    tags: string[];
}
/**
 * Create a new review bundle from proposed file changes.
 * Typically called after an agent execution to capture the proposed changes
 * for review before applying them.
 *
 * @param title — Short title for the review
 * @param goal — The original goal
 * @param changes — Proposed file changes
 * @param options — Optional metadata
 * @returns The created ReviewBundle
 */
export declare function createReview(title: string, goal: string, changes: ReviewFileChange[], options?: {
    provider?: string;
    model?: string;
    summary?: string;
    author?: string;
    tags?: string[];
}): ReviewBundle;
/**
 * Load a review bundle by ID.
 */
export declare function getReview(id: string): ReviewBundle | null;
/**
 * List all review bundles, sorted by recency.
 */
export declare function listReviews(limit?: number): ReviewBundle[];
/**
 * Add a review comment to a bundle.
 */
export declare function addReviewComment(id: string, reviewer: string, status: 'approve' | 'request-changes' | 'comment', comment: string): ReviewBundle | null;
/**
 * Merge a review bundle — apply approved changes to the working directory.
 *
 * @param id — Review bundle ID
 * @param workingDir — Working directory to apply changes to (default: process.cwd())
 * @returns The number of files changed
 */
export declare function mergeReview(id: string, workingDir?: string): number;
/**
 * Reject a review bundle.
 */
export declare function rejectReview(id: string, reason?: string): boolean;
/**
 * Create a review bundle from the current orchestrator result.
 * This captures all file changes proposed by the agents into a review.
 *
 * @param goal — The original goal
 * @param fileChanges — The proposed file changes from the orchestrator
 * @param summary — Execution summary
 * @returns The created ReviewBundle
 */
export declare function createReviewFromResult(goal: string, fileChanges: Array<{
    path: string;
    originalContent?: string;
    newContent?: string;
    status: string;
}>, summary?: string, options?: {
    provider?: string;
    model?: string;
    author?: string;
}): ReviewBundle;
//# sourceMappingURL=review.d.ts.map