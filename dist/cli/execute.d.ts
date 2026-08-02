/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Single-shot mode:
 *   buff execute "add JWT authentication to the Express app"
 *   buff execute "create a CLI tool" --provider gemini --dry-run
 *   buff execute "add tests" --verbose --memory
 *   buff execute "fix bug" --memory --memory-stats
 *   buff execute "run tests" --sandbox
 *
 * Interactive development mode (no goal argument):
 *   buff execute
 *     → Model picker (if no --model flag)
 *     → Interactive loop: goal → orchestrator → results → next goal
 *     → Type /exit to quit
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/** A single goal execution entry in the session history */
export interface SessionEntry {
    goal: string;
    success: boolean;
    summary: string;
    timestamp: number;
}
/**
 * Map the CLI's `--checkpoint` / `--resume [id]` flags onto the orchestrator's
 * checkpoint options. Bare `--resume` (value `true`) means "resume the auto id
 * for this goal + cwd" → resumeCheckpointId undefined, resumeRequested true.
 * `--checkpoint` alone saves forward without resuming. Extracted as a pure
 * exported helper so the mapping is unit-testable without a full orchestration.
 */
export declare function checkpointOptions(checkpoint: boolean | undefined, resume: string | boolean | undefined): {
    checkpoint: boolean;
    resumeCheckpointId: string | undefined;
    resumeRequested: boolean;
};
/**
 * Parse multi-line goal input into a single goal string.
 *
 * Used by readGoal() which collects lines from readline; extracted as a
 * pure function so it can be unit-tested without mocking stdin/stdout.
 *
 * @param lines       Lines collected from user input
 * @returns           The joined goal string (blank lines collapsed)
 */
export declare function parseGoalLines(lines: string[]): string;
/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export declare class ExecuteCommand extends BaseCommand {
    create(): Command;
    private execute;
    /**
     * Interactive development mode — model picker → goal prompt → orchestrator → loop until exit.
     */
    private runInteractiveDevMode;
    /**
     * Display the session goal history.
     */
    private showSessionHistory;
    /**
     * Prompt the user for a goal using readline (supports multi-line input).
     * Delegates to parseGoalLines() for the actual line-joining logic.
     */
    private readGoal;
    /**
     * Handle slash-commands in development mode.
     */
    private handleDevCommand;
    /**
     * Save the current development session to disk.
     */
    private handleSave;
    /**
     * Resume a saved development session.
     */
    private handleResume;
    /**
     * Show suggestions from past trajectories (auto-completion via /suggest).
     */
    private handleSuggest;
    /**
     * Shared handler for post-execution tasks:
     * 1. Track the goal in session history
     * 2. Update lastFailedGoal tracking (returns the updated value since params are passed by value)
     * 3. Generate dynamic choices (analysis + follow-ups)
     * 4. Prompt the user
     * 5. Return the parsed action + updated lastFailedGoal
     *
     * Called after EVERY goal execution (main, follow-up, retry-fix)
     * so that the interactive UX is consistent.
     */
    private handlePostExecution;
    /**
     * Generate context-aware choices for the post-execution prompt.
     *
     * After a SUCCESS: shows LLM-generated follow-up suggestions
     * After a FAILURE: shows failure analysis and specific recovery options
     * Always includes: enter another goal, switch model, history, exit
     */
    private generatePostExecutionActions;
    /**
     * LLM-powered follow-up suggestion generator.
     *
     * Uses the current provider to generate contextually relevant next steps
     * based on what was just accomplished. Falls back to rule-based suggestions
     * if the LLM call fails.
     */
    private generateFollowUpSuggestions;
    /**
     * Analyze a failed orchestration result to determine what went wrong
     * and suggest recovery actions.
     */
    private analyzeFailure;
    /**
     * Display a concise failure analysis to the user.
     */
    private showFailureAnalysis;
    /**
     * Run the orchestrator for a single goal and display results.
     * Returns the outcome so the caller can record it in session history.
     */
    private runSingleGoal;
    /**
     * Show saved checkpoints (goal, completion, age) and how to resume them.
     */
    private showCheckpointList;
    private showMemoryStats;
    private clearMemory;
}
/**
 * Pretty-print the orchestration result to the console.
 */
export declare function printOrchestrationResult(result: import('../agents/orchestrator.js').OrchestrationResult): void;
//# sourceMappingURL=execute.d.ts.map