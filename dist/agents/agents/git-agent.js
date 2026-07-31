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
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import { logger } from '../../utils/logger.js';
const COMMIT_MESSAGE_PROMPT = `You are an expert at writing clear, conventional git commit messages.

Given the following git diff, write a concise commit message following conventional commits format:

<type>(<scope>): <description>

Types: feat, fix, refactor, docs, style, test, chore, perf, ci
Scope: the module/area affected (optional)

Rules:
- First line: max 72 characters
- Body: wrap at 72 characters, explain what and why, not how
- Use imperative mood ("add" not "added" / "adds")
- Be specific but concise

Return ONLY the commit message, nothing else.`;
/** Maximum push attempts before giving up */
const MAX_PUSH_ATTEMPTS = 2;
/**
 * GitAgent — Handles git operations for the multi-agent pipeline.
 */
export class GitAgent extends Agent {
    name = 'Git';
    description = 'Manages git operations (branch, commit, push, PR)';
    async execute(context, callLLM) {
        try {
            const taskDesc = context.taskPlan.find((s) => s.agentType === 'git' && s.status === 'running')?.description || context.goal;
            const operation = this.detectOperation(taskDesc);
            switch (operation) {
                case 'status':
                    return this.gitStatus();
                case 'branch':
                    return this.createBranch(context, taskDesc);
                case 'push':
                    return this.pushToRemote();
                case 'tag':
                    return this.createAndPushTag(context, taskDesc);
                case 'commit':
                    return this.commit(context, callLLM);
                case 'auto-push':
                    return this.autoPush(context, callLLM);
                case 'pr-description':
                    return this.generatePRDescription(context, callLLM);
                default:
                    return this.autoPush(context, callLLM);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: 'Git operation failed', error: msg };
        }
    }
    detectOperation(description) {
        const lower = description.toLowerCase();
        if (lower.includes('status') || lower.includes('check'))
            return 'status';
        if (lower.includes('branch') || lower.includes('checkout') || lower.includes('switch'))
            return 'branch';
        if (lower.includes('push') && !lower.includes('auto'))
            return 'push';
        if (lower.includes('tag') || lower.includes('release tag'))
            return 'tag';
        if (lower.includes('auto') || lower.includes('auto-push') || lower.includes('commit and push'))
            return 'auto-push';
        if (lower.includes('pr') || lower.includes('pull request') || lower.includes('description'))
            return 'pr-description';
        return 'commit';
    }
    // ─── Status ───────────────────────────────────────────────────────────────
    async gitStatus() {
        const output = this.exec('git status --short');
        const lines = output.trim().split('\n').filter(Boolean);
        let branch = '';
        try {
            branch = this.exec('git rev-parse --abbrev-ref HEAD').trim();
        }
        catch { /* ignore */ }
        let remote = '';
        try {
            remote = this.exec('git remote get-url origin').trim();
        }
        catch { /* ignore */ }
        const details = [
            `Branch: ${branch || 'unknown'}`,
            `Remote: ${remote || 'none'}`,
            `Changes: ${lines.length} file(s)`,
            '',
            output,
        ].join('\n');
        return {
            success: true,
            summary: `${lines.length} file(s) changed on ${branch || 'current branch'}`,
            details,
        };
    }
    // ─── Branch ───────────────────────────────────────────────────────────────
    async createBranch(context, description) {
        const sanitized = context.goal
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
        const branchName = `feat/${sanitized}`;
        const existing = this.exec(`git branch --list "${branchName}"`);
        if (existing.trim()) {
            return { success: true, summary: `Branch '${branchName}' already exists`, details: branchName };
        }
        this.exec(`git checkout -b "${branchName}"`);
        return { success: true, summary: `Created branch '${branchName}'`, details: branchName };
    }
    // ─── Commit ───────────────────────────────────────────────────────────────
    async commit(context, callLLM) {
        this.exec('git add -A');
        const status = this.exec('git status --short');
        if (!status.trim()) {
            return { success: true, summary: 'No changes to commit' };
        }
        const diff = this.exec('git diff --cached --stat');
        const fullDiff = this.exec('git diff --cached');
        let commitMessage = '';
        try {
            const prompt = `${COMMIT_MESSAGE_PROMPT}\n\n## Diff Summary\n${diff}\n\n## Full Diff (truncated)\n${fullDiff.slice(0, 4000)}`;
            commitMessage = await callLLM(prompt, { temperature: 0.3, maxTokens: 500 });
            commitMessage = commitMessage.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
        }
        catch {
            commitMessage = `feat: ${context.goal.slice(0, 60)}`;
        }
        if (!commitMessage || commitMessage.length < 5) {
            commitMessage = `feat: ${context.goal.slice(0, 60)}`;
        }
        const msgDir = mkdtempSync(join(tmpdir(), 'git-msg-'));
        const msgFile = join(msgDir, 'commit-msg.txt');
        writeFileSync(msgFile, commitMessage, 'utf-8');
        this.exec(`git commit -F "${msgFile}"`);
        try {
            unlinkSync(msgFile);
        }
        catch { /* best-effort */ }
        return {
            success: true,
            summary: `Committed with message: ${commitMessage.split('\n')[0].slice(0, 72)}`,
            details: commitMessage,
        };
    }
    // ─── Push ─────────────────────────────────────────────────────────────────
    /**
     * Push the current branch to the remote.
     * Uses GIT_ASKPASS for HTTPS auth (set by CredentialStore) or SSH agent.
     */
    async pushToRemote() {
        let branch = 'main';
        try {
            branch = this.exec('git rev-parse --abbrev-ref HEAD').trim();
        }
        catch { /* use default */ }
        let remote = 'origin';
        try {
            const remotes = this.exec('git remote').trim();
            if (remotes) {
                remote = remotes.split('\n')[0].trim();
            }
            else {
                return {
                    success: false,
                    summary: 'No git remote configured',
                    error: 'Add a remote first: git remote add origin <url>',
                };
            }
        }
        catch {
            return { success: false, summary: 'No git remote configured', error: 'Git remote not found' };
        }
        let lastError = '';
        for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
            try {
                const output = execSync(`git push -u "${remote}" "${branch}" 2>&1`, {
                    cwd: process.cwd(),
                    timeout: 120_000,
                    encoding: 'utf-8',
                    stdio: 'pipe',
                });
                const lines = output.trim().split('\n').filter(Boolean);
                return {
                    success: true,
                    summary: `Pushed ${branch} to ${remote}`,
                    details: lines.join('\n'),
                };
            }
            catch (err) {
                const error = err;
                const msg = error.stderr || error.message || '';
                if (msg.includes('Authentication failed') || msg.includes('auth failed') ||
                    msg.includes('403') || msg.includes('401')) {
                    lastError = 'Authentication failed. Set GITHUB_TOKEN or GH_TOKEN env var, or run creds setup.';
                    break;
                }
                if (msg.includes('Could not read from remote') || msg.includes('Repository not found') ||
                    msg.includes('fatal:')) {
                    lastError = msg.slice(0, 200);
                    break;
                }
                lastError = msg.slice(0, 200);
                if (attempt < MAX_PUSH_ATTEMPTS - 1) {
                    try {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    catch { /* ignore */ }
                    logger.debug(`Retrying git push (attempt ${attempt + 2}/${MAX_PUSH_ATTEMPTS})...`);
                }
            }
        }
        return {
            success: false,
            summary: `Failed to push ${branch} to ${remote}`,
            error: lastError || 'Push failed after retries',
        };
    }
    // ─── Tag ──────────────────────────────────────────────────────────────────
    async createAndPushTag(context, description) {
        let version = '';
        const versionMatch = description.match(/v?(\d+\.\d+\.\d+)/);
        if (versionMatch) {
            version = versionMatch[1];
        }
        else {
            try {
                const { existsSync, readFileSync } = await import('node:fs');
                const pkgPath = join(process.cwd(), 'package.json');
                if (existsSync(pkgPath)) {
                    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                    version = pkg.version || '';
                }
            }
            catch { /* fall through */ }
        }
        if (!version) {
            try {
                const lastTag = this.exec('git describe --tags --abbrev=0 2>&1').trim();
                const parts = lastTag.replace(/^v/, '').split('.').map(Number);
                version = `${parts[0] || 0}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
            }
            catch {
                version = '0.1.0';
            }
        }
        const tagName = `v${version}`;
        try {
            const existing = this.exec(`git tag -l "${tagName}"`);
            if (existing.trim() === tagName) {
                return this.pushTagToRemote(tagName);
            }
        }
        catch { /* continue */ }
        try {
            this.exec(`git tag -a "${tagName}" -m "Release ${tagName}"`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: `Failed to create tag ${tagName}`, error: msg.slice(0, 200) };
        }
        return this.pushTagToRemote(tagName);
    }
    async pushTagToRemote(tagName) {
        let remote = 'origin';
        try {
            const remotes = this.exec('git remote').trim();
            if (remotes)
                remote = remotes.split('\n')[0].trim();
        }
        catch { /* use default */ }
        try {
            const output = execSync(`git push "${remote}" "${tagName}" 2>&1`, {
                cwd: process.cwd(),
                timeout: 60_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
            return {
                success: true,
                summary: `Pushed tag ${tagName} to ${remote}`,
                details: output.trim(),
            };
        }
        catch (err) {
            const error = err;
            const msg = error.stderr || error.message || '';
            if (msg.includes('403') || msg.includes('401') || msg.includes('auth')) {
                return {
                    success: false,
                    summary: `Failed to push tag ${tagName}: authentication required`,
                    error: 'Set GITHUB_TOKEN or GH_TOKEN env var, or run credential setup',
                };
            }
            return {
                success: false,
                summary: `Failed to push tag ${tagName}`,
                error: msg.slice(0, 200),
            };
        }
    }
    // ─── Auto-Push ────────────────────────────────────────────────────────────
    async autoPush(context, callLLM) {
        const commitResult = await this.commit(context, callLLM);
        if (!commitResult.success) {
            return commitResult;
        }
        const pushResult = await this.pushToRemote();
        if (!pushResult.success) {
            return {
                success: false,
                summary: `${commitResult.summary} but push failed: ${pushResult.error || pushResult.summary}`,
                details: `Committed locally. Push failed. Ensure git credentials are configured.`,
                error: pushResult.error,
            };
        }
        return {
            success: true,
            summary: `${commitResult.summary} and pushed to remote`,
            details: [commitResult.details || '', pushResult.details || ''].filter(Boolean).join('\n'),
        };
    }
    // ─── PR Description ───────────────────────────────────────────────────────
    async generatePRDescription(context, callLLM) {
        const diff = this.exec('git diff main...HEAD --stat');
        const fullDiff = this.exec('git diff main...HEAD');
        const prompt = `Generate a GitHub pull request description from the following diff.\n\n## Diff (truncated)\n${fullDiff.slice(0, 4000)}\n\n## Format\n### Summary\n[1-2 sentences describing the change]\n\n### Changes\n- [list of files changed and why]\n\n### Testing\n- [how to test this change]\n\n### Related Issues\n- [if applicable]`;
        let description;
        try {
            description = await callLLM(prompt, { temperature: 0.3, maxTokens: 1500 });
            description = description.trim();
        }
        catch {
            description = `## Changes\n${diff || 'No diff available'}\n\nAuto-generated by agent-nuvira.`;
        }
        return {
            success: true,
            summary: 'Generated PR description',
            details: description,
        };
    }
    // ─── Exec Helper (Cross-Platform) ─────────────────────────────────────────
    exec(command, cwd) {
        try {
            return execSync(command, {
                cwd: cwd || process.cwd(),
                timeout: 30_000,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
        }
        catch (err) {
            const error = err;
            const msg = error.stderr || error.message || '';
            if (msg.includes('Command failed') || msg.includes('not found') || msg.includes('not a git repository') ||
                msg.includes('not recognized') || msg.includes('cannot find') || msg.includes('failed to start')) {
                throw new Error(msg.slice(0, 200));
            }
            return error.stdout || msg;
        }
    }
}
//# sourceMappingURL=git-agent.js.map