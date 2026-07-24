/**
 * GitAgent — Manages git operations for the publishing pipeline.
 *
 * Capabilities:
 * - Create branches
 * - Commit changes with auto-generated commit messages (via LLM)
 * - Generate PR descriptions from git diff
 * - Check git status
 *
 * This agent does NOT require an LLM for basic operations (status, branch, commit),
 * but uses the LLM for generating commit messages and PR descriptions.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-commit", "description": "Commit changes to git", "agentType": "git", "dependsOn": ["step-write"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * GitAgent — Handles git operations for the multi-agent pipeline.
 */
export declare class GitAgent extends Agent {
    readonly name = "Git";
    readonly description = "Manages git operations (branch, commit, PR)";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private gitStatus;
    private createBranch;
    private commit;
    private generatePRDescription;
    private exec;
}
//# sourceMappingURL=git-agent.d.ts.map