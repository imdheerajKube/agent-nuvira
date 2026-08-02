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
import { execSync } from 'node:child_process';
import { Agent } from '../agent.js';
import { GitLabAPIClient } from './gitlab-api-client.js';
// ─── Classification Labels ──────────────────────────────────────────────────
/** Label suggestions based on classification */
const CLASSIFICATION_LABELS = {
    bug: ['bug', 'needs-triage', 'needs-reproduction'],
    feature: ['enhancement', 'feature-request', 'needs-discussion'],
    question: ['question', 'support', 'needs-clarification'],
    docs: ['documentation', 'docs', 'good-first-issue'],
    chore: ['chore', 'tech-debt', 'refactor'],
};
/** Priority color mapping for comment headers */
const PRIORITY_EMOJI = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
};
/** Priority keywords for LLM context */
const PRIORITY_GUIDELINES = `
Priority Guidelines:
- CRITICAL: Security vulnerabilities, data loss, production outage, broken auth
- HIGH: Major feature broken, regression, blocking work, no workaround
- MEDIUM: Non-critical bug, nice-to-have feature, minor improvement
- LOW: Cosmetic issue, documentation, wishlist, nice-to-have
`;
const CLASSIFICATION_GUIDELINES = `
Classification Guidelines:
- bug: A behavior that is incorrect, unexpected, or broken
- feature: A request for new functionality, capability, or enhancement
- question: A request for information, help, or clarification
- docs: Issues with documentation, comments, or examples
- chore: Maintenance, refactoring, tech debt, dependencies, tooling
`;
const DIFFICULTY_GUIDELINES = `
Difficulty Guidelines:
- easy: Small change, well-understood, limited scope (< 20 lines)
- medium: Moderate change, multiple files, requires some investigation
- hard: Large change, architectural impact, deep domain knowledge needed
`;
const MAX_BODY_CHARS = 2000; // Max chars of issue body to include in LLM prompt
const DEFAULT_MAX_ISSUES = 10; // Max issues to triage per run
// ─── Agent ──────────────────────────────────────────────────────────────────
/**
 * Issue Triage Agent — Fetches open issues and classifies them via LLM.
 */
export class IssueTriageAgent extends Agent {
    name = 'Issue Triage';
    description = 'Classifies, prioritizes, and labels open issues from GitHub and GitLab';
    gitlabClient;
    ghToken;
    glToken;
    constructor(gitlabClient) {
        super();
        this.gitlabClient = gitlabClient ?? new GitLabAPIClient();
        this.ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
        this.glToken = process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || '';
    }
    async execute(context, callLLM) {
        try {
            // Refresh tokens from context metadata
            this.ghToken = context.metadata?.githubToken ||
                context.metadata?.githubApiKey ||
                process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
            this.glToken = context.metadata?.gitlabToken ||
                process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || '';
            const taskDesc = context.taskPlan.find((s) => s.agentType === 'issue-triage' && s.status === 'running')?.description || context.goal;
            const operation = this.detectOperation(taskDesc);
            const source = this.detectSource(taskDesc);
            // Resolve repo info based on the source
            // For 'auto' mode, try both GitHub and GitLab
            let repoInfo = null;
            let gitlabProjectId = null;
            if (source === 'github') {
                repoInfo = await this.resolveGitHubRepo(context, taskDesc);
                if (!repoInfo) {
                    return {
                        success: false,
                        summary: 'Could not resolve GitHub repository',
                        error: 'Specify owner/repo in the goal (e.g., "Triage issues in owner/repo") or ensure git remote points to GitHub',
                    };
                }
            }
            else if (source === 'gitlab') {
                gitlabProjectId = await this.resolveGitLabProject(context, taskDesc);
                if (!gitlabProjectId) {
                    return {
                        success: false,
                        summary: 'Could not resolve GitLab project',
                        error: 'Set GITLAB_TOKEN or ensure git remote points to GitLab',
                    };
                }
            }
            else {
                // Auto mode: try GitHub first, fall back to GitLab
                repoInfo = await this.resolveGitHubRepo(context, taskDesc);
                if (!repoInfo) {
                    gitlabProjectId = await this.resolveGitLabProject(context, taskDesc);
                    if (!gitlabProjectId) {
                        return {
                            success: false,
                            summary: 'Could not resolve any repository',
                            error: 'Ensure git remote points to GitHub or GitLab, or specify owner/repo in the goal',
                        };
                    }
                }
            }
            const maxIssues = context.metadata?.maxIssuesToTriage || DEFAULT_MAX_ISSUES;
            switch (operation) {
                case 'list-unlabeled':
                    return await this.listUnlabeledIssues(source, repoInfo, gitlabProjectId, maxIssues);
                case 'classify': {
                    const issueNumber = this.extractIssueNumber(taskDesc);
                    if (!issueNumber) {
                        return { success: false, summary: 'Issue number required', error: 'Specify #number (e.g., "Classify #42")' };
                    }
                    return await this.triageSingleIssue(source, repoInfo, gitlabProjectId, issueNumber, callLLM);
                }
                case 'triage-specific': {
                    const issueNumber = this.extractIssueNumber(taskDesc);
                    if (!issueNumber) {
                        return { success: false, summary: 'Issue number required', error: 'Specify #number (e.g., "Triage #42")' };
                    }
                    return await this.triageSingleIssue(source, repoInfo, gitlabProjectId, issueNumber, callLLM);
                }
                case 'triage-all':
                default:
                    return await this.triageAllOpenIssues(source, repoInfo, gitlabProjectId, maxIssues, callLLM, context);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'Issue triage failed', error: msg };
        }
    }
    // ─── Operation Detection ──────────────────────────────────────────────────
    detectOperation(description) {
        const lower = description.toLowerCase();
        if ((lower.includes('list') || lower.includes('show') || lower.includes('find')) &&
            (lower.includes('unlabeled') || lower.includes('un-labelled') || lower.includes('no label'))) {
            return 'list-unlabeled';
        }
        if ((lower.includes('classify') || lower.includes('categorize')) &&
            (lower.includes('#') || /\d+/.test(description)) &&
            this.extractIssueNumber(description)) {
            return 'classify';
        }
        if ((lower.includes('triage') || lower.includes('review') || lower.includes('assess') || lower.includes('analyze')) &&
            (lower.includes('#') || /\d+/.test(description)) &&
            this.extractIssueNumber(description)) {
            return 'triage-specific';
        }
        if (lower.includes('triage') || lower.includes('all') || lower.includes('open issues') ||
            lower.includes('unlabeled') || lower.includes('un-triaged')) {
            return 'triage-all';
        }
        return 'triage-all'; // Default: triage all open issues
    }
    // ─── Source Detection ────────────────────────────────────────────────────
    detectSource(description) {
        const lower = description.toLowerCase();
        if (lower.includes('gitlab'))
            return 'gitlab';
        if (lower.includes('github'))
            return 'github';
        // Check tokens to infer source
        if (this.glToken && !this.ghToken)
            return 'gitlab';
        if (this.ghToken && !this.glToken)
            return 'github';
        return 'auto';
    }
    // ─── Repository Resolution ────────────────────────────────────────────────
    async resolveGitHubRepo(context, description) {
        // Check description for explicit owner/repo
        const explicitMatch = description.match(/\b([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\b/);
        if (explicitMatch) {
            return { owner: explicitMatch[1], repo: explicitMatch[2] };
        }
        // Check context metadata
        const metaOwner = context.metadata?.githubOwner;
        const metaRepo = context.metadata?.githubRepo;
        if (metaOwner && metaRepo)
            return { owner: metaOwner, repo: metaRepo };
        // Try git remote
        try {
            const remote = execSync('git remote get-url origin 2>&1', {
                timeout: 10_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
            const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
            if (match)
                return { owner: match[1], repo: match[2] };
        }
        catch {
            // Fall through
        }
        return null;
    }
    async resolveGitLabProject(context, description) {
        // Check description for numeric project ID
        const idMatch = description.match(/project\s*[#:]\s*(\d+)/i);
        if (idMatch)
            return parseInt(idMatch[1], 10);
        // Check context metadata
        const metaId = context.metadata?.gitlabProjectId;
        if (typeof metaId === 'number')
            return metaId;
        if (typeof metaId === 'string' && /^\d+$/.test(metaId))
            return Number(metaId);
        const metaPath = context.metadata?.gitlabProjectPath;
        if (metaPath) {
            try {
                return (await this.gitlabClient.getProject(metaPath)).id;
            }
            catch { /* fall through */ }
        }
        // Try git remote
        try {
            const remote = execSync('git remote get-url origin 2>&1', {
                timeout: 10_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
            const match = remote.match(/gitlab\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
            if (match) {
                try {
                    return (await this.gitlabClient.getProject(match[1])).id;
                }
                catch { /* fall through */ }
            }
        }
        catch {
            // Fall through
        }
        return null;
    }
    // ─── GitHub API Helpers ──────────────────────────────────────────────────
    get ghHeaders() {
        const h = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'agent-nuvira/1.0',
        };
        if (this.ghToken)
            h['Authorization'] = `Bearer ${this.ghToken}`;
        return h;
    }
    async githubGet(path) {
        const response = await fetch(`https://api.github.com${path}`, {
            method: 'GET',
            headers: this.ghHeaders,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            if (response.status === 401)
                throw new Error('GitHub authentication failed. Set GH_TOKEN or GITHUB_TOKEN.');
            if (response.status === 403)
                throw new Error('GitHub API rate limit exceeded or access denied.');
            if (response.status === 404)
                throw new Error('GitHub resource not found.');
            throw new Error(`GitHub API error ${response.status}: ${body.slice(0, 200)}`);
        }
        return response.json();
    }
    async githubPatch(path, body) {
        const response = await fetch(`https://api.github.com${path}`, {
            method: 'PATCH',
            headers: this.ghHeaders,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.json();
    }
    async githubPost(path, body) {
        const response = await fetch(`https://api.github.com${path}`, {
            method: 'POST',
            headers: this.ghHeaders,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.json();
    }
    // ─── Fetch Issues ─────────────────────────────────────────────────────────
    /** Fetch open issues from GitHub */
    async fetchGitHubIssues(repo, maxIssues, unlabeledOnly) {
        const params = new URLSearchParams({
            state: 'open',
            per_page: String(maxIssues),
            sort: 'created',
            direction: 'desc',
        });
        const raw = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/issues?${params}`);
        // Filter out pull requests (GitHub API returns PRs as issues)
        const issues = raw.filter((i) => !i.pull_request);
        return issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: (i.body || '').slice(0, MAX_BODY_CHARS),
            author: i.user?.login || 'unknown',
            labels: i.labels?.map((l) => l.name) || [],
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            url: i.html_url,
            comments: i.comments || 0,
        }));
    }
    /** Fetch open issues from GitLab */
    async fetchGitLabIssues(projectId, maxIssues, unlabeledOnly) {
        const issues = await this.gitlabClient.listIssues(projectId, {
            state: 'opened',
            perPage: maxIssues,
        });
        return issues.map((i) => ({
            number: i.iid,
            title: i.title,
            body: (i.description || '').slice(0, MAX_BODY_CHARS),
            author: i.author?.username || 'unknown',
            labels: i.labels || [],
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
            url: i.webUrl,
            comments: 0,
        }));
    }
    /** Fetch issues from the appropriate source */
    async fetchIssues(source, repoInfo, gitlabProjectId, maxIssues, unlabeledOnly) {
        if (source === 'github' && repoInfo) {
            const all = await this.fetchGitHubIssues(repoInfo, maxIssues, unlabeledOnly);
            return unlabeledOnly ? all.filter((i) => i.labels.length === 0) : all;
        }
        if (source === 'gitlab' && gitlabProjectId) {
            const all = await this.fetchGitLabIssues(gitlabProjectId, maxIssues, unlabeledOnly);
            return unlabeledOnly ? all.filter((i) => i.labels.length === 0) : all;
        }
        // Auto-detect: try GitHub first, then GitLab
        if (source === 'auto') {
            if (repoInfo) {
                const all = await this.fetchGitHubIssues(repoInfo, maxIssues, unlabeledOnly);
                return unlabeledOnly ? all.filter((i) => i.labels.length === 0) : all;
            }
            if (gitlabProjectId) {
                const all = await this.fetchGitLabIssues(gitlabProjectId, maxIssues, unlabeledOnly);
                return unlabeledOnly ? all.filter((i) => i.labels.length === 0) : all;
            }
        }
        return [];
    }
    // ─── GitHub Label Helpers ────────────────────────────────────────────────
    /** Ensure labels exist on a GitHub repo (create if missing) */
    async ensureGitHubLabels(repo, labels) {
        for (const label of labels) {
            try {
                await this.githubGet(`/repos/${repo.owner}/${repo.repo}/labels/${encodeURIComponent(label)}`);
            }
            catch {
                // Label doesn't exist — create it
                try {
                    const color = this.getLabelColor(label);
                    await this.githubPost(`/repos/${repo.owner}/${repo.repo}/labels`, {
                        name: label,
                        color,
                        description: `Auto-managed by agent-nuvira issue triage`,
                    });
                }
                catch {
                    // Best-effort label creation
                }
            }
        }
    }
    /** Get a hex color for a label based on its name */
    getLabelColor(label) {
        const colorMap = {
            bug: 'd73a4a', // Red
            critical: 'b60205', // Dark red
            high: 'e99695', // Light red
            medium: 'f9d0c4', // Peach
            low: 'c2e0c6', // Light green
            'needs-triage': 'fbca04', // Yellow
            'needs-reproduction': 'fbca04',
            'needs-discussion': 'fbca04',
            'needs-clarification': 'fbca04',
            enhancement: 'a2eeef', // Teal
            'feature-request': 'a2eeef',
            question: 'd876e3', // Purple
            support: 'd876e3',
            documentation: '0075ca', // Blue
            docs: '0075ca',
            chore: 'bfdadc', // Gray-blue
            'tech-debt': 'bfdadc',
            refactor: 'bfdadc',
            'good-first-issue': '7057ff', // Indigo
        };
        return colorMap[label.toLowerCase()] || 'c5def5'; // Default light blue
    }
    // ─── Git Blame Expertise Heuristic ───────────────────────────────────────
    /** Use git blame to determine who has the most expertise in files mentioned in the issue */
    async inferAssigneeFromGitBlame(issueBody) {
        try {
            // Extract file paths from the issue body
            const filePatterns = [
                /`([a-zA-Z0-9_/.-]+\.[a-zA-Z]+)`/g, // `src/app.ts`
                /(?:in|file|at)\s+`([^`]+)`/gi, // in `file.ts`
                /(?:file|path):\s*([^\s,;]+)/gi, // file: src/app.ts
            ];
            const mentionedFiles = [];
            for (const pattern of filePatterns) {
                let match;
                while ((match = pattern.exec(issueBody)) !== null) {
                    const filePath = match[1].replace(/['"`]/g, '').trim();
                    if (filePath && !mentionedFiles.includes(filePath)) {
                        mentionedFiles.push(filePath);
                    }
                }
            }
            if (mentionedFiles.length === 0)
                return undefined;
            // Run git blame on the first mentioned file that exists
            for (const file of mentionedFiles.slice(0, 3)) {
                try {
                    const blameOutput = execSync(`git blame --line-porcelain "${file}" 2>/dev/null | grep "^author " | sort | uniq -c | sort -rn | head -3`, {
                        timeout: 10_000,
                        encoding: 'utf-8',
                        stdio: 'pipe',
                    });
                    const lines = blameOutput.trim().split('\n').filter(Boolean);
                    if (lines.length > 0) {
                        // Extract the author name from the first line: "42 author Name"
                        const topAuthor = lines[0].replace(/^\s*\d+\s+author\s+/, '').trim();
                        if (topAuthor)
                            return topAuthor;
                    }
                }
                catch {
                    continue; // Try next file
                }
            }
        }
        catch {
            // Git blame failed
        }
        return undefined;
    }
    // ─── LLM Classification ──────────────────────────────────────────────────
    /** Build a prompt for the LLM to classify a single issue */
    buildClassificationPrompt(issue) {
        return [
            `You are an expert issue triager for a software project. Analyze the following issue and respond with a valid JSON object.`,
            ``,
            CLASSIFICATION_GUIDELINES,
            PRIORITY_GUIDELINES,
            DIFFICULTY_GUIDELINES,
            ``,
            `## Issue #${issue.number}: ${issue.title}`,
            ``,
            `**Author:** ${issue.author}`,
            `**Labels:** ${issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`,
            `**Created:** ${issue.createdAt}`,
            `**Comments:** ${issue.comments}`,
            ``,
            issue.body ? `**Description:**\n${issue.body.slice(0, MAX_BODY_CHARS)}\n` : '**Description:** (no description)',
            ``,
            `Respond with ONLY a valid JSON object (no markdown, no code blocks):`,
            `{`,
            `  "classification": "bug" | "feature" | "question" | "docs" | "chore",`,
            `  "priority": "critical" | "high" | "medium" | "low",`,
            `  "suggestedLabels": ["label1", "label2", ...],`,
            `  "estimatedDifficulty": "easy" | "medium" | "hard",`,
            `  "reasoning": "Brief 1-2 sentence explanation",`,
            `  "suggestedAction": "What should be done to address this issue"`,
            `}`,
        ].join('\n');
    }
    /** Parse the LLM classification response into a TriageResult */
    parseClassificationResponse(response) {
        // Strip markdown code block markers if present
        let cleaned = response.trim();
        const jsonMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (jsonMatch) {
            cleaned = jsonMatch[1].trim();
        }
        // Find JSON object boundaries
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) {
            return {
                classification: 'question',
                priority: 'medium',
                suggestedLabels: ['needs-triage'],
                estimatedDifficulty: 'medium',
                reasoning: 'Could not parse LLM response',
                suggestedAction: 'Manual review required',
            };
        }
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            return {
                classification: this.validateClassification(parsed.classification) ? parsed.classification : 'question',
                priority: this.validatePriority(parsed.priority) ? parsed.priority : 'medium',
                suggestedLabels: Array.isArray(parsed.suggestedLabels) ? parsed.suggestedLabels : ['needs-triage'],
                estimatedDifficulty: this.validateDifficulty(parsed.estimatedDifficulty) ? parsed.estimatedDifficulty : 'medium',
                reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : 'No reasoning provided',
                suggestedAction: typeof parsed.suggestedAction === 'string' ? parsed.suggestedAction.slice(0, 500) : 'Review and triage',
            };
        }
        catch {
            return {
                classification: 'question',
                priority: 'medium',
                suggestedLabels: ['needs-triage'],
                estimatedDifficulty: 'medium',
                reasoning: 'Failed to parse LLM response as JSON',
                suggestedAction: 'Manual review required',
            };
        }
    }
    validateClassification(c) {
        return typeof c === 'string' && ['bug', 'feature', 'question', 'docs', 'chore'].includes(c);
    }
    validatePriority(p) {
        return typeof p === 'string' && ['critical', 'high', 'medium', 'low'].includes(p);
    }
    validateDifficulty(d) {
        return typeof d === 'string' && ['easy', 'medium', 'hard'].includes(d);
    }
    // ─── Operations ──────────────────────────────────────────────────────────
    /** List unlabeled open issues */
    async listUnlabeledIssues(source, repoInfo, gitlabProjectId, maxIssues) {
        const issues = await this.fetchIssues(source, repoInfo, gitlabProjectId, maxIssues, true);
        if (issues.length === 0) {
            return { success: true, summary: 'No unlabeled issues found' };
        }
        const details = issues.map((i) => `  • #${i.number} ${i.title} (by ${i.author})`).join('\n');
        return {
            success: true,
            summary: `Found ${issues.length} unlabeled issue(s)`,
            details,
        };
    }
    /** Triage a single issue by number */
    async triageSingleIssue(source, repoInfo, gitlabProjectId, issueNumber, callLLM) {
        // Fetch the specific issue
        let issue = null;
        if (source === 'github' && repoInfo) {
            const all = await this.fetchGitHubIssues(repoInfo, 50, false);
            issue = all.find((i) => i.number === issueNumber) || null;
        }
        else if (source === 'gitlab' && gitlabProjectId) {
            const all = await this.fetchGitLabIssues(gitlabProjectId, 50, false);
            issue = all.find((i) => i.number === issueNumber) || null;
        }
        else if (source === 'auto') {
            if (repoInfo) {
                const all = await this.fetchGitHubIssues(repoInfo, 50, false);
                issue = all.find((i) => i.number === issueNumber) || null;
            }
            if (!issue && gitlabProjectId) {
                const all = await this.fetchGitLabIssues(gitlabProjectId, 50, false);
                issue = all.find((i) => i.number === issueNumber) || null;
            }
        }
        if (!issue) {
            return {
                success: false,
                summary: `Issue #${issueNumber} not found`,
                error: `Issue #${issueNumber} was not found in the repository`,
            };
        }
        // Classify via LLM
        const prompt = this.buildClassificationPrompt(issue);
        const llmResponse = await callLLM(prompt, { temperature: 0.2, maxTokens: 600 });
        const classification = this.parseClassificationResponse(llmResponse);
        // Try to infer assignee from git blame
        let suggestedAssignee;
        if (issue.body) {
            suggestedAssignee = await this.inferAssigneeFromGitBlame(issue.body);
        }
        const result = {
            issueNumber: issue.number,
            title: issue.title,
            classification: classification.classification || 'question',
            priority: classification.priority || 'medium',
            suggestedLabels: classification.suggestedLabels || ['needs-triage'],
            suggestedAssignee,
            estimatedDifficulty: classification.estimatedDifficulty || 'medium',
            suggestedAction: classification.suggestedAction || '',
            reasoning: classification.reasoning || '',
        };
        // Apply labels (GitHub only — GitLab labels are project-managed)
        if (source === 'github' && repoInfo) {
            try {
                // Ensure labels exist on the repo
                await this.ensureGitHubLabels(repoInfo, result.suggestedLabels);
                // Add labels to the issue
                await this.githubPost(`/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${issue.number}/labels`, { labels: result.suggestedLabels });
            }
            catch {
                // Best-effort label application
            }
        }
        // Post a triage comment
        const triageComment = this.buildTriageComment(result);
        if (source === 'github' && repoInfo) {
            try {
                await this.githubPost(`/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${issue.number}/comments`, { body: triageComment });
            }
            catch {
                // Best-effort comment
            }
        }
        else if (source === 'gitlab' && gitlabProjectId) {
            try {
                await this.gitlabClient.createIssueNote(gitlabProjectId, issue.number, triageComment);
            }
            catch {
                // Best-effort comment
            }
        }
        const details = [
            `##${result.issueNumber}: ${result.title}`,
            `Classification: ${result.classification}`,
            `Priority: ${PRIORITY_EMOJI[result.priority]} ${result.priority}`,
            `Difficulty: ${result.estimatedDifficulty}`,
            `Labels: ${result.suggestedLabels.join(', ')}`,
            result.suggestedAssignee ? `Suggested Assignee: ${result.suggestedAssignee}` : '',
            `Reasoning: ${result.reasoning}`,
        ].filter(Boolean).join('\n');
        return {
            success: true,
            summary: `Triaged #${issue.number}: ${result.classification} (${result.priority})`,
            details,
        };
    }
    /** Triage all unlabeled open issues */
    async triageAllOpenIssues(source, repoInfo, gitlabProjectId, maxIssues, callLLM, context) {
        const issues = await this.fetchIssues(source, repoInfo, gitlabProjectId, maxIssues, true);
        if (issues.length === 0) {
            return { success: true, summary: 'No unlabeled issues to triage' };
        }
        const triaged = [];
        let successCount = 0;
        let failCount = 0;
        for (const issue of issues) {
            try {
                const prompt = this.buildClassificationPrompt(issue);
                const llmResponse = await callLLM(prompt, { temperature: 0.2, maxTokens: 600 });
                const classification = this.parseClassificationResponse(llmResponse);
                let suggestedAssignee;
                if (issue.body) {
                    suggestedAssignee = await this.inferAssigneeFromGitBlame(issue.body);
                }
                const result = {
                    issueNumber: issue.number,
                    title: issue.title,
                    classification: classification.classification || 'question',
                    priority: classification.priority || 'medium',
                    suggestedLabels: classification.suggestedLabels || ['needs-triage'],
                    suggestedAssignee,
                    estimatedDifficulty: classification.estimatedDifficulty || 'medium',
                    suggestedAction: classification.suggestedAction || '',
                    reasoning: classification.reasoning || '',
                };
                triaged.push(result);
                // Apply labels (GitHub only)
                if (source === 'github' && repoInfo) {
                    try {
                        await this.ensureGitHubLabels(repoInfo, result.suggestedLabels);
                        await this.githubPost(`/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${issue.number}/labels`, { labels: result.suggestedLabels });
                    }
                    catch {
                        // Best-effort
                    }
                }
                // Post triage comment
                const triageComment = this.buildTriageComment(result);
                if (source === 'github' && repoInfo) {
                    try {
                        await this.githubPost(`/repos/${repoInfo.owner}/${repoInfo.repo}/issues/${issue.number}/comments`, { body: triageComment });
                    }
                    catch {
                        // Best-effort
                    }
                }
                else if (source === 'gitlab' && gitlabProjectId) {
                    try {
                        await this.gitlabClient.createIssueNote(gitlabProjectId, issue.number, triageComment);
                    }
                    catch {
                        // Best-effort
                    }
                }
                successCount++;
            }
            catch (err) {
                failCount++;
                triaged.push({
                    issueNumber: issue.number,
                    title: issue.title,
                    classification: 'question',
                    priority: 'medium',
                    suggestedLabels: ['needs-triage'],
                    estimatedDifficulty: 'medium',
                    suggestedAction: 'LLM classification failed',
                    reasoning: err instanceof Error ? err.message.slice(0, 100) : 'Unknown error',
                });
            }
        }
        // Build summary
        const byClassification = this.groupByClassification(triaged);
        const byPriority = this.groupByPriority(triaged);
        const byDifficulty = this.groupByDifficulty(triaged);
        const details = [
            `## Triage Results (${triaged.length} issues)`,
            ``,
            `**By Classification:**`,
            ...Object.entries(byClassification).map(([k, v]) => `  • ${k}: ${v}`),
            ``,
            `**By Priority:**`,
            ...Object.entries(byPriority).map(([k, v]) => `  • ${k}: ${v}`),
            ``,
            `**By Difficulty:**`,
            ...Object.entries(byDifficulty).map(([k, v]) => `  • ${k}: ${v}`),
            ``,
            `**Breakdown:**`,
            ...triaged.map((t) => `  • #${t.issueNumber}: ${t.classification} (${PRIORITY_EMOJI[t.priority]} ${t.priority}, ${t.estimatedDifficulty})`),
            ``,
            `Successfully triaged: ${successCount}`,
            failCount > 0 ? `Failed: ${failCount}` : '',
        ].filter(Boolean).join('\n');
        return {
            success: failCount === 0,
            summary: `Triaged ${triaged.length} issue(s): ${successCount} succeeded, ${failCount} failed`,
            details,
        };
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────
    /** Extract an issue number from a description */
    extractIssueNumber(description) {
        const patterns = [
            /#(\d+)/,
            /issue\s*#?(\d+)/i,
        ];
        for (const p of patterns) {
            const match = description.match(p);
            if (match)
                return parseInt(match[1], 10);
        }
        return null;
    }
    /** Build a triage comment for an issue */
    buildTriageComment(result) {
        const lines = [
            `## 🤖 Agent-Nuvira Triage`,
            ``,
            `| Field | Value |`,
            `|-------|-------|`,
            `| **Classification** | ${result.classification} |`,
            `| **Priority** | ${PRIORITY_EMOJI[result.priority]} ${result.priority} |`,
            `| **Difficulty** | ${result.estimatedDifficulty} |`,
            `| **Suggested Labels** | ${result.suggestedLabels.join(', ')} |`,
            result.suggestedAssignee ? `| **Suggested Assignee** | ${result.suggestedAssignee} |` : '',
            ``,
            `### Reasoning`,
            result.reasoning,
            ``,
            result.suggestedAction ? `### Suggested Action\n${result.suggestedAction}\n` : '',
            `---`,
            `*Triaged by agent-nuvira issue-triage agent*`,
        ];
        return lines.filter(Boolean).join('\n');
    }
    /** Group triage results by classification */
    groupByClassification(results) {
        const groups = {};
        for (const r of results) {
            groups[r.classification] = (groups[r.classification] || 0) + 1;
        }
        return groups;
    }
    /** Group triage results by priority */
    groupByPriority(results) {
        const groups = {};
        for (const r of results) {
            groups[r.priority] = (groups[r.priority] || 0) + 1;
        }
        return groups;
    }
    /** Group triage results by difficulty */
    groupByDifficulty(results) {
        const groups = {};
        for (const r of results) {
            groups[r.estimatedDifficulty] = (groups[r.estimatedDifficulty] || 0) + 1;
        }
        return groups;
    }
}
//# sourceMappingURL=issue-triage-agent.js.map