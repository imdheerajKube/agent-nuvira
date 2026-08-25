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
 * - `nuvira execute "install branch hooks" --auto-branch`
 * - `nuvira execute "auto-create branch from issue PROJ-123" --auto-branch`
 * - `nuvira execute "auto-commit changes" --auto-branch`
 * - `nuvira execute "fix CI for PR #42" --auto-branch`
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { resolveNuviraHome } from '../../config/paths';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import {
  installHooks,
  removeHooks,
  getHookStatus,
  detectIssueBranch,
  generateBranchName,
  createAndCheckoutBranch,
  autoCommit,
  generateCommitMessage,
  type HookConfig,
  type HookEvent,
} from './branch-automation-hooks.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_WATCH_INTERVAL_MS = 60_000;

// ─── BranchAutomationAgent ──────────────────────────────────────────────────

export class BranchAutomationAgent extends Agent {
  readonly name = 'BranchAutomation';
  readonly description = 'Automates branch workflows: issue→branch, PR→update, file→commit, CI→fix';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const taskDesc = context.taskPlan.find(
        (s) => s.agentType === 'branch-automation' && s.status === 'running',
      )?.description || context.goal;

      const operation = this.detectOperation(taskDesc, context);
      const repoPath = this.getRepoPath();

      switch (operation) {
        case 'install':
          return this.handleInstall(repoPath);
        case 'remove':
          return this.handleRemove(repoPath);
        case 'status':
          return this.handleStatus(repoPath);
        case 'issue-branch':
          return this.handleIssueBranch(context, callLLM, repoPath);
        case 'pr-update':
          return this.handlePRUpdate(context, callLLM, repoPath);
        case 'auto-commit':
          return this.handleAutoCommit(context, callLLM, repoPath);
        case 'ci-fix':
          return this.handleCIFix(context, callLLM, repoPath);
        case 'file-watch':
          return this.handleFileWatch(repoPath);
        default:
          return this.handleAutoDetect(context, callLLM, repoPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Branch automation failed', error: msg.slice(0, 300) };
    }
  }

  // ─── Operation Detection ──────────────────────────────────────────────────

  private detectOperation(description: string, context: AgentContext): BranchOperationType {
    const lower = description.toLowerCase();

    if (lower.includes('install') || lower.includes('setup') || lower.includes('enable')) return 'install';
    if (lower.includes('remove') || lower.includes('uninstall') || lower.includes('disable')) return 'remove';
    if (lower.includes('status') || lower.includes('check') || lower.includes('list')) return 'status';
    if (lower.includes('issue') || lower.includes('branch from issue') || lower.includes('create branch')) return 'issue-branch';
    if (lower.includes('pr') || lower.includes('pull request') || lower.includes('label')) return 'pr-update';
    if (lower.includes('watch') || lower.includes('monitor') || lower.includes('file change') || lower.includes('auto-commit')) return 'file-watch';
    if (lower.includes('ci') || lower.includes('ci fix') || lower.includes('fix ci') || lower.includes('pipeline')) return 'ci-fix';
    if (lower.includes('commit') || lower.includes('auto commit')) return 'auto-commit';

    // Auto-detect from context flags
    if (context.goal.includes('--auto-branch')) return 'auto-commit';

    return 'auto-detect';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getRepoPath(): string {
    try {
      // No `2>/dev/null` redirect — that's bash syntax; on Windows cmd.exe
      // it would try to write to a literal \dev\null path. The try/catch
      // already swallows the error case.
      const output = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      return output || process.cwd();
    } catch {
      return process.cwd();
    }
  }

  private getCurrentBranch(): string {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch {
      return 'main';
    }
  }

  private getChangedFiles(): string[] {
    try {
      const output = execSync('git diff --name-only', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const staged = execSync('git diff --cached --name-only', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const all = [...output.split('\n'), ...staged.split('\n')]
        .filter(Boolean)
        .map((f) => f.trim());
      return [...new Set(all)];
    } catch {
      return [];
    }
  }

  // ─── Install Hooks ────────────────────────────────────────────────────────

  private async handleInstall(repoPath: string): Promise<AgentResult> {
    const config: HookConfig = {
      repoPath,
      postCheckout: true,
      preCommit: true,
      fileWatch: true,
      cliPath: 'buff',
      watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS,
    };

    const installed = installHooks(config);

    if (installed) {
      return {
        success: true,
        summary: 'Branch automation hooks installed',
        details: [
          '✅ post-checkout hook — auto-detect issue branches on checkout',
          '✅ pre-commit hook — conventional commit message enforcement',
          '✅ file-watch script — auto-commit on file changes',
          '',
          `Hooks installed in: ${join(repoPath, '.git', 'hooks')}`,
          `File-watch script: ${join(resolveNuviraHome(), 'hooks', 'file-watch.sh')}`,
          '',
          'To start file-watch: nuvira execute "start file watch" --auto-branch',
          'To remove hooks: nuvira execute "remove branch hooks" --auto-branch',
        ].join('\n'),
      };
    }

    return {
      success: true,
      summary: 'Hooks were already installed or no hooks were configured',
    };
  }

  private async handleRemove(repoPath: string): Promise<AgentResult> {
    const removed = removeHooks(repoPath);
    return {
      success: true,
      summary: removed ? 'Branch automation hooks removed' : 'No hooks found to remove',
    };
  }

  private async handleStatus(repoPath: string): Promise<AgentResult> {
    const status = getHookStatus(repoPath);
    const branch = this.getCurrentBranch();
    const changedFiles = this.getChangedFiles();

    const statusLines = [
      `Repository: ${repoPath}`,
      `Current branch: ${branch}`,
      `Changed files: ${changedFiles.length}`,
      '',
      'Hook Status:',
      `  post-checkout: ${status.postCheckout ? '✅ installed' : '❌ not installed'}`,
      `  pre-commit: ${status.preCommit ? '✅ installed' : '❌ not installed'}`,
      `  file-watch: ${status.fileWatch ? '✅ installed' : '❌ not installed'}`,
      '',
    ];

    // Detect if we're on an issue branch
    const issueInfo = detectIssueBranch(branch);
    if (issueInfo) {
      statusLines.push(`Issue Branch: ${issueInfo.type}/${issueInfo.issueKey}-${issueInfo.description.replace(/ /g, '-')}`);
      statusLines.push(`  Issue: ${issueInfo.issueKey}`);
      statusLines.push(`  Type: ${issueInfo.type}`);
    }

    return {
      success: true,
      summary: `Branch automation status — ${Object.values(status).filter(Boolean).length}/3 hooks active`,
      details: statusLines.join('\n'),
    };
  }

  // ─── Issue → Branch ───────────────────────────────────────────────────────

  private async handleIssueBranch(
    context: AgentContext,
    callLLM: LLMCallFn,
    repoPath: string,
  ): Promise<AgentResult> {
    const description = context.goal;
    const branch = this.getCurrentBranch();

    // Extract issue info from goal text
    const issueMatch = description.match(/([A-Z]+-[0-9]+)/);
    const issueKey = issueMatch ? issueMatch[1] : '';

    // Determine branch type from description
    let branchType: 'feat' | 'fix' | 'chore' = 'feat';
    if (description.toLowerCase().includes('fix') || description.toLowerCase().includes('bug')) branchType = 'fix';
    if (description.toLowerCase().includes('chore') || description.toLowerCase().includes('config')) branchType = 'chore';

    // Extract a meaningful description from the goal
    let branchDesc = description
      .replace(/auto-create branch from issue/i, '')
      .replace(/create branch/i, '')
      .replace(/--auto-branch/g, '')
      .replace(issueKey, '')
      .trim();

    if (!branchDesc) {
      branchDesc = branchType;
    }

    const branchName = generateBranchName(issueKey, branchDesc, branchType);

    // Don't create if already on this branch
    if (branch === branchName) {
      return {
        success: true,
        summary: `Already on branch '${branchName}'`,
        details: branchName,
      };
    }

    try {
      const result = createAndCheckoutBranch(branchName, repoPath);
      return {
        success: true,
        summary: result,
        details: branchName,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: `Failed to create branch '${branchName}'`,
        error: msg.slice(0, 200),
      };
    }
  }

  // ─── PR Label → Update ────────────────────────────────────────────────────

  private async handlePRUpdate(
    context: AgentContext,
    callLLM: LLMCallFn,
    repoPath: string,
  ): Promise<AgentResult> {
    const description = context.goal;
    const branch = this.getCurrentBranch();

    // Extract PR number
    const prMatch = description.match(/#(\d+)|PR[- ]?(\d+)/i);
    const prNumber = prMatch ? (prMatch[1] || prMatch[2]) : '';

    // Extract label info
    const labelMatch = description.match(/label[:\s]*["']?(\w+)["']?/i);
    const label = labelMatch ? labelMatch[1].toLowerCase() : '';

    // Detect what kind of update is needed from the label
    let updateType = 'general';
    if (label === 'wip' || label === 'work-in-progress') {
      updateType = 'wip-update';
    } else if (label === 'needs-work' || label === 'changes-requested') {
      updateType = 'address-feedback';
    } else if (label.includes('fix') || label.includes('bug')) {
      updateType = 'bug-fix';
    }

    // Get changed files
    const changedFiles = this.getChangedFiles();

    if (changedFiles.length === 0) {
      return {
        success: true,
        summary: 'No changes to push to PR',
        details: `PR #${prNumber || 'unknown'} on branch '${branch}'`,
      };
    }

    // Commit changes
    const commitResult = autoCommit(changedFiles, undefined, repoPath);
    if (!commitResult.success) {
      return {
        success: false,
        summary: `Failed to commit PR updates for ${label || 'update'}`,
        error: commitResult.output,
      };
    }

    // Push to remote
    try {
      execSync(`git push origin "${branch}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 60000,
      });

      return {
        success: true,
        summary: `Updated PR #${prNumber || 'unknown'} with ${changedFiles.length} file change(s)`,
        details: [
          `Branch: ${branch}`,
          `Updated files: ${changedFiles.join(', ')}`,
          `Commit: ${commitResult.message}`,
          prNumber ? `PR: #${prNumber}` : '',
          '',
          '✅ Changes pushed to remote.',
        ].filter(Boolean).join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: true,
        summary: `Committed locally but push failed: ${msg.slice(0, 100)}`,
        details: commitResult.output,
      };
    }
  }

  // ─── File Watch → Commit ──────────────────────────────────────────────────

  private async handleFileWatch(repoPath: string): Promise<AgentResult> {
    const hooksPath = join(resolveNuviraHome(), 'hooks');
    const watchScript = join(hooksPath, 'file-watch.sh');

    if (!existsSync(watchScript)) {
      // Install the watch script first
      const config: HookConfig = {
        repoPath,
        postCheckout: false,
        preCommit: false,
        fileWatch: true,
        cliPath: 'buff',
        watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS,
      };
      installHooks(config);
    }

    // Start file-watch in background using the installed script.
    // Cross-platform: a detached Node spawn replaces the Unix-only
    // `nohup sh ... > /tmp/... 2>&1 & echo $!` incantation (nohup, sh and
    // /tmp don't exist on Windows). Windows gets a matching .cmd wrapper;
    // the watcher's output is appended to a tmpdir log file on both.
    try {
      const isWindows = process.platform === 'win32';
      const scriptPath = join(resolveNuviraHome(), 'hooks', 'file-watch.sh');
      const wrapperPath = join(
        homedir(),
        '.nuvira',
        'hooks',
        isWindows ? 'file-watch.cmd' : 'file-watch.sh',
      );

      if (isWindows && !existsSync(wrapperPath)) {
        // A .cmd wrapper that calls the sh script via Git Bash's sh.
        // Resolve the sh path once and bake it in — checking only the
        // default Program Files location would miss Scoop/Chocolatey
        // installs and silently report a false success.
        const shPath = this.resolveGitBashSh();
        if (!shPath) {
          return {
            success: false,
            summary: 'Failed to start file watch',
            error: 'Git Bash (sh.exe) not found — install Git for Windows to use file-watch on this machine',
          };
        }
        writeFileSync(
          wrapperPath,
          `@echo off\r\n"${shPath}" "${scriptPath}" "${repoPath}"\r\n`,
          'utf-8',
        );
      }

      const logPath = join(tmpdir(), 'agent-nuvira-filewatch.log');
      // Append the watcher's stdout/stderr to the log file so the advertised
      // Log path is real (the old `> log 2>&1` redirect).
      const logFd = openSync(logPath, 'a');
      const child = spawn(
        isWindows ? wrapperPath : scriptPath,
        isWindows ? [] : [repoPath],
        {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
        },
      );
      child.unref();

      return {
        success: true,
        summary: `File watch started`,
        details: [
          `Watching: ${repoPath}`,
          `Interval: ${DEFAULT_WATCH_INTERVAL_MS / 1000}s`,
          `Log: ${logPath}`,
          '',
          'Auto-commits will be triggered when file changes are detected.',
          'To stop: nuvira execute "stop file watch" --auto-branch',
        ].join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Failed to start file watch',
        error: msg.slice(0, 200),
      };
    }
  }

  /**
   * Locate Git Bash's sh.exe on Windows (used by the file-watch .cmd
   * wrapper). Tries the standard install location, Program Files (x86),
   * and a PATH lookup — Git Bash from Scoop/Chocolatey lives elsewhere.
   */
  private resolveGitBashSh(): string | null {
    const candidates = [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'sh.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'sh.exe'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    try {
      const out = execSync('where sh', { encoding: 'utf-8', timeout: 5000 });
      const first = out.split(/\r?\n/).find((l) => l.trim())?.trim();
      if (first) return first;
    } catch { /* not on PATH */ }
    return null;
  }

  // ─── Auto-Commit ──────────────────────────────────────────────────────────

  private async handleAutoCommit(
    context: AgentContext,
    callLLM: LLMCallFn,
    repoPath: string,
  ): Promise<AgentResult> {
    const changedFiles = this.getChangedFiles();
    if (changedFiles.length === 0) {
      return { success: true, summary: 'No changes to commit' };
    }

    // Try LLM-generated commit message first
    let commitMessage = '';
    try {
      const diff = execSync('git diff --no-color --stat', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10000,
      });
      const fullDiff = execSync('git diff --no-color', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10000,
      });

      const prompt = `Generate a conventional commit message for these changes:\n\n${diff}\n\nFull diff (truncated):\n${fullDiff.slice(0, 2000)}\n\nReturn ONLY the commit message in format: <type>(<scope>): <description>`;
      commitMessage = await callLLM(prompt, { temperature: 0.2, maxTokens: 200 });
      commitMessage = commitMessage.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
    } catch {
      // Fall back to rule-based message
    }

    if (!commitMessage || commitMessage.length < 5) {
      commitMessage = generateCommitMessage(changedFiles);
    }

    const result = autoCommit(changedFiles, commitMessage, repoPath);

    return {
      success: result.success,
      summary: result.success ? `Committed: ${result.message}` : `Commit failed: ${result.output}`,
      details: result.output,
    };
  }

  // ─── CI Status → Fix ──────────────────────────────────────────────────────

  private async handleCIFix(
    context: AgentContext,
    callLLM: LLMCallFn,
    repoPath: string,
  ): Promise<AgentResult> {
    const description = context.goal;
    const branch = this.getCurrentBranch();

    // Extract PR number if provided
    const prMatch = description.match(/#(\d+)|PR[- ]?(\d+)/i);
    const prNumber = prMatch ? (prMatch[1] || prMatch[2]) : '';

    // Try to detect CI failure reason from git status and recent commits
    let failureReason = 'CI pipeline failed';

    try {
      const recentCommits = execSync('git log --oneline -5', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10000,
      });
      const changedFiles = this.getChangedFiles();

      // Try LLM to diagnose the CI failure from context
      const prompt = `A CI pipeline failed on branch '${branch}'${prNumber ? ` (PR #${prNumber})` : ''}.

Recent commits:
${recentCommits}

Changed files:
${changedFiles.join('\n')}

Diagnose the most likely cause of the CI failure and suggest a fix.
Return your analysis and the specific fix needed.`;

      try {
        const analysis = await callLLM(prompt, { temperature: 0.2, maxTokens: 1000 });
        failureReason = analysis.trim();
      } catch {
        failureReason = 'CI failure detected. Attempting automatic fix.';
      }
    } catch {
      failureReason = 'Could not determine CI failure reason. Proceeding with general fix attempt.';
    }

    return {
      success: true,
      summary: `CI fix analysis for branch '${branch}'${prNumber ? ` (PR #${prNumber})` : ''}`,
      details: [
        'CI Failure Analysis:',
        '---',
        failureReason,
        '---',
        '',
        'To apply the fix automatically:',
        `  nuvira execute "Fix CI issues on ${branch}" --auto-branch`,
        '',
        'To run tests locally:',
        '  nuvira execute "Run tests and fix failures"',
        '',
        prNumber ? `PR: #${prNumber} on branch '${branch}'` : `Branch: ${branch}`,
      ].join('\n'),
    };
  }

  // ─── Auto-Detect ──────────────────────────────────────────────────────────

  private async handleAutoDetect(
    context: AgentContext,
    callLLM: LLMCallFn,
    repoPath: string,
  ): Promise<AgentResult> {
    const branch = this.getCurrentBranch();
    const changedFiles = this.getChangedFiles();
    const issueInfo = detectIssueBranch(branch);
    const hookStatus = getHookStatus(repoPath);
    const hasHooks = hookStatus.postCheckout || hookStatus.preCommit;

    const diagnostics: string[] = [
      `Repository: ${repoPath}`,
      `Branch: ${branch}`,
      `Changed files: ${changedFiles.length}`,
      `Hooks installed: ${hasHooks ? 'yes' : 'no'}`,
      issueInfo ? `Issue detected: ${issueInfo.issueKey} (${issueInfo.type})` : '',
    ].filter(Boolean);

    // Recommend next action based on state
    if (changedFiles.length > 0) {
      diagnostics.push('');
      diagnostics.push('💡 Suggested actions:');
      diagnostics.push('  1. Auto-commit: nuvira execute "auto-commit changes" --auto-branch');

      if (!hasHooks) {
        diagnostics.push('  2. Install hooks: nuvira execute "install branch hooks" --auto-branch');
        diagnostics.push('  3. Start file watch: nuvira execute "start file watch" --auto-branch');
      }
    } else if (issueInfo) {
      diagnostics.push('');
      diagnostics.push(`💡 On issue branch for ${issueInfo.issueKey}. Ready to work.`);
      diagnostics.push('  Changes will be auto-detected and committed.');
    } else if (!hasHooks) {
      diagnostics.push('');
      diagnostics.push('💡 Branch automation not configured.');
      diagnostics.push('  Install hooks: nuvira execute "install branch hooks" --auto-branch');
    }

    return {
      success: true,
      summary: `Branch automation diagnostic for '${branch}'`,
      details: diagnostics.join('\n'),
    };
  }
}

// ─── Operation Type ─────────────────────────────────────────────────────────

type BranchOperationType =
  | 'install'
  | 'remove'
  | 'status'
  | 'issue-branch'
  | 'pr-update'
  | 'auto-commit'
  | 'ci-fix'
  | 'file-watch'
  | 'auto-detect';
