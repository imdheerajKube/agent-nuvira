/**
 * ReviewerAgent — Validates code changes produced by the WriterAgent.
 *
 * The reviewer checks for:
 * - Syntax errors and type mismatches
 * - Security vulnerabilities (SQL injection, XSS, etc.)
 * - Code style and conventions
 * - Correctness of the implementation against the task description
 * - Missing edge cases and error handling
 *
 * Output is stored in the shared context bus as conversation messages.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * ReviewerAgent — Validates code changes produced by WriterAgent.
 */
export declare class ReviewerAgent extends Agent {
    readonly name = "Reviewer";
    readonly description = "Validates code changes for correctness, security, and quality";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Build the review prompt from the task plan, relevant context, and changes.
     */
    private buildPrompt;
    /**
     * Check if the review response contains any critical issues.
     * Looks for "CRITICAL:" (with colon) at the start of a bullet or line.
     * This avoids false positives from LLMs that say things like
     * "No critical issues found" (which lacks the colon prefix).
     */
    private hasCriticalIssues;
}
//# sourceMappingURL=reviewer.d.ts.map