/**
 * CI command — Headless CI/CD mode for deterministic pipeline execution.
 *
 * Designed for use in CI/CD pipelines (GitHub Actions, GitLab CI, etc.)
 * with structured JSON output and exit codes. No fancy UI — machine-first.
 *
 * Usage:
 *   buff ci execute "add JWT auth"             # Execute goal, emit JSON result, exit 0/1
 *   buff ci execute "run tests" --provider groq
 *   buff ci execute "fix bug" --github-annotations  # GitHub Actions annotation format
 *   buff ci check "is the build green?"        # Exit code 0/1 gate check
 *   buff ci review src/auth.ts src/api.ts      # Review files, emit JSON findings
 *   buff ci review --format github             # GitHub Actions annotation format
 *
 * Exit codes:
 *   0 = Success / All checks pass
 *   1 = Failure / Checks failed / Error occurred
 */

import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { applyActiveModel } from './model.js';
import { ReviewerAgent } from '../agents/agents/reviewer.js';
import type { AgentContext, FileChange, LLMCallFn } from '../agents/agent.js';
import { ProviderFactory } from '../inference/factory.js';
import type { ProviderType } from '../config/types.js';
import { logger } from '../utils/logger.js';

// ─── JSON Output Types ──────────────────────────────────────────────────────

export interface CIExecuteResult {
  /** Overall success/failure */
  success: boolean;
  /** The original goal */
  goal: string;
  /** Human-readable summary */
  summary: string;
  /** Tasks completed / total */
  tasksCompleted: number;
  tasksTotal: number;
  /** File changes summary as readable string */
  fileChanges?: string;
  /** Runner command output */
  runOutput?: string;
  /** Error message if failed */
  error?: string;
  /** Trajectory ID if memory was stored */
  trajectoryId?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Provider/model used */
  provider?: string;
  model?: string;
}

export interface CIReviewFinding {
  /** File path */
  file: string;
  /** Severity: error | warning | info */
  severity: 'error' | 'warning' | 'info';
  /** Line number (1-based) */
  line?: number;
  /** Column number (1-based) */
  column?: number;
  /** Finding message */
  message: string;
  /** Suggestion for fixing */
  suggestion?: string;
}

export interface CIReviewResult {
  /** Overall pass/fail */
  success: boolean;
  /** Number of files reviewed */
  filesReviewed: number;
  /** Total findings */
  totalFindings: number;
  /** Findings grouped by severity */
  errors: number;
  warnings: number;
  infos: number;
  /** All findings */
  findings: CIReviewFinding[];
  /** Duration in milliseconds */
  durationMs: number;
}

export interface CICheckResult {
  /** Whether the check passed (exit code 0) or failed (exit code 1) */
  passed: boolean;
  /** Summary of what was checked */
  summary: string;
  /** Detailed reasoning */
  details?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── CI Command ─────────────────────────────────────────────────────────────

export class CICommand extends BaseCommand {
  create(): Command {
    const command = new Command('ci')
      .description('Headless CI/CD mode — structured JSON output and exit codes for pipelines');

    // ── execute ──────────────────────────────────────────────────────────
    command
      .command('execute')
      .description('Execute a goal and emit JSON result (exit 0 = success, 1 = failure)')
      .argument('<goal>', 'The goal to accomplish (e.g., "add JWT auth to Express app")')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('--planner-model <model>', 'Model for the Planner agent')
      .option('--writer-model <model>', 'Model for the Writer agent')
      .option('--reviewer-model <model>', 'Model for the Reviewer agent')
      .option('--memory', 'Enable persistent memory', false)
      .option('--context-limit <tokens>', 'Max context tokens before pruning', parseInt)
      .option('--context-prune <mode>', 'Pruning aggressiveness: soft | medium | aggressive')
      .option('--sandbox', 'Execute runner commands and tests inside a Docker sandbox', false)
      .option('--timeout <ms>', 'Max execution time in milliseconds', parseInt)
      .option('--github-annotations', 'Emit GitHub Actions annotation format for errors', false)
      .action(async (goal: string, options?: {
        provider?: string;
        model?: string;
        plannerModel?: string;
        writerModel?: string;
        reviewerModel?: string;
        memory?: boolean;
        contextLimit?: number;
        contextPrune?: string;
        sandbox?: boolean;
        timeout?: number;
        githubAnnotations?: boolean;
      }) => {
        await this.ciExecute(goal, options || {});
      });

    // ── check ────────────────────────────────────────────────────────────
    command
      .command('check')
      .description('Run a gate check (exit 0 = pass, 1 = fail) — minimal output, ideal for workflow gates')
      .argument('<goal>', 'The check to perform (e.g., "is the code review ready?")')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('--verbose', 'Show detailed output even in check mode', false)
      .action(async (goal: string, options?: {
        provider?: string;
        model?: string;
        verbose?: boolean;
      }) => {
        await this.ciCheck(goal, options || {});
      });

    // ── review ───────────────────────────────────────────────────────────
    command
      .command('review')
      .description('Review one or more files and emit JSON findings')
      .argument('<files...>', 'Files to review (space-separated)')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('--format <format>', 'Output format: json (default), github (GitHub Actions annotations)', 'json')
      .option('--context <text>', 'Additional context for the review (e.g., coding standards)')
      .action(async (files: string[], options?: {
        provider?: string;
        model?: string;
        format?: string;
        context?: string;
      }) => {
        await this.ciReview(files, options || {});
      });

    return command;
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  private async ciExecute(
    goal: string,
    options: {
      provider?: string;
      model?: string;
      plannerModel?: string;
      writerModel?: string;
      reviewerModel?: string;
      memory?: boolean;
      contextLimit?: number;
      contextPrune?: string;
      sandbox?: boolean;
      timeout?: number;
      githubAnnotations?: boolean;
    },
  ): Promise<void> {
    const startTime = Date.now();

    // Apply active model from `buff model switch` as defaults
    const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });
    const mergedProvider = activeOpts.provider;
    const mergedModel = activeOpts.model;

    // Agent model overrides
    const agentModels: Record<string, string> = {};
    if (options.plannerModel) agentModels['planner'] = options.plannerModel;
    if (options.writerModel) agentModels['writer'] = options.writerModel;
    if (options.reviewerModel) agentModels['reviewer'] = options.reviewerModel;

    try {
      // Enforce timeout if specified
      const execPromise = (async () => {
        const orchestrator = new Orchestrator(this.configManager);
        return orchestrator.execute(goal, {
          provider: mergedProvider,
          model: mergedModel,
          agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
          dryRun: false,
          verbose: false,
          useDockerSandbox: options.sandbox,
          useMemory: options.memory,
          contextLimit: options.contextLimit,
          contextPruneMode: options.contextPrune as 'soft' | 'medium' | 'aggressive' | undefined,
        });
      })();

      let result;
      if (options.timeout && options.timeout > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timed out after ${options.timeout}ms`)), options.timeout),
        );
        result = await Promise.race([execPromise, timeoutPromise]);
      } else {
        result = await execPromise;
      }

      const durationMs = Date.now() - startTime;

      // Build structured output
      const output: CIExecuteResult = {
        success: result.success,
        goal: result.goal,
        summary: result.summary,
        tasksCompleted: result.tasksCompleted,
        tasksTotal: result.tasksTotal,
        durationMs,
        provider: mergedProvider,
        model: mergedModel,
      };

      if (result.fileChanges && result.fileChanges !== 'No files changed.') {
        output.fileChanges = result.fileChanges;
      }

      if (result.runOutput) {
        output.runOutput = result.runOutput;
      }

      if (result.error) {
        output.error = result.error;
      }

      if (result.trajectoryId) {
        output.trajectoryId = result.trajectoryId;
      }

      // Emit JSON to stdout (machine-readable)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');

      // Emit GitHub Actions annotations if requested
      if (options.githubAnnotations && !result.success && result.error) {
        emitGitHubError('execute', goal, result.error, result.summary);
      }

      // Exit with appropriate code
      process.exit(result.success ? 0 : 1);

    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      const output: CIExecuteResult = {
        success: false,
        goal,
        summary: 'Execution failed with unexpected error',
        tasksCompleted: 0,
        tasksTotal: 0,
        error: msg,
        durationMs,
        provider: mergedProvider,
        model: mergedModel,
      };

      process.stdout.write(JSON.stringify(output, null, 2) + '\n');

      if (options.githubAnnotations) {
        emitGitHubError('execute', goal, msg);
      }

      process.exit(1);
    }
  }

  // ─── Check ────────────────────────────────────────────────────────────────

  private async ciCheck(
    goal: string,
    options: {
      provider?: string;
      model?: string;
      verbose?: boolean;
    },
  ): Promise<void> {
    const startTime = Date.now();

    // Apply active model
    const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });

    try {
      const orchestrator = new Orchestrator(this.configManager);
      const result = await orchestrator.execute(goal, {
        provider: activeOpts.provider,
        model: activeOpts.model,
        verbose: false,
      });

      const durationMs = Date.now() - startTime;

      const checkResult: CICheckResult = {
        passed: result.success,
        summary: result.summary,
        durationMs,
      };

      if (result.error) {
        checkResult.details = result.error;
      }

      // In verbose mode, emit full JSON
      if (options.verbose) {
        process.stdout.write(JSON.stringify(checkResult, null, 2) + '\n');
      }

      process.exit(result.success ? 0 : 1);

    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      const checkResult: CICheckResult = {
        passed: false,
        summary: 'Check failed with unexpected error',
        details: msg,
        durationMs,
      };

      if (options.verbose) {
        process.stdout.write(JSON.stringify(checkResult, null, 2) + '\n');
      }

      process.exit(1);
    }
  }

  // ─── Review ───────────────────────────────────────────────────────────────

  private async ciReview(
    files: string[],
    options: {
      provider?: string;
      model?: string;
      format?: string;
      context?: string;
    },
  ): Promise<void> {
    const startTime = Date.now();
    const findings: CIReviewFinding[] = [];

    // Resolve provider once for all reviews
    const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });
    const providerType = (activeOpts.provider || options.provider || 'local') as ProviderType;
    const providerConfig = this.configManager.getProviderConfig(providerType);
    const finalConfig = { ...providerConfig.config, model: activeOpts.model || providerConfig.config.model };
    const provider = ProviderFactory.createProvider(providerType, finalConfig);

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`Provider ${providerType} is not available. Cannot perform review.`);
      process.exit(1);
      return;
    }

    const callLLM: LLMCallFn = async (prompt, opts) => {
      return provider.generate(prompt, opts || {});
    };

    // Review each file
    for (const file of files) {
      if (!existsSync(file)) {
        findings.push({
          file,
          severity: 'error',
          message: `File not found: ${file}`,
        });
        continue;
      }

      try {
        const content = readFileSync(file, 'utf-8');

        const context: AgentContext = {
          goal: options.context
            ? `Review ${file}: ${options.context}`
            : `Review ${file} for bugs, security issues, style problems, and code quality`,
          workingDirectory: process.cwd(),
          taskPlan: [],
          fileChanges: [
            {
              path: file,
              status: 'modified' as const,
              originalContent: content,
              newContent: content,
            },
          ],
          artifacts: [],
          conversations: [],
          metadata: {},
        };

        const reviewer = new ReviewerAgent();
        const result = await reviewer.execute(context, callLLM);

        // Parse reviewer output into structured findings
        if (result.summary) {
          const fileFindings = parseReviewOutput(file, result.summary);
          findings.push(...fileFindings);
        }

        if (!result.success && result.error) {
          findings.push({
            file,
            severity: 'error',
            message: `Review failed: ${result.error}`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          file,
          severity: 'error',
          message: `Unexpected error reviewing ${file}: ${msg}`,
        });
      }
    }

    const durationMs = Date.now() - startTime;

    const reviewResult: CIReviewResult = {
      success: findings.filter((f) => f.severity === 'error').length === 0,
      filesReviewed: files.length,
      totalFindings: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      infos: findings.filter((f) => f.severity === 'info').length,
      findings,
      durationMs,
    };

    // Output in requested format
    const format = options.format || 'json';
    if (format === 'github') {
      for (const f of findings) {
        emitGitHubAnnotation(f);
      }
      process.stdout.write(JSON.stringify(reviewResult, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify(reviewResult, null, 2) + '\n');
    }

    process.exit(reviewResult.success ? 0 : 1);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Emit a GitHub Actions error annotation.
 * Format: ::error file={file},line={line},title={title}::{message}
 */
function emitGitHubAnnotation(finding: CIReviewFinding): void {
  const parts: string[] = [`file=${finding.file}`];
  if (finding.line) parts.push(`line=${finding.line}`);
  if (finding.column) parts.push(`col=${finding.column}`);

  const severity = finding.severity === 'error' ? 'error'
    : finding.severity === 'warning' ? 'warning'
    : 'notice';

  const title = finding.suggestion
    ? `${finding.message} — ${finding.suggestion}`
    : finding.message;

  process.stderr.write(`::${severity} ${parts.join(',')}::${title}\n`);
}

/**
 * Emit a general GitHub Actions error annotation for execute/check failures.
 */
function emitGitHubError(command: string, goal: string, message: string, summary?: string): void {
  const title = summary ? `${message} — ${summary}` : message;
  process.stderr.write(`::error title=buff ci ${command}::${goal}: ${title}\n`);
}

/**
 * Parse the ReviewerAgent's text summary into structured findings.
 * Looks for common review patterns like:
 *   - ERROR: ... | WARNING: ... | INFO: ...
 *   - Line 42: ... | L42: ...
 *   - - [ ] ... (checklist items)
 */
export function parseReviewOutput(file: string, text: string): CIReviewFinding[] {
  const findings: CIReviewFinding[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect severity prefix
    let severity: 'error' | 'warning' | 'info' | null = null;
    let message = trimmed;

    const errorMatch = trimmed.match(/^(ERROR|❌|🔴)\s*[:.]?\s*(.+)/i);
    const warningMatch = trimmed.match(/^(WARNING|⚠️|🟠|🟡)\s*[:.]?\s*(.+)/i);
    const infoMatch = trimmed.match(/^(INFO|ℹ️|🔵|💡)\s*[:.]?\s*(.+)/i);

    if (errorMatch) {
      severity = 'error';
      message = errorMatch[2];
    } else if (warningMatch) {
      severity = 'warning';
      message = warningMatch[2];
    } else if (infoMatch) {
      severity = 'info';
      message = infoMatch[2];
    } else if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
      severity = 'warning';
      message = trimmed.replace(/^[-*]\s*\[\s*\]\s*/, '');
    } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('* [x]')) {
      severity = 'info';
      message = trimmed.replace(/^[-*]\s*\[x\]\s*/, '');
    } else {
      // Default: skip unclassified lines
      continue;
    }

    // Extract line number from message if present
    let lineNumber: number | undefined;
    const lineMatch = message.match(/(?:line|L)\s*(\d+)/i);
    if (lineMatch) {
      lineNumber = parseInt(lineMatch[1], 10);
    }

    // Extract suggestion if present (text after "Suggestion:" or "->")
    let suggestion: string | undefined;
    const suggestionMatch = message.match(/suggestion:\s*(.+)/i);
    if (suggestionMatch) {
      suggestion = suggestionMatch[1].trim();
      message = message.replace(/suggestion:\s*.+/i, '').trim();
    }

    const arrowMatch = message.match(/\s*->\s*(.+)/);
    if (arrowMatch) {
      suggestion = arrowMatch[1].trim();
      message = message.replace(/\s*->\s*.+/, '').trim();
    }

    findings.push({
      file,
      severity,
      message: message.replace(/^[:.,\s]+|[:.,\s]+$/g, ''), // Clean up leading/trailing punctuation
      line: lineNumber,
      suggestion,
    });
  }

  // If no structured findings were extracted, create a single generic finding
  if (findings.length === 0 && text.trim()) {
    findings.push({
      file,
      severity: 'info',
      message: text.trim().slice(0, 500),
    });
  }

  return findings;
}
