/**
 * TrajectoryScorer — Scores execution trajectories based on outcome quality.
 *
 * Scoring heuristics (max score = 1.0):
 * - Base completion: 0.4 (all tasks completed → 0.4, partial → proportional)
 * - No test failures: +0.3 (all tests passed)
 * - No reviewer issues: +0.2 (reviewer approved)
 * - Fewer iterations: +0.1 (fewer agent steps = more efficient)
 *
 * Scores are computed when a trajectory is saved and can be re-scored later
 * if the user provides feedback (e.g., "accepted changes").
 *
 * Scoring happens at save time in the TrajectoryStore and is stored
 * in the trajectory's `score` field for search ranking.
 */
import type { OrchestrationResult } from '../agents/orchestrator.js';
export interface ScoreComponents {
    /** 0–0.4: based on task completion ratio */
    completionScore: number;
    /** 0–0.3: based on test success */
    testScore: number;
    /** 0–0.2: based on reviewer approval */
    reviewScore: number;
    /** 0–0.1: based on efficiency (fewer iterations) */
    efficiencyScore: number;
    /** Total score (0–1), clamped */
    total: number;
}
export interface ScoreInput {
    /** Tasks completed vs total (e.g., 5/5) */
    tasksCompleted: number;
    tasksTotal: number;
    /** Whether all tests passed (from TesterAgent) */
    testsPassed?: boolean;
    /** Whether the reviewer approved (no critical issues) */
    reviewPassed?: boolean;
    /** Number of agent steps executed (fewer = more efficient) */
    totalSteps?: number;
    /** 0–1 user feedback (1 = accepted without changes) */
    userAcceptance?: number;
}
/**
 * Score a trajectory execution outcome.
 * Returns component scores and the total.
 */
export declare function scoreTrajectory(input: ScoreInput): ScoreComponents;
/**
 * Convenience: score an OrchestrationResult directly.
 */
export declare function scoreOrchestrationResult(result: OrchestrationResult, extra?: Partial<ScoreInput>): number;
//# sourceMappingURL=scorer.d.ts.map