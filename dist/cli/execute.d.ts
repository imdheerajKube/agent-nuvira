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
     * Run the orchestrator for a single goal and display results.
     * Returns the outcome so the caller can record it in session history.
     */
    private runSingleGoal;
    private showMemoryStats;
    private clearMemory;
}
/**
 * Pretty-print the orchestration result to the console.
 */
export declare function printOrchestrationResult(result: import('../agents/orchestrator.js').OrchestrationResult): void;
//# sourceMappingURL=execute.d.ts.map