/**
 * BranchAutomationAgent — Automated branch workflow with trigger-based hooks.
 *
 * Trigger Sources:
 * 1. Issue → Branch: When an issue is assigned, auto-create a feature branch
 * 2. PR Label → Update: When a label like 'wip' or 'needs-work' is added, auto-update
 * 3. File Watch → Commit: Watch for file changes and auto-commit with conventional messages
 * 4. CI Status → Fix: When CI fails on a PR, detect failure, fix it, push
 *
 * Usage:
 * - `buff execute "install branch hooks" --auto-branch`
 * - `buff execute "auto-create branch from issue PROJ-123" --auto-branch`
 * - `buff execute "auto-commit changes" --auto-branch`
 * - `buff execute "fix CI for PR #42" --auto-branch`
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
export declare class BranchAutomationAgent extends Agent {
    readonly name = "BranchAutomation";
    readonly description = "Automates branch workflows: issue\u2192branch, PR\u2192update, file\u2192commit, CI\u2192fix";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private getRepoPath;
    private getCurrentBranch;
    private getChangedFiles;
    private handleInstall;
    private handleRemove;
    private handleStatus;
    private handleIssueBranch;
    private handlePRUpdate;
    private handleFileWatch;
    private handleAutoCommit;
    private handleCIFix;
    private handleAutoDetect;
}
//# sourceMappingURL=branch-automation-agent.d.ts.map