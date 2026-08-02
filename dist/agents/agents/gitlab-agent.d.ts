/**
 * GitLab Agent — Manages GitLab operations via the GitLab API.
 *
 * Capabilities:
 * - Create merge requests with title, description, labels
 * - Comment on merge requests (code review inline + summary)
 * - Create and comment on issues
 * - List merge requests/issues for triage
 * - Check pipeline status
 * - Auto-merge approved MRs
 *
 * Uses the existing GitAgent for local git operations (branch, commit, push)
 * and delegates remote GitLab operations (MR, issues, comments) to the API client.
 *
 * Requires: GITLAB_TOKEN env var or explicit token.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-mr", "description": "Create merge request for fix-login branch", "agentType": "gitlab", "dependsOn": ["step-commit"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { GitLabAPIClient } from './gitlab-api-client.js';
/**
 * GitLab Agent — Handles GitLab operations for the multi-agent pipeline.
 */
export declare class GitLabAgent extends Agent {
    readonly name = "GitLab";
    readonly description = "Manages GitLab operations (MR, issues, comments, pipelines)";
    private client;
    constructor(client?: GitLabAPIClient);
    execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    /**
     * Resolve the GitLab project ID from the context or task description.
     * Checks: task description → context metadata → git remote
     */
    private resolveProjectId;
    /** Discover accessible GitLab projects */
    private discoverProjects;
    /** Create a merge request */
    private createMergeRequest;
    /** List merge requests */
    private listMergeRequests;
    /** Comment on a merge request */
    private commentOnMR;
    /** Merge a merge request */
    private mergeMR;
    /** Create an issue */
    private createIssue;
    /** List issues */
    private listIssues;
    /** Comment on an issue */
    private commentOnIssue;
    /** Check pipeline status */
    private checkPipelineStatus;
    /** Detect a branch name from the task description */
    private detectBranch;
    /** Detect the target branch from the task description */
    private detectTargetBranch;
    /** Generate an MR title from the description and goal */
    private generateMRTitle;
    /** Generate an MR description from the goal */
    private generateMRDescription;
    /** Extract MR number from description: "!42" or "MR 42" or "merge request 42" */
    private extractMRNumber;
    /** Extract issue number from description: "#42" or "issue 42" */
    private extractIssueNumber;
    /** Extract comment text from description */
    private extractCommentText;
}
//# sourceMappingURL=gitlab-agent.d.ts.map