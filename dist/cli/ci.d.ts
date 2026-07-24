/**
 * CI command — Headless CI/CD mode for deterministic pipeline execution.
 *
 * Designed for use in CI/CD pipelines (GitHub Actions, GitLab CI, etc.)
 * with structured JSON output and exit codes. No fancy UI — machine-first.
 *
 * Usage:
 *   buff ci execute "add JWT auth"             # Execute goal, emit JSON result, exit 0/1
 *   buff ci execute "run tests" --provider groq
 *   buff ci execute "fix bug" --github-annotations  # GitHub Actions annotation format
 *   buff ci check "is the build green?"        # Exit code 0/1 gate check
 *   buff ci review src/auth.ts src/api.ts      # Review files, emit JSON findings
 *   buff ci review --format github             # GitHub Actions annotation format
 *
 * Exit codes:
 *   0 = Success / All checks pass
 *   1 = Failure / Checks failed / Error occurred
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export interface CIExecuteResult {
    /** Overall success/failure */
    success: boolean;
    /** The original goal */
    goal: string;
    /** Human-readable summary */
    summary: string;
    /** Tasks completed / total */
    tasksCompleted: number;
    tasksTotal: number;
    /** File changes summary as readable string */
    fileChanges?: string;
    /** Runner command output */
    runOutput?: string;
    /** Error message if failed */
    error?: string;
    /** Trajectory ID if memory was stored */
    trajectoryId?: string;
    /** Duration in milliseconds */
    durationMs: number;
    /** Provider/model used */
    provider?: string;
    model?: string;
}
export interface CIReviewFinding {
    /** File path */
    file: string;
    /** Severity: error | warning | info */
    severity: 'error' | 'warning' | 'info';
    /** Line number (1-based) */
    line?: number;
    /** Column number (1-based) */
    column?: number;
    /** Finding message */
    message: string;
    /** Suggestion for fixing */
    suggestion?: string;
}
export interface CIReviewResult {
    /** Overall pass/fail */
    success: boolean;
    /** Number of files reviewed */
    filesReviewed: number;
    /** Total findings */
    totalFindings: number;
    /** Findings grouped by severity */
    errors: number;
    warnings: number;
    infos: number;
    /** All findings */
    findings: CIReviewFinding[];
    /** Duration in milliseconds */
    durationMs: number;
}
export interface CICheckResult {
    /** Whether the check passed (exit code 0) or failed (exit code 1) */
    passed: boolean;
    /** Summary of what was checked */
    summary: string;
    /** Detailed reasoning */
    details?: string;
    /** Duration in milliseconds */
    durationMs: number;
}
export declare class CICommand extends BaseCommand {
    create(): Command;
    private ciExecute;
    private ciCheck;
    private ciReview;
}
/**
 * Parse the ReviewerAgent's text summary into structured findings.
 * Looks for common review patterns like:
 *   - ERROR: ... | WARNING: ... | INFO: ...
 *   - Line 42: ... | L42: ...
 *   - - [ ] ... (checklist items)
 */
export declare function parseReviewOutput(file: string, text: string): CIReviewFinding[];
//# sourceMappingURL=ci.d.ts.map