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
import { execSync } from 'node:child_process';
import { Agent } from '../agent.js';
import { DefaultVerifyModule } from '../verify-module.js';
// ─── Agent ──────────────────────────────────────────────────────────────────
const MAX_PATCH_CHARS = 10_000; // Max chars of patch to include in security scan
/**
 * PR Review Agent — Reviews open pull requests for security, quality, and correctness.
 */
export class PRReviewAgent extends Agent {
    name = 'PR Review';
    description = 'Reviews open pull requests for security issues, code quality, and correctness';
    verifyModule;
    token;
    constructor(verifyModule) {
        super();
        this.verifyModule = verifyModule ?? new DefaultVerifyModule();
        this.token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
    }
    async execute(context, callLLM) {
        try {
            // Refresh token from context metadata (which may have a repo-specific token)
            this.token = this.resolveToken(context);
            const taskDesc = context.taskPlan.find((s) => s.agentType === 'pr-review' && s.status === 'running')?.description || context.goal;
            // Resolve repo info
            const repoInfo = await this.resolveRepoInfo(context);
            if (!repoInfo) {
                return {
                    success: false,
                    summary: 'Could not resolve GitHub repository',
                    error: 'Set a GitHub remote or provide owner/repo in the goal description (e.g., "Review PRs in owner/repo")',
                };
            }
            const operation = this.detectOperation(taskDesc);
            switch (operation) {
                case 'list':
                    return await this.listOpenPRs(repoInfo);
                case 'review-specific': {
                    const prNumber = this.extractPRNumber(taskDesc);
                    if (!prNumber) {
                        return { success: false, summary: 'PR number required', error: 'Specify the PR number (e.g., "Review PR #42")' };
                    }
                    return await this.reviewSinglePR(repoInfo, prNumber, callLLM);
                }
                case 'review':
                    return await this.reviewAllOpenPRs(repoInfo, callLLM, context);
                case 'summarize': {
                    const prNumber = this.extractPRNumber(taskDesc);
                    if (!prNumber) {
                        return { success: false, summary: 'PR number required', error: 'Specify the PR number' };
                    }
                    return await this.summarizePR(repoInfo, prNumber, callLLM);
                }
                default:
                    return await this.reviewAllOpenPRs(repoInfo, callLLM, context);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'PR review failed', error: msg };
        }
    }
    // ─── Operation Detection ──────────────────────────────────────────────────
    detectOperation(description) {
        const lower = description.toLowerCase();
        if (lower.includes('list') || lower.includes('show open') || lower.includes('display'))
            return 'list';
        if ((lower.includes('review') || lower.includes('check') || lower.includes('inspect') || lower.includes('audit')) &&
            (lower.includes('#') || lower.includes('pr') || /\d+/.test(description))) {
            // Has a specific PR number (e.g., "Review PR #42")
            return this.extractPRNumber(description) ? 'review-specific' : 'review';
        }
        if (lower.includes('summarize') || lower.includes('summary') || lower.includes('describe'))
            return 'summarize';
        if (lower.includes('review') || lower.includes('all') || lower.includes('open'))
            return 'review';
        return 'review'; // Default: review all open PRs
    }
    // ─── Repo Resolution ──────────────────────────────────────────────────────
    async resolveRepoInfo(context) {
        // Check task description for explicit owner/repo
        const desc = context.goal;
        const explicitMatch = desc.match(/\b([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\b/);
        if (explicitMatch) {
            return { owner: explicitMatch[1], repo: explicitMatch[2] };
        }
        // Check context metadata
        const metaOwner = context.metadata?.githubOwner;
        const metaRepo = context.metadata?.githubRepo;
        if (metaOwner && metaRepo) {
            return { owner: metaOwner, repo: metaRepo };
        }
        // Try git remote
        try {
            const remote = execSync('git remote get-url origin 2>&1', {
                timeout: 10_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
            const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
            if (match) {
                return { owner: match[1], repo: match[2] };
            }
        }
        catch {
            // Fall through
        }
        return null;
    }
    // ─── Token Resolution ───────────────────────────────────────────────────
    resolveToken(context) {
        return context.metadata?.githubApiKey ||
            this.token ||
            '';
    }
    // ─── GitHub API Helpers ─────────────────────────────────────────────────
    get headers() {
        const h = {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'agent-nuvira/1.0',
        };
        if (this.token) {
            h['Authorization'] = `Bearer ${this.token}`;
        }
        return h;
    }
    async githubGet(path) {
        const response = await fetch(`https://api.github.com${path}`, {
            method: 'GET',
            headers: this.headers,
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
    async githubPost(path, body) {
        const response = await fetch(`https://api.github.com${path}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.json();
    }
    // ─── Operations ─────────────────────────────────────────────────────────
    /** List open PRs for the repository */
    async listOpenPRs(repo) {
        const prs = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=20`);
        if (prs.length === 0) {
            return { success: true, summary: 'No open pull requests found' };
        }
        const details = prs.map((pr) => {
            const draft = pr.draft ? ' [DRAFT]' : '';
            const labelStr = pr.labels.length > 0 ? ` (${pr.labels.map((l) => l.name).join(', ')})` : '';
            return `  • #${pr.number}${draft} ${pr.title}${labelStr}`;
        }).join('\n');
        return {
            success: true,
            summary: `Found ${prs.length} open PR(s) in ${repo.owner}/${repo.repo}`,
            details,
        };
    }
    /** Review a single PR by number */
    async reviewSinglePR(repo, prNumber, callLLM) {
        const result = await this.reviewPR(repo, prNumber, callLLM);
        if (result.commentsPosted > 0) {
            return {
                success: result.passed,
                summary: `Reviewed PR #${result.prNumber}: ${result.summary} (${result.commentsPosted} comment(s) posted)`,
                details: [
                    `PR: ${result.prTitle}`,
                    `Status: ${result.passed ? '✅ Passed' : '❌ Failed'}`,
                    `Blockers: ${result.blockerCount}`,
                    `Suggestions: ${result.suggestionCount}`,
                    `Comments posted: ${result.commentsPosted}`,
                ].join('\n'),
            };
        }
        return {
            success: result.passed,
            summary: `Reviewed PR #${result.prNumber}: ${result.summary} (no comments needed)`,
            details: `All checks passed for PR #${result.prNumber}: ${result.prTitle}`,
        };
    }
    /** Review all open PRs */
    async reviewAllOpenPRs(repo, callLLM, context) {
        const prs = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=10`);
        if (prs.length === 0) {
            return { success: true, summary: 'No open pull requests to review' };
        }
        // Respect the PR review limit from context metadata (default: 5)
        const maxPRs = context.metadata?.maxPRsToReview || 5;
        const toReview = prs.slice(0, maxPRs);
        const results = [];
        let totalComments = 0;
        let totalBlockers = 0;
        for (const pr of toReview) {
            try {
                const result = await this.reviewPR(repo, pr.number, callLLM);
                results.push(result);
                totalComments += result.commentsPosted;
                totalBlockers += result.blockerCount;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({
                    prNumber: pr.number,
                    prTitle: pr.title,
                    passed: false,
                    blockerCount: 1,
                    suggestionCount: 0,
                    commentsPosted: 0,
                    summary: `Review failed: ${msg.slice(0, 100)}`,
                });
            }
        }
        const passedCount = results.filter((r) => r.passed).length;
        const details = results.map((r) => `  #${r.prNumber}: ${r.passed ? '✅' : '❌'} ${r.summary.slice(0, 100)} (${r.commentsPosted} comments)`).join('\n');
        return {
            success: passedCount === results.length,
            summary: `Reviewed ${results.length} PR(s): ${passedCount} passed, ${results.length - passedCount} need attention`,
            details: `Total comments posted: ${totalComments}\nTotal blockers: ${totalBlockers}\n\n${details}`,
        };
    }
    /** Summarize a specific PR */
    async summarizePR(repo, prNumber, callLLM) {
        const pr = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`);
        const files = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/files`);
        const prompt = [
            `Summarize the following pull request in 3-4 bullet points:`,
            ``,
            `## PR #${pr.number}: ${pr.title}`,
            ``,
            pr.body ? `## Description\n${pr.body.slice(0, 1000)}` : '',
            ``,
            `## Files Changed (${files.length} files)`,
            ...files.map((f) => `  ${f.status === 'added' ? '+' : f.status === 'removed' ? '-' : '~'} ${f.filename} (+${f.additions}/-${f.deletions})`),
            ``,
            `## Summary Points`,
            `- What does this PR do?`,
            `- What files were affected?`,
            `- Are there any potential issues?`,
            `- What should reviewers focus on?`,
        ].filter(Boolean).join('\n');
        const summary = await callLLM(prompt, { temperature: 0.3, maxTokens: 500 });
        return {
            success: true,
            summary: `Generated summary for PR #${prNumber}`,
            details: summary,
        };
    }
    // ─── Core Review Logic ──────────────────────────────────────────────────
    /**
     * Review a single PR:
     * 1. Fetch the PR details
     * 2. Fetch the changed files with patches
     * 3. Run VerifyModule security scan on each file
     * 4. Post inline comments on issues found
     * 5. Post a summary comment
     */
    async reviewPR(repo, prNumber, callLLM) {
        // Fetch PR details
        const pr = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`);
        // Fetch changed files with patches
        const files = await this.githubGet(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/files?per_page=100`);
        const comments = [];
        const fileChanges = [];
        const fileSummaries = [];
        for (const file of files) {
            if (file.status === 'removed')
                continue; // Skip deleted files
            // Build FileChange for VerifyModule
            const change = {
                path: file.filename,
                status: file.status === 'added' ? 'created' : 'modified',
                newContent: file.patch || '',
            };
            fileChanges.push(change);
            // Track file summary
            fileSummaries.push(`${file.filename} (+${file.additions}/-${file.deletions})`);
            // Scan the patch content for security issues
            if (file.patch) {
                const patchForScan = file.patch.slice(0, MAX_PATCH_CHARS);
                change.newContent = patchForScan;
                // Run VerifyModule on just this file
                try {
                    const verifyResult = await this.verifyModule.verify({
                        changes: [change],
                        goal: `Review PR #${prNumber}: ${pr.title}`,
                        strictness: 'medium',
                        callLLM,
                    });
                    // Generate inline comments for blocking issues
                    for (const blocker of verifyResult.blockers) {
                        const lineNumber = this.extractLineFromPatch(file.patch, blocker);
                        if (lineNumber) {
                            comments.push({
                                path: file.filename,
                                line: lineNumber,
                                body: `🔴 **Blocking:** ${blocker.slice(0, 200)}`,
                            });
                        }
                    }
                    // Generate inline comments for suggestions (on the changed lines)
                    for (const suggestion of verifyResult.suggestions) {
                        const lineNumber = this.extractLineFromPatch(file.patch, suggestion);
                        if (lineNumber) {
                            comments.push({
                                path: file.filename,
                                line: lineNumber,
                                body: `💡 **Suggestion:** ${suggestion.slice(0, 200)}`,
                            });
                        }
                    }
                }
                catch {
                    // Individual file scan failed — skip and continue
                }
            }
        }
        // Run full VerifyModule on all files combined (for overall result)
        const fullVerifyResult = await this.verifyModule.verify({
            changes: fileChanges,
            goal: `Review PR #${prNumber}: ${pr.title}`,
            strictness: 'medium',
            callLLM,
        });
        // Post inline comments (batch of 25 per API call to avoid rate limiting)
        const commentBatches = [];
        for (let i = 0; i < comments.length; i += 25) {
            commentBatches.push(comments.slice(i, i + 25));
        }
        let commentsPosted = 0;
        for (const batch of commentBatches) {
            try {
                await this.githubPost(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`, {
                    commit_id: pr.head.sha,
                    body: `## Agent-Nuvira Review\n\nAutomated code review by agent-nuvira.`,
                    event: fullVerifyResult.passed ? 'APPROVE' : 'COMMENT',
                    comments: batch,
                });
                commentsPosted += batch.length;
            }
            catch {
                // If batch posting fails, try posting comments individually
                for (const comment of batch) {
                    try {
                        await this.githubPost(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments`, {
                            body: comment.body,
                            path: comment.path,
                            line: comment.line,
                        });
                        commentsPosted++;
                    }
                    catch {
                        // Individual comment failed — skip
                    }
                }
            }
        }
        // Post summary comment if we found issues
        if (fullVerifyResult.blockers.length > 0 || fullVerifyResult.suggestions.length > 0) {
            const summaryBody = [
                `## 🤖 Agent-Nuvira Review Summary`,
                ``,
                `**Overall: ${fullVerifyResult.passed ? '✅ Looks good!' : '❌ Issues found'}`,
                `**Score: ${Math.round(fullVerifyResult.overallScore * 100)}%**`,
                ``,
                fullVerifyResult.blockers.length > 0 ? [
                    `### 🔴 Blockers (${fullVerifyResult.blockers.length})`,
                    ...fullVerifyResult.blockers.map((b) => `- ${b}`),
                    '',
                ].join('\n') : '',
                fullVerifyResult.suggestions.length > 0 ? [
                    `### 💡 Suggestions (${fullVerifyResult.suggestions.length})`,
                    ...fullVerifyResult.suggestions.map((s) => `- ${s}`),
                    '',
                ].join('\n') : '',
                `### Files Changed (${files.length})`,
                ...fileSummaries.map((s) => `- \`${s}\``),
                ``,
                `---`,
                `*Reviewed by agent-nuvira*`,
            ].filter(Boolean).join('\n');
            try {
                await this.githubPost(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/comments`, {
                    body: summaryBody,
                    path: files[0]?.filename || '',
                    line: 1,
                });
                commentsPosted++;
            }
            catch {
                // Summary comment is best-effort
            }
        }
        return {
            prNumber,
            prTitle: pr.title,
            passed: fullVerifyResult.passed,
            blockerCount: fullVerifyResult.blockers.length,
            suggestionCount: fullVerifyResult.suggestions.length,
            commentsPosted,
            summary: fullVerifyResult.passed
                ? `All checks passed (score: ${Math.round(fullVerifyResult.overallScore * 100)}%)`
                : `${fullVerifyResult.blockers.length} blocker(s), ${fullVerifyResult.suggestions.length} suggestion(s)`,
        };
    }
    // ─── Helpers ────────────────────────────────────────────────────────────
    /** Extract a PR number from a description */
    extractPRNumber(description) {
        const patterns = [
            /#(\d+)/,
            /PR\s*#?(\d+)/i,
            /pull\s*request\s*#?(\d+)/i,
        ];
        for (const p of patterns) {
            const match = description.match(p);
            if (match)
                return parseInt(match[1], 10);
        }
        return null;
    }
    /**
     * Extract a relevant line number from a unified diff patch.
     * Heuristic: find the first occurrence of the issue text in the patch
     * and map it back to the new file line number.
     */
    extractLineFromPatch(patch, issueText) {
        const lines = patch.split('\n');
        let currentNewLine = 0;
        let inHunk = false;
        for (const line of lines) {
            // Parse hunk header: @@ -old,count +new,count @@
            const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                currentNewLine = parseInt(hunkMatch[1], 10);
                inHunk = true;
                continue;
            }
            if (!inHunk)
                continue;
            // Context line (starts with space)
            if (line.startsWith(' ')) {
                currentNewLine++;
                continue;
            }
            // Added line (starts with +)
            if (line.startsWith('+')) {
                // Check if this line relates to the issue text
                const content = line.slice(1).trim();
                const issueKeywords = issueText.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
                const matchCount = issueKeywords.filter((kw) => content.toLowerCase().includes(kw)).length;
                if (matchCount >= Math.ceil(issueKeywords.length * 0.3)) {
                    return currentNewLine;
                }
                currentNewLine++;
                continue;
            }
            // Removed lines don't increment the new line counter
        }
        // Fallback: return the first added line
        for (const line of lines) {
            const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch)
                return parseInt(hunkMatch[1], 10);
        }
        return null;
    }
}
//# sourceMappingURL=pr-review-agent.js.map