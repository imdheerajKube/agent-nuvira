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
import { Agent } from '../agent.js';
import { GitLabAPIClient } from './gitlab-api-client.js';
// ─── Agent ──────────────────────────────────────────────────────────────────
/**
 * GitLab Agent — Handles GitLab operations for the multi-agent pipeline.
 */
export class GitLabAgent extends Agent {
    name = 'GitLab';
    description = 'Manages GitLab operations (MR, issues, comments, pipelines)';
    client;
    constructor(client) {
        super();
        this.client = client ?? new GitLabAPIClient();
    }
    async execute(context, _callLLM) {
        try {
            // Check if GitLab is configured
            if (!this.client.hasToken()) {
                return {
                    success: false,
                    summary: 'GitLab not configured',
                    error: 'Set GITLAB_TOKEN environment variable to use the GitLab agent',
                };
            }
            const taskDesc = context.taskPlan.find((s) => s.agentType === 'gitlab' && s.status === 'running')?.description || context.goal;
            const operation = this.detectOperation(taskDesc);
            const projectId = await this.resolveProjectId(context);
            switch (operation) {
                case 'discover':
                    return this.discoverProjects();
                case 'mr-create':
                    return this.createMergeRequest(context, taskDesc, projectId);
                case 'mr-list':
                    return this.listMergeRequests(projectId, taskDesc);
                case 'mr-comment':
                    return this.commentOnMR(context, taskDesc, projectId);
                case 'mr-merge':
                    return this.mergeMR(projectId, taskDesc);
                case 'issue-create':
                    return this.createIssue(context, taskDesc, projectId);
                case 'issue-list':
                    return this.listIssues(projectId, taskDesc);
                case 'issue-comment':
                    return this.commentOnIssue(context, taskDesc, projectId);
                case 'pipeline-status':
                    return this.checkPipelineStatus(projectId, taskDesc);
                default:
                    return this.createMergeRequest(context, taskDesc, projectId);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'GitLab operation failed', error: msg };
        }
    }
    // ─── Operation Detection ──────────────────────────────────────────────────
    detectOperation(description) {
        const lower = description.toLowerCase();
        // Discover projects
        if (lower.includes('discover') || lower.includes('list project') || lower.includes('find project'))
            return 'discover';
        // MR operations — use word-based matching for robustness
        // Split into words for more accurate intent detection
        const words = lower.split(/[\s,;:!?]+/);
        const hasMr = words.some(w => w === 'mr' || w === 'mrs' || w === 'merge' || w === 'merges');
        const hasMergeRequest = lower.includes('merge request') || lower.includes('merge requests');
        // 'create' + 'mr'/'merge request'
        if ((lower.includes('create') || lower.includes('new')) && (hasMr || hasMergeRequest))
            return 'mr-create';
        // 'list'/'show'/'open' + 'mr'/'merge request'
        if ((lower.includes('list') || lower.includes('show') || lower.includes('open')) && (hasMr || hasMergeRequest))
            return 'mr-list';
        // 'merge'/'accept'/'approve' as verb + 'mr'/'merge request'
        // Check if 'merge' appears as a separate word (not in 'merge request')
        const mergeAsVerb = words.includes('merge') || words.includes('merged') || words.includes('merging');
        if ((mergeAsVerb || lower.includes('accept') || lower.includes('approve')) && (hasMr || hasMergeRequest))
            return 'mr-merge';
        // 'comment'/'review' + 'mr'/'merge request'
        if ((lower.includes('comment') || lower.includes('review') || lower.includes('note')) && (hasMr || hasMergeRequest))
            return 'mr-comment';
        // Catch-all for other mr-related descriptions
        if (hasMr || hasMergeRequest)
            return 'mr-create';
        // Issue operations
        if (lower.includes('create issue') || lower.includes('new issue'))
            return 'issue-create';
        if (lower.includes('comment') && lower.includes('issue'))
            return 'issue-comment';
        if (lower.includes('list issue') || lower.includes('open issue') || lower.includes('show issue'))
            return 'issue-list';
        // Pipeline
        if (lower.includes('pipeline') || lower.includes('ci') || lower.includes('build status'))
            return 'pipeline-status';
        // Default
        return 'mr-create';
    }
    // ─── Project Resolution ───────────────────────────────────────────────────
    /**
     * Resolve the GitLab project ID from the context or task description.
     * Checks: task description → context metadata → git remote
     */
    async resolveProjectId(context) {
        // Check context metadata for a pre-resolved project ID
        const metaId = context.metadata?.gitlabProjectId;
        if (typeof metaId === 'number')
            return metaId;
        if (typeof metaId === 'string' && /^\d+$/.test(metaId))
            return Number(metaId);
        // Check for a project path in metadata (e.g., "my-org/my-project")
        const metaPath = context.metadata?.gitlabProjectPath;
        if (typeof metaPath === 'string') {
            try {
                const project = await this.client.getProject(metaPath);
                return project.id;
            }
            catch {
                // Fall through
            }
        }
        // Try to extract from the git remote
        try {
            const { execSync } = await import('node:child_process');
            const remote = execSync('git remote get-url origin 2>&1', {
                timeout: 10_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
            // Parse gitlab.com URLs: git@gitlab.com:org/repo.git or https://gitlab.com/org/repo.git
            const match = remote.match(/gitlab\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
            if (match) {
                const projectPath = match[1];
                try {
                    const project = await this.client.getProject(projectPath);
                    return project.id;
                }
                catch {
                    // Fall through
                }
            }
        }
        catch {
            // Fall through
        }
        return null;
    }
    // ─── Operations ───────────────────────────────────────────────────────────
    /** Discover accessible GitLab projects */
    async discoverProjects() {
        const projects = await this.client.listProjects({ membership: true });
        if (projects.length === 0) {
            return { success: true, summary: 'No GitLab projects found' };
        }
        const details = projects.map((p) => `  • ${p.nameWithNamespace} (id: ${p.id}) — ${p.webUrl}`).join('\n');
        return {
            success: true,
            summary: `Found ${projects.length} GitLab project(s)`,
            details,
        };
    }
    /** Create a merge request */
    async createMergeRequest(context, description, projectId) {
        // Detect branch name from context or description
        const sourceBranch = this.detectBranch(description) || context.metadata?.gitlabSourceBranch || '';
        const targetBranch = this.detectTargetBranch(description) || context.metadata?.gitlabTargetBranch || 'main';
        if (!sourceBranch) {
            return {
                success: false,
                summary: 'Could not determine source branch',
                error: 'Specify the branch name in the task description (e.g., "Create MR for branch fix/login")',
            };
        }
        // Generate title and description from the goal
        const title = this.generateMRTitle(description, context.goal);
        const desc = this.generateMRDescription(description, context.goal);
        const options = {
            title,
            description: desc,
            sourceBranch,
            targetBranch,
            draft: description.toLowerCase().includes('draft') || description.toLowerCase().includes('wip'),
            removeSourceBranch: description.toLowerCase().includes('delete branch') || description.toLowerCase().includes('remove branch'),
            squash: description.toLowerCase().includes('squash'),
        };
        // Extract labels if mentioned
        const labelMatch = description.match(/labels?\s*[:\s]+([a-zA-Z0-9_,\s-]+)/i);
        if (labelMatch) {
            options.labels = labelMatch[1].split(/[, ]+/).filter(Boolean);
        }
        if (projectId) {
            const mr = await this.client.createMergeRequest(projectId, options);
            return {
                success: true,
                summary: `Created MR #${mr.iid}: ${mr.title}`,
                details: mr.webUrl,
            };
        }
        // No project resolved — try to create via GitLab API using path from git remote
        return {
            success: false,
            summary: 'Could not resolve GitLab project',
            error: 'Ensure the git remote points to GitLab or set gitlabProjectId in context metadata',
        };
    }
    /** List merge requests */
    async listMergeRequests(projectId, description) {
        const state = description.includes('merged') ? 'merged'
            : description.includes('closed') ? 'closed'
                : 'opened';
        if (!projectId) {
            return { success: false, summary: 'No GitLab project resolved', error: 'Set git remote or gitlabProjectId' };
        }
        const mrs = await this.client.listMergeRequests(projectId, { state });
        if (mrs.length === 0) {
            return { success: true, summary: `No ${state} merge requests found` };
        }
        const details = mrs.map((mr) => `  • !${mr.iid} ${mr.title} (${mr.sourceBranch} → ${mr.targetBranch}) — ${mr.state}`).join('\n');
        return {
            success: true,
            summary: `Found ${mrs.length} ${state} merge request(s)`,
            details,
        };
    }
    /** Comment on a merge request */
    async commentOnMR(context, description, projectId) {
        const mrIid = this.extractMRNumber(description);
        if (!projectId || !mrIid) {
            return {
                success: false,
                summary: 'MR ID and project required',
                error: 'Specify the MR number (e.g., "Comment on MR !42: LGTM")',
            };
        }
        // Use context summary as comment if available, otherwise extract from description
        const commentText = this.extractCommentText(description) || 'Reviewed by agent-nuvira.';
        const note = await this.client.createMRNote(projectId, mrIid, commentText);
        return {
            success: true,
            summary: `Commented on MR !${mrIid}`,
            details: `Note #${note.id}: ${commentText.slice(0, 100)}${commentText.length > 100 ? '...' : ''}`,
        };
    }
    /** Merge a merge request */
    async mergeMR(projectId, description) {
        const mrIid = this.extractMRNumber(description);
        if (!projectId || !mrIid) {
            return {
                success: false,
                summary: 'MR ID and project required',
                error: 'Specify the MR number (e.g., "Merge MR !42")',
            };
        }
        const mr = await this.client.mergeMergeRequest(projectId, mrIid, {
            squash: description.toLowerCase().includes('squash'),
            shouldRemoveSourceBranch: description.toLowerCase().includes('delete branch'),
        });
        return {
            success: true,
            summary: `Merged MR !${mrIid}: ${mr.title}`,
            details: mr.webUrl,
        };
    }
    /** Create an issue */
    async createIssue(context, description, projectId) {
        const title = this.generateMRTitle(description, context.goal);
        const desc = this.generateMRDescription(description, context.goal);
        const options = {
            title,
            description: desc,
        };
        const labelMatch = description.match(/labels?\s*[:\s]+([a-zA-Z0-9_,\s-]+)/i);
        if (labelMatch) {
            options.labels = labelMatch[1].split(/[, ]+/).filter(Boolean);
        }
        if (!projectId) {
            return { success: false, summary: 'No GitLab project resolved', error: 'Set git remote or gitlabProjectId' };
        }
        const issue = await this.client.createIssue(projectId, options);
        return {
            success: true,
            summary: `Created issue #${issue.iid}: ${issue.title}`,
            details: issue.webUrl,
        };
    }
    /** List issues */
    async listIssues(projectId, description) {
        const state = description.includes('closed') ? 'closed' : 'opened';
        if (!projectId) {
            return { success: false, summary: 'No GitLab project resolved', error: 'Set git remote or gitlabProjectId' };
        }
        const issues = await this.client.listIssues(projectId, { state });
        if (issues.length === 0) {
            return { success: true, summary: `No ${state} issues found` };
        }
        const details = issues.map((issue) => `  • #${issue.iid} ${issue.title} (${issue.labels.length > 0 ? issue.labels.join(', ') : 'no labels'})`).join('\n');
        return {
            success: true,
            summary: `Found ${issues.length} ${state} issue(s)`,
            details,
        };
    }
    /** Comment on an issue */
    async commentOnIssue(context, description, projectId) {
        const issueIid = this.extractIssueNumber(description);
        if (!projectId || !issueIid) {
            return { success: false, summary: 'Issue ID and project required', error: 'Specify issue number' };
        }
        const commentText = this.extractCommentText(description) || 'Reviewed by agent-nuvira.';
        await this.client.createIssueNote(projectId, issueIid, commentText);
        return {
            success: true,
            summary: `Commented on issue #${issueIid}`,
        };
    }
    /** Check pipeline status */
    async checkPipelineStatus(projectId, _description) {
        if (!projectId) {
            return { success: false, summary: 'No GitLab project resolved', error: 'Set git remote or gitlabProjectId' };
        }
        // Try to get the current branch
        let ref;
        try {
            const { execSync } = await import('node:child_process');
            ref = execSync('git rev-parse --abbrev-ref HEAD', {
                timeout: 10_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
        }
        catch {
            // No branch found
        }
        const pipelines = await this.client.listPipelines(projectId, { ref, perPage: 5 });
        if (pipelines.length === 0) {
            return { success: true, summary: 'No pipelines found for this branch' };
        }
        const latest = pipelines[0];
        const details = pipelines.map((p) => `  • Pipeline #${p.id} — ${p.status} (${p.ref})`).join('\n');
        const statusText = latest.status === 'success' ? 'passing' : latest.status === 'failed' ? 'failing' : latest.status;
        return {
            success: true,
            summary: `Pipeline #${latest.id}: ${statusText}`,
            details,
        };
    }
    // ─── Private Helpers ──────────────────────────────────────────────────
    /** Detect a branch name from the task description */
    detectBranch(description) {
        // Look for branch-like patterns: feat/xxx, fix/xxx, branch: xxx
        const branchPatterns = [
            /(?:branch|from)\s*[:\s]+([a-zA-Z0-9_\/-]+)/i,
            /(?:feat|fix|chore|refactor|docs|style|test|ci|perf)\/[a-zA-Z0-9_-]+/,
        ];
        for (const pattern of branchPatterns) {
            const match = description.match(pattern);
            if (match)
                return match[1] || match[0];
        }
        return undefined;
    }
    /** Detect the target branch from the task description */
    detectTargetBranch(description) {
        const match = description.match(/(?:into|target|to|against)\s*[:\s]+([a-zA-Z0-9_\/-]+)/i);
        return match ? match[1] : 'main';
    }
    /** Generate an MR title from the description and goal */
    generateMRTitle(description, goal) {
        // Try to find a quoted title
        const quoted = description.match(/["'„]([^"'„]+)["'“]/);
        if (quoted)
            return quoted[1].trim();
        // Use a reasonable prefix + goal summary
        const goalSummary = goal.length > 80 ? goal.slice(0, 77) + '...' : goal;
        return goalSummary;
    }
    /** Generate an MR description from the goal */
    generateMRDescription(description, goal) {
        const lines = [];
        lines.push('## Summary');
        lines.push('');
        lines.push(goal);
        lines.push('');
        lines.push('---');
        lines.push('Created by agent-nuvira 🤖');
        return lines.join('\n');
    }
    /** Extract MR number from description: "!42" or "MR 42" or "merge request 42" */
    extractMRNumber(description) {
        const patterns = [
            /!(\d+)/,
            /MR\s*#?(\d+)/i,
            /merge request\s*#?(\d+)/i,
        ];
        for (const pattern of patterns) {
            const match = description.match(pattern);
            if (match)
                return parseInt(match[1], 10);
        }
        return null;
    }
    /** Extract issue number from description: "#42" or "issue 42" */
    extractIssueNumber(description) {
        const patterns = [
            /#(\d+)/,
            /issue\s*#?(\d+)/i,
        ];
        for (const pattern of patterns) {
            const match = description.match(pattern);
            if (match)
                return parseInt(match[1], 10);
        }
        return null;
    }
    /** Extract comment text from description */
    extractCommentText(description) {
        // Look for text after "say", "comment", "message"
        const patterns = [
            /(?:say|comment|message)\s*[:\s]+["'„]([^"'„]+)["'“]/i,
            /(?:say|comment|message)\s*[:\s]+([^"]+)$/i,
        ];
        for (const pattern of patterns) {
            const match = description.match(pattern);
            if (match)
                return match[1].trim();
        }
        return undefined;
    }
}
//# sourceMappingURL=gitlab-agent.js.map