/**
 * Issue Triage Agent — Fetches open issues, classifies them via LLM, assigns priority,
 * suggests labels, and optionally posts triage comments with analysis.
 *
 * Capabilities:
 * - Fetch open unlabeled issues from GitHub or GitLab
 * - Classify issues by type: bug, feature, question, docs, chore
 * - Assign priority: critical, high, medium, low
 * - Suggest relevant labels (e.g., "bug", "enhancement", "good first issue")
 * - Estimate difficulty: easy, medium, hard
 * - Optionally auto-assign based on git blame expertise heuristics
 * - Post triage comment with analysis and suggested action
 *
 * Authentication (GitHub, priority order):
 * 1. GH_TOKEN env var
 * 2. GITHUB_TOKEN env var
 * 3. githubToken from context metadata
 *
 * Authentication (GitLab):
 * 1. GITLAB_TOKEN env var
 * 2. GITLAB_ACCESS_TOKEN env var
 * 3. gitlabToken from context metadata
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-triage", "description": "Triage open issues in my-org/my-repo", "agentType": "issue-triage", "dependsOn": [] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { GitLabAPIClient } from './gitlab-api-client.js';
/** Classification categories for issues */
export type IssueClassification = 'bug' | 'feature' | 'question' | 'docs' | 'chore';
/** Priority levels for issues */
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';
/** Difficulty estimate for issue resolution */
export type IssueDifficulty = 'easy' | 'medium' | 'hard';
/** A triaged issue with classification results */
export interface TriageResult {
    issueNumber: number;
    title: string;
    classification: IssueClassification;
    priority: IssuePriority;
    suggestedLabels: string[];
    suggestedAssignee?: string;
    suggestedMilestone?: string;
    estimatedDifficulty: IssueDifficulty;
    suggestedAction: string;
    reasoning: string;
}
/** A simplified issue from GitHub or GitLab */
export interface IssueSummary {
    number: number;
    title: string;
    body: string;
    author: string;
    labels: string[];
    createdAt: string;
    updatedAt: string;
    url: string;
    comments: number;
}
/**
 * Issue Triage Agent — Fetches open issues and classifies them via LLM.
 */
export declare class IssueTriageAgent extends Agent {
    readonly name = "Issue Triage";
    readonly description = "Classifies, prioritizes, and labels open issues from GitHub and GitLab";
    private gitlabClient;
    private ghToken;
    private glToken;
    constructor(gitlabClient?: GitLabAPIClient);
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private detectSource;
    private resolveGitHubRepo;
    private resolveGitLabProject;
    private get ghHeaders();
    private githubGet;
    private githubPatch;
    private githubPost;
    /** Fetch open issues from GitHub */
    private fetchGitHubIssues;
    /** Fetch open issues from GitLab */
    private fetchGitLabIssues;
    /** Fetch issues from the appropriate source */
    private fetchIssues;
    /** Ensure labels exist on a GitHub repo (create if missing) */
    private ensureGitHubLabels;
    /** Get a hex color for a label based on its name */
    private getLabelColor;
    /** Use git blame to determine who has the most expertise in files mentioned in the issue */
    private inferAssigneeFromGitBlame;
    /** Build a prompt for the LLM to classify a single issue */
    private buildClassificationPrompt;
    /** Parse the LLM classification response into a TriageResult */
    private parseClassificationResponse;
    private validateClassification;
    private validatePriority;
    private validateDifficulty;
    /** List unlabeled open issues */
    private listUnlabeledIssues;
    /** Triage a single issue by number */
    private triageSingleIssue;
    /** Triage all unlabeled open issues */
    private triageAllOpenIssues;
    /** Extract an issue number from a description */
    private extractIssueNumber;
    /** Build a triage comment for an issue */
    private buildTriageComment;
    /** Group triage results by classification */
    private groupByClassification;
    /** Group triage results by priority */
    private groupByPriority;
    /** Group triage results by difficulty */
    private groupByDifficulty;
}
//# sourceMappingURL=issue-triage-agent.d.ts.map