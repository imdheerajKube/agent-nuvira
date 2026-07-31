/**
 * GitAgent — Manages git operations for the publishing pipeline.
 *
 * Capabilities:
 * - Create branches
 * - Commit changes with auto-generated commit messages (via LLM)
 * - Generate PR descriptions from git diff
 * - Check git status
 * - Push commits to remote (with credential management)
 * - Create and push tags
 * - Auto-push — commit + tag + push in one operation
 *
 * This agent does NOT require an LLM for basic operations (status, branch, commit, push),
 * but uses the LLM for generating commit messages and PR descriptions.
 *
 * Credential handling:
 * - HTTPS: Uses GIT_ASKPASS env var (set by CredentialStore)
 * - SSH: Uses SSH agent (keys added by CredentialStore)
 * - Falls back to git's built-in credential helpers if available
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-commit", "description": "Commit and push changes to git", "agentType": "git", "dependsOn": ["step-write"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * GitAgent — Handles git operations for the multi-agent pipeline.
 */
export declare class GitAgent extends Agent {
    readonly name = "Git";
    readonly description = "Manages git operations (branch, commit, push, PR)";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private gitStatus;
    private createBranch;
    private commit;
    /**
     * Push the current branch to the remote.
     * Uses GIT_ASKPASS for HTTPS auth (set by CredentialStore) or SSH agent.
     */
    private pushToRemote;
    private createAndPushTag;
    private pushTagToRemote;
    private autoPush;
    private generatePRDescription;
    private exec;
}
//# sourceMappingURL=git-agent.d.ts.map