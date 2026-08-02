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
export interface HookConfig {
    /** Path to the git repository root */
    repoPath: string;
    /** Whether to install post-checkout hook */
    postCheckout: boolean;
    /** Whether to install pre-commit hook */
    preCommit: boolean;
    /** Whether to enable file-watch auto-commit */
    fileWatch: boolean;
    /** Path to the CLI binary (default: 'buff') */
    cliPath: string;
    /** Interval in ms for file-watch polling (default: 60000) */
    watchIntervalMs: number;
}
export type HookType = 'post-checkout' | 'pre-commit' | 'prepare-commit-msg';
export interface HookEvent {
    type: 'branch-created' | 'commit-made' | 'file-changed' | 'ci-failed';
    branch?: string;
    commitMessage?: string;
    changedFiles?: string[];
    prNumber?: number;
}
/**
 * Install git hooks for branch automation.
 */
export declare function installHooks(config: HookConfig): boolean;
/**
 * Remove installed git hooks.
 */
export declare function removeHooks(repoPath: string): boolean;
/**
 * Check if hooks are installed.
 */
export declare function getHookStatus(repoPath: string): {
    postCheckout: boolean;
    preCommit: boolean;
    fileWatch: boolean;
};
/**
 * Detect issue-based branch patterns in the current branch name.
 * Returns the issue key and type if detected, or null.
 */
export declare function detectIssueBranch(branchName: string): {
    issueKey: string;
    type: 'feat' | 'fix' | 'chore';
    description: string;
} | null;
/**
 * Generate a branch name from issue information.
 */
export declare function generateBranchName(issueKey: string, title: string, type?: 'feat' | 'fix' | 'chore'): string;
/**
 * Create a branch if it doesn't exist and checkout to it.
 */
export declare function createAndCheckoutBranch(branchName: string, cwd?: string): string;
/**
 * Determine the conventional commit type from changed files.
 */
export declare function detectCommitType(changedFiles: string[]): 'feat' | 'fix' | 'refactor' | 'docs' | 'style' | 'test' | 'chore';
/**
 * Generate a conventional commit message from changed files.
 */
export declare function generateCommitMessage(changedFiles: string[], description?: string): string;
/**
 * Stage all files and commit with a generated message.
 */
export declare function autoCommit(changedFiles: string[], commitMessage?: string, cwd?: string): {
    success: boolean;
    message: string;
    output: string;
};
//# sourceMappingURL=branch-automation-hooks.d.ts.map