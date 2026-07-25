/**
 * VerifyModule — Explicit verification pipeline extracted from ReviewerAgent
 * and SecurityAgent. Phase 6 of the architecture migration.
 *
 * Combines LLM-based code review with automated security scans to produce
 * a structured VerificationResult with per-check pass/fail, overall score,
 * blockers, and suggestions.
 *
 * @see ARCHITECTURE.md §3.6 — Verify Module specification
 */

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn } from './agent.js';
import type { FileChange } from './agent.js';
import { runAllScans, formatScanReport } from '../security/scanner.js';
import type { SecurityFinding } from '../security/scanner.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Type of verification check performed */
export type CheckType = 'tests' | 'security' | 'goal-alignment' | 'code-quality';

/** Severity of a verification check result */
export type CheckSeverity = 'blocking' | 'warning' | 'info';

/** Result of a single verification check */
export interface VerificationCheck {
  /** Type of check performed */
  type: CheckType;
  /** Whether the check passed */
  passed: boolean;
  /** Human-readable details about the check result */
  details: string;
  /** Severity level */
  severity: CheckSeverity;
}

/** Overall result of a verification run */
export interface VerificationResult {
  /** Whether all blocking checks passed */
  passed: boolean;
  /** All individual check results */
  checks: VerificationCheck[];
  /** Normalized score from 0.0 to 1.0 */
  overallScore: number;
  /** List of blocking issues that must be resolved */
  blockers: string[];
  /** Non-blocking improvement suggestions */
  suggestions: string[];
}

/** Parameters for the VerifyModule.verify() method */
export interface VerifyParams {
  /** File changes to verify */
  changes: FileChange[];
  /** The original user goal */
  goal: string;
  /** Optional test results summary */
  testResults?: { passed: number; failed: number; total: number };
  /** Optional runner output */
  runOutput?: string;
  /** Optional strictness level (default: 'medium') */
  strictness?: 'low' | 'medium' | 'high';
  /** Optional LLM call function for review-based checks */
  callLLM?: LLMCallFn;
  /** Optional working directory for syntax checks */
  workingDirectory?: string;
}

// ─── VerifyModule Interface ─────────────────────────────────────────────────

/**
 * VerifyModule — Validate that changes meet quality standards before proceeding.
 *
 * @example
 * ```typescript
 * const module = new DefaultVerifyModule();
 * const result = await module.verify({
 *   changes: fileChanges,
 *   goal: 'Add JWT auth',
 *   strictness: 'high',
 * });
 * console.log(result.passed, result.overallScore);
 * ```
 */
export interface VerifyModule {
  /**
   * Run verification checks on the given changes.
   */
  verify(params: VerifyParams): Promise<VerificationResult>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max characters of code to include in the LLM review prompt */
const MAX_CODE_CHARS = 10_000;

/** Minimum score to pass verification at each strictness level */
const PASS_THRESHOLDS: Record<string, number> = {
  low: 0.5,
  medium: 0.7,
  high: 0.9,
};

// ─── Default VerifyModule ───────────────────────────────────────────────────

/**
 * DefaultVerifyModule — Built-in verification module implementation.
 *
 * Runs a pipeline of checks:
 * 1. Security scan — automated regex-based scan of all file changes
 * 2. Goal-alignment review — LLM-based check (if callLLM provided)
 * 3. Test result check — if test results provided
 * 4. Run output check — if runner output provided
 */
export class DefaultVerifyModule implements VerifyModule {
  private eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Run all verification checks and produce a structured result.
   */
  async verify(params: VerifyParams): Promise<VerificationResult> {
    const { strictness = 'medium' } = params;

    // ── Emit: verification starting ───────────────────────────────────
    this.eventBus.emit(EventNames.VERIFY_STARTING, {
      changeCount: params.changes.length,
      strictness,
      hasLLM: !!params.callLLM,
    }, 'verify-module');

    const checks: VerificationCheck[] = [];
    const blockers: string[] = [];
    const suggestions: string[] = [];

    // ── 1. Security scan ──────────────────────────────────────────────
    const securityCheck = this.runSecurityCheck(params.changes);
    checks.push(securityCheck);
    this.eventBus.emit(EventNames.VERIFY_CHECK, {
      type: 'security',
      passed: securityCheck.passed,
      severity: securityCheck.severity,
      details: securityCheck.details.slice(0, 200),
    }, 'verify-module');
    if (!securityCheck.passed && securityCheck.severity === 'blocking') {
      blockers.push(securityCheck.details);
    }

    // ── 2. Goal-alignment review (LLM-based) ──────────────────────────
    if (params.callLLM && params.changes.length > 0) {
      try {
        const alignmentCheck = await this.runGoalAlignmentCheck(params);
        checks.push(alignmentCheck);
        this.eventBus.emit(EventNames.VERIFY_CHECK, {
          type: 'goal-alignment',
          passed: alignmentCheck.passed,
          severity: alignmentCheck.severity,
          details: alignmentCheck.details.slice(0, 200),
        }, 'verify-module');
        if (!alignmentCheck.passed) {
          blockers.push(alignmentCheck.details);
        }
      } catch {
        checks.push({
          type: 'goal-alignment',
          passed: false,
          details: 'Goal-alignment check failed (LLM error)',
          severity: 'warning',
        });
      }
    }

    // ── 3. Test result check ──────────────────────────────────────────
    if (params.testResults) {
      const testCheck = this.runTestCheck(params.testResults, strictness);
      checks.push(testCheck);
      this.eventBus.emit(EventNames.VERIFY_CHECK, {
        type: 'tests',
        passed: testCheck.passed,
        severity: testCheck.severity,
        details: testCheck.details.slice(0, 200),
      }, 'verify-module');
      if (!testCheck.passed) {
        blockers.push(testCheck.details);
      }
    }

    // ── 4. Run output check ───────────────────────────────────────────
    if (params.runOutput) {
      const outputCheck = this.runOutputCheck(params.runOutput, strictness);
      checks.push(outputCheck);
      this.eventBus.emit(EventNames.VERIFY_CHECK, {
        type: 'code-quality',
        passed: outputCheck.passed,
        severity: outputCheck.severity,
        details: outputCheck.details.slice(0, 200),
      }, 'verify-module');
      if (!outputCheck.passed) {
        suggestions.push(outputCheck.details);
      }
    }

    // ── Compute overall score ─────────────────────────────────────────
    const totalChecks = checks.length;
    const passedChecks = checks.filter((c) => c.passed).length;
    const overallScore = totalChecks > 0 ? passedChecks / totalChecks : 1.0;

    // Determine pass/fail based on strictness
    const threshold = PASS_THRESHOLDS[strictness] ?? PASS_THRESHOLDS.medium;
    const blockingCount = checks.filter(
      (c) => !c.passed && c.severity === 'blocking',
    ).length;
    const passed = blockingCount === 0 && overallScore >= threshold;

    // Collect non-blocking suggestions
    for (const check of checks) {
      if (!check.passed && check.severity !== 'blocking') {
        suggestions.push(check.details);
      }
    }

    const result: VerificationResult = {
      passed,
      checks,
      overallScore,
      blockers: [...new Set(blockers)],
      suggestions: [...new Set(suggestions)],
    };

    // ── Emit: verification completed ──────────────────────────────────
    this.eventBus.emit(EventNames.VERIFY_COMPLETED, {
      passed: result.passed,
      score: result.overallScore,
      checkCount: result.checks.length,
      blockerCount: result.blockers.length,
    }, 'verify-module');

    return result;
  }

  // ─── Private Check Methods ───────────────────────────────────────────

  /** Run automated security scan on all file changes */
  private runSecurityCheck(changes: FileChange[]): VerificationCheck {
    const allFindings: SecurityFinding[] = [];
    const details: string[] = [];

    for (const change of changes) {
      const content = change.newContent || change.originalContent;
      if (!content) continue;

      const result = runAllScans(content, {
        isGenerated: change.status === 'created' || change.status === 'modified',
        filename: change.path,
      });

      allFindings.push(...result.findings);

      if (result.findings.length > 0) {
        details.push(`File: ${change.path}`);
        details.push(formatScanReport(result));
      }
    }

    if (allFindings.length === 0) {
      return {
        type: 'security',
        passed: true,
        details: 'Security scan passed — no issues found',
        severity: 'info',
      };
    }

    const hasBlocking = allFindings.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );

    return {
      type: 'security',
      passed: !hasBlocking,
      details: `Security scan found ${allFindings.length} issue(s): ${details.join('; ')}`,
      severity: hasBlocking ? 'blocking' : 'warning',
    };
  }

  /** Use LLM to verify changes align with the user's goal */
  private async runGoalAlignmentCheck(params: VerifyParams): Promise<VerificationCheck> {
    const prompt = this.buildAlignmentPrompt(params);
    const response = await params.callLLM!(prompt);
    const passed = !response.includes('MISALIGNED') && !response.includes('BLOCKING');

    return {
      type: 'goal-alignment',
      passed,
      details: response.length > 300 ? response.slice(0, 300) + '...' : response,
      severity: passed ? 'info' : 'blocking',
    };
  }

  /** Check test results for failures */
  private runTestCheck(
    testResults: { passed: number; failed: number; total: number },
    strictness: string,
  ): VerificationCheck {
    const { passed, failed, total } = testResults;

    if (total === 0) {
      return {
        type: 'tests',
        passed: true,
        details: 'No tests to run',
        severity: 'info',
      };
    }

    if (failed > 0) {
      const isBlocking = strictness !== 'low';
      return {
        type: 'tests',
        passed: !isBlocking,
        details: `${failed}/${total} tests failed`,
        severity: isBlocking ? 'blocking' : 'warning',
      };
    }

    return {
      type: 'tests',
      passed: true,
      details: `All ${passed} tests passed`,
      severity: 'info',
    };
  }

  /** Check runner output for errors, respecting strictness level */
  private runOutputCheck(runOutput: string, strictness: string): VerificationCheck {
    const hasError = /error|failed|exit code [1-9]/i.test(runOutput);

    if (!hasError) {
      return {
        type: 'code-quality',
        passed: true,
        details: 'Runner output looks clean',
        severity: 'info',
      };
    }

    const isBlocking = strictness === 'high';
    return {
      type: 'code-quality',
      passed: !isBlocking,
      details: 'Runner output contains errors — review the output',
      severity: isBlocking ? 'blocking' : 'warning',
    };
  }

  /** Build the prompt for LLM-based goal alignment check */
  private buildAlignmentPrompt(params: VerifyParams): string {
    let prompt = `You are a verification agent. Determine if the following code changes correctly implement the user's goal.

Goal: ${params.goal}

Changes:
`;

    for (const change of params.changes) {
      const content = (change.newContent || change.originalContent || '').slice(0, MAX_CODE_CHARS);
      prompt += `\n### ${change.path} (${change.status})\n\`\`\`\n${content}\n\`\`\`\n`;
    }

    prompt += `\nRespond with ONLY one of the following verdicts:
- ALIGNED: The changes correctly implement the goal.
- MISALIGNED: The changes do NOT correctly implement the goal.
- BLOCKING: <specific issue>: The changes contain a specific issue that must be fixed.

If MISALIGNED or BLOCKING, briefly explain why (one sentence).

Verdict:`;

    return prompt;
  }
}
