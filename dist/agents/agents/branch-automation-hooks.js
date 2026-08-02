/**
 * Branch Automation Hooks — Git hooks installer for automated branch workflows.
 *
 * Manages git hooks (post-checkout, pre-commit) that trigger agent actions:
 * - post-checkout: Auto-create feature branches on issue assignment
 * - pre-commit: Auto-commit file changes with conventional commit messages
 *
 * Hooks are installed to `.git/hooks/` and call back into the agent-nuvira CLI
 * using `buff execute "branch-automation <event>" --auto-branch`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
// ─── Hook Templates ─────────────────────────────────────────────────────────
/**
 * Post-checkout hook template.
 * Triggers when branches are created/switched to detect issue-based branches.
 */
const POST_CHECKOUT_HOOK = `#!/bin/sh
# Agent-Nuvira Branch Automation Hook
# Installed by: buff execute --auto-branch
# Triggers: auto-create branches from issue assignments

REF_BEFORE="$1"
REF_AFTER="$2"
CHECKOUT_TYPE="$3"

# Only trigger on branch switches (not file checkouts)
if [ "$CHECKOUT_TYPE" = "1" ]; then
  BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD)
  # Detect issue-based branch pattern: feat/ISSUE-123-description
  if echo "$BRANCH_NAME" | grep -qE '^(feat|fix|chore)/[A-Z]+-[0-9]+'; then
    # Extract issue key and notify agent
    ISSUE_KEY=$(echo "$BRANCH_NAME" | sed -E 's/^[^/]*\\/([A-Z]+-[0-9]+).*/\\1/')
    echo "[agent-nuvira] Branch automation: detected issue branch $BRANCH_NAME (issue: $ISSUE_KEY)"
    # Run background agent task for issue context loading
    # Uses nohup to avoid blocking the checkout
    (nohup {{CLI_PATH}} execute "Load issue context for $ISSUE_KEY on branch $BRANCH_NAME" --auto-branch > /dev/null 2>&1 &)
  fi
fi
`;
/**
 * Pre-commit hook template.
 * Enforces conventional commit format and auto-generates messages from changes.
 */
const PRE_COMMIT_HOOK = `#!/bin/sh
# Agent-Nuvira Branch Automation Hook
# Installed by: buff execute --auto-branch
# Triggers: auto-commit with conventional commit messages

# If AUTO_COMMIT env var is set, skip the hook (prevent recursive commits)
if [ -n "$AGENT_NUVIRA_AUTO_COMMIT" ]; then
  exit 0
fi

# Check if there are staged changes
STAGED=$(git diff --cached --stat)
if [ -z "$STAGED" ]; then
  echo "[agent-nuvira] No staged changes. Skipping pre-commit hook."
  exit 0
fi

echo "[agent-nuvira] Pre-commit hook: detecting changes for conventional commit..."
exit 0
`;
/**
 * File-watch auto-commit script (used by the BranchAutomationAgent).
 * Polls for file changes and auto-commits with conventional messages.
 */
const FILE_WATCH_SCRIPT = `#!/bin/sh
# Agent-Nuvira File Watch Auto-Commit
# Monitors the working directory for changes and auto-commits
# Installed at: {{HOOKS_DIR}}/file-watch.sh

WATCH_DIR="$1"
if [ -z "$WATCH_DIR" ]; then
  WATCH_DIR="."
fi

echo "[agent-nuvira] File watch started on: $(cd "$WATCH_DIR" && pwd)"
echo "[agent-nuvira] Auto-commit interval: {{WATCH_INTERVAL}}s"
echo "[agent-nuvira] To stop: pkill -f 'file-watch.sh $WATCH_DIR'"

LAST_HASH=""

while true; do
  sleep {{WATCH_INTERVAL}}

  # Get current working tree hash
  CURRENT_HASH=$(cd "$WATCH_DIR" && git diff --no-color 2>/dev/null | md5sum 2>/dev/null || git diff --no-color 2>/dev/null | md5 2>/dev/null)

  if [ -z "$CURRENT_HASH" ]; then
    continue
  fi

  if [ -n "$LAST_HASH" ] && [ "$CURRENT_HASH" != "$LAST_HASH" ]; then
    # Changes detected
    CHANGED_FILES=$(cd "$WATCH_DIR" && git diff --no-color --name-only 2>/dev/null | tr '\\n' ',' | sed 's/,$//')
    if [ -n "$CHANGED_FILES" ]; then
      echo "[agent-nuvira] Changes detected: $CHANGED_FILES"
      # Trigger agent to review and commit
      (nohup {{CLI_PATH}} execute "Review and auto-commit changes in: $CHANGED_FILES" --auto-branch > /dev/null 2>&1 &)
    fi
  fi

  LAST_HASH="$CURRENT_HASH"
done
`;
// ─── Git Hooks Manager ──────────────────────────────────────────────────────
/**
 * Install git hooks for branch automation.
 */
export function installHooks(config) {
    const hooksDir = join(config.repoPath, '.git', 'hooks');
    if (!existsSync(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
    }
    const cliPath = config.cliPath || 'buff';
    let installed = false;
    if (config.postCheckout) {
        const content = POST_CHECKOUT_HOOK.replace(/{{CLI_PATH}}/g, cliPath);
        writeFileSync(join(hooksDir, 'post-checkout'), content, { mode: 0o755 });
        installed = true;
        logger.info('  ✅ post-checkout hook installed');
    }
    if (config.preCommit) {
        const content = PRE_COMMIT_HOOK.replace(/{{CLI_PATH}}/g, cliPath);
        writeFileSync(join(hooksDir, 'pre-commit'), content, { mode: 0o755 });
        installed = true;
        logger.info('  ✅ pre-commit hook installed');
    }
    if (config.fileWatch) {
        const hooksPath = join(homedir(), '.buff', 'hooks');
        if (!existsSync(hooksPath)) {
            mkdirSync(hooksPath, { recursive: true });
        }
        const script = FILE_WATCH_SCRIPT
            .replace(/{{CLI_PATH}}/g, cliPath)
            .replace(/{{WATCH_INTERVAL}}/g, String(Math.round(config.watchIntervalMs / 1000)))
            .replace(/{{HOOKS_DIR}}/g, hooksPath);
        writeFileSync(join(hooksPath, 'file-watch.sh'), script, { mode: 0o755 });
        installed = true;
        logger.info('  ✅ file-watch script installed');
    }
    return installed;
}
/**
 * Remove installed git hooks.
 */
export function removeHooks(repoPath) {
    const hooksDir = join(repoPath, '.git', 'hooks');
    let removed = false;
    const hookFiles = ['post-checkout', 'pre-commit'];
    for (const file of hookFiles) {
        try {
            const filePath = join(hooksDir, file);
            if (existsSync(filePath)) {
                const content = readFileSync(filePath, 'utf-8');
                if (content.includes('Agent-Nuvira')) {
                    // Only remove hooks we installed
                    writeFileSync(filePath, '', 'utf-8');
                    removed = true;
                    logger.info(`  🗑️  Removed ${file} hook`);
                }
            }
        }
        catch {
            // Best-effort removal
        }
    }
    return removed;
}
/**
 * Check if hooks are installed.
 */
export function getHookStatus(repoPath) {
    const hooksDir = join(repoPath, '.git', 'hooks');
    const result = { postCheckout: false, preCommit: false, fileWatch: false };
    try {
        const postCheckoutPath = join(hooksDir, 'post-checkout');
        if (existsSync(postCheckoutPath)) {
            const content = readFileSync(postCheckoutPath, 'utf-8');
            result.postCheckout = content.includes('Agent-Nuvira');
        }
    }
    catch { /* ignore */ }
    try {
        const preCommitPath = join(hooksDir, 'pre-commit');
        if (existsSync(preCommitPath)) {
            const content = readFileSync(preCommitPath, 'utf-8');
            result.preCommit = content.includes('Agent-Nuvira');
        }
    }
    catch { /* ignore */ }
    const watchPath = join(homedir(), '.buff', 'hooks', 'file-watch.sh');
    result.fileWatch = existsSync(watchPath);
    return result;
}
// ─── Issue Branch Detection ─────────────────────────────────────────────────
/**
 * Detect issue-based branch patterns in the current branch name.
 * Returns the issue key and type if detected, or null.
 */
export function detectIssueBranch(branchName) {
    const match = branchName.match(/^(feat|fix|chore)\/([A-Z]+-[0-9]+)-(.*)$/);
    if (match) {
        return {
            type: match[1],
            issueKey: match[2],
            description: match[3].replace(/-/g, ' '),
        };
    }
    // Also match: feat/description (no issue key)
    const genericMatch = branchName.match(/^(feat|fix|chore)\/(.+)$/);
    if (genericMatch) {
        return {
            type: genericMatch[1],
            issueKey: '',
            description: genericMatch[2].replace(/-/g, ' '),
        };
    }
    return null;
}
/**
 * Generate a branch name from issue information.
 */
export function generateBranchName(issueKey, title, type = 'feat') {
    const sanitized = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    return issueKey
        ? `${type}/${issueKey}-${sanitized}`
        : `${type}/${sanitized}`;
}
/**
 * Create a branch if it doesn't exist and checkout to it.
 */
export function createAndCheckoutBranch(branchName, cwd) {
    const workDir = cwd || process.cwd();
    const existing = execSync(`git branch --list "${branchName}"`, {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 10000,
    }).trim();
    if (existing) {
        execSync(`git checkout "${branchName}"`, {
            cwd: workDir,
            encoding: 'utf-8',
            timeout: 10000,
        });
        return `Switched to existing branch '${branchName}'`;
    }
    execSync(`git checkout -b "${branchName}"`, {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 10000,
    });
    return `Created and switched to branch '${branchName}'`;
}
// ─── Conventional Commit ────────────────────────────────────────────────────
/**
 * Determine the conventional commit type from changed files.
 */
export function detectCommitType(changedFiles) {
    const allPaths = changedFiles.join(' ').toLowerCase();
    if (allPaths.includes('test') || allPaths.includes('spec') || allPaths.includes('__tests__'))
        return 'test';
    if (allPaths.includes('doc') || allPaths.includes('readme') || allPaths.includes('.md'))
        return 'docs';
    if (allPaths.includes('.css') || allPaths.includes('.scss') || allPaths.includes('style'))
        return 'style';
    if (allPaths.includes('fix') || allPaths.includes('bug') || allPaths.includes('hotfix'))
        return 'fix';
    if (allPaths.includes('refactor') || allPaths.includes('clean'))
        return 'refactor';
    if (allPaths.includes('chore') || allPaths.includes('config') || allPaths.includes('deps'))
        return 'chore';
    return 'feat';
}
/**
 * Generate a conventional commit message from changed files.
 */
export function generateCommitMessage(changedFiles, description) {
    const type = detectCommitType(changedFiles);
    // Extract scope: the top-level directory
    const scopes = changedFiles
        .map((f) => f.split('/')[0])
        .filter(Boolean);
    const scope = [...new Set(scopes)].slice(0, 3).join('/') || 'general';
    const desc = description || `update ${changedFiles.length} file(s): ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? '...' : ''}`;
    const maxDesc = desc.slice(0, 68);
    return `${type}(${scope.slice(0, 20)}): ${maxDesc}`;
}
/**
 * Stage all files and commit with a generated message.
 */
export function autoCommit(changedFiles, commitMessage, cwd) {
    const workDir = cwd || process.cwd();
    try {
        // Stage all changes
        execSync('git add -A', { cwd: workDir, encoding: 'utf-8', timeout: 30000 });
        // Check if there's anything to commit
        const status = execSync('git status --short', { cwd: workDir, encoding: 'utf-8', timeout: 10000 }).trim();
        if (!status) {
            return { success: true, message: 'No changes to commit', output: '' };
        }
        // Generate or use provided message
        const msg = commitMessage || generateCommitMessage(changedFiles);
        // Set env var to prevent recursive hook triggering
        const env = { ...process.env, AGENT_NUVIRA_AUTO_COMMIT: '1' };
        execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
            cwd: workDir,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: 'pipe',
            env,
        });
        return {
            success: true,
            message: msg,
            output: `Committed: ${msg}`,
        };
    }
    catch (err) {
        const error = err;
        return {
            success: false,
            message: 'Commit failed',
            output: error.stderr || error.message || 'Unknown error',
        };
    }
}
//# sourceMappingURL=branch-automation-hooks.js.map