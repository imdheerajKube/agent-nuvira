/**
 * PR Review Agent — Discovers open PRs, reads diffs, runs VerifyModule checks,
 * and posts inline review comments via the GitHub API.
 *
 * Capabilities:
 * - List open PRs on a repository
 * - Fetch PR diff (changed files with line numbers)
 * - Run VerifyModule security + quality scans on changed files
 * - Post inline review comments on specific lines
 * - Post a summary comment with pass/fail/blockers/suggestions
 *
 * Authentication (priority order):
 * 1. GH_TOKEN env var
 * 2. GITHUB_TOKEN env var
 * 3. githubApiKey from context metadata
 * 4. `gh` CLI (fallback for PR listing)
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-review-prs", "description": "Review open PRs for security issues", "agentType": "pr-review", "dependsOn": [] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { type VerifyModule } from '../verify-module.js';
/**
 * PR Review Agent — Reviews open pull requests for security, quality, and correctness.
 */
export declare class PRReviewAgent extends Agent {
    readonly name = "PR Review";
    readonly description = "Reviews open pull requests for security issues, code quality, and correctness";
    private verifyModule;
    private token;
    constructor(verifyModule?: VerifyModule);
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private resolveRepoInfo;
    private resolveToken;
    private get headers();
    private githubGet;
    private githubPost;
    /** List open PRs for the repository */
    private listOpenPRs;
    /** Review a single PR by number */
    private reviewSinglePR;
    /** Review all open PRs */
    private reviewAllOpenPRs;
    /** Summarize a specific PR */
    private summarizePR;
    /**
     * Review a single PR:
     * 1. Fetch the PR details
     * 2. Fetch the changed files with patches
     * 3. Run VerifyModule security scan on each file
     * 4. Post inline comments on issues found
     * 5. Post a summary comment
     */
    private reviewPR;
    /** Extract a PR number from a description */
    private extractPRNumber;
    /**
     * Extract a relevant line number from a unified diff patch.
     * Heuristic: find the first occurrence of the issue text in the patch
     * and map it back to the new file line number.
     */
    private extractLineFromPatch;
}
//# sourceMappingURL=pr-review-agent.d.ts.map