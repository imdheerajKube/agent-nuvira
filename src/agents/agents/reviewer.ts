/**
 * ReviewerAgent — Validates code changes produced by the WriterAgent.
 *
 * The reviewer checks for:
 * - Syntax errors and type mismatches
 * - Security vulnerabilities (SQL injection, XSS, etc.)
 * - Code style and conventions
 * - Correctness of the implementation against the task description
 * - Missing edge cases and error handling
 *
 * Output is stored in the shared context bus as conversation messages.
 */

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';
import {
  BASE_RETRY_DELAY_MS,
  LONG_WAIT_THRESHOLD_MS,
  calculateRetryDelay,
  isRateLimitError,
  parseModelName,
  parseRetryAfterHint,
} from '../rate-limit-retry.js';

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. Review the following code changes for quality, correctness, and security.

Focus on:
1. **Correctness** — Does the code correctly implement the described task?
2. **Security** — Any SQL injection, XSS, path traversal, or other vulnerabilities?
3. **Error handling** — Are edge cases and invalid inputs handled?
4. **Code quality** — Is the code clean, readable, and maintainable?
5. **Type safety** — Are there any type mismatches or implicit any types?
6. **Performance** — Any obvious performance issues?

## Output Format

ONLY list issues that actually exist. Do NOT describe absent issues.

For each issue found, use this exact format:
- CRITICAL: <description>
  Location: <file/line>
  Fix: <suggestion>

- WARNING: <description>
  Location: <file/line>
  Fix: <suggestion>

- SUGGESTION: <description>
  Location: <file/line>

If NO issues are found, respond ONLY with:
✅ Review passed. No issues found.

Do NOT mention potential issues that don't exist. Do NOT use the words "CRITICAL", "WARNING", or "SUGGESTION" unless you are actually flagging an issue.`;

/** Maximum API retry attempts for transient LLM failures */
const MAX_API_RETRIES = 2;

/**
 * ReviewerAgent — Validates code changes produced by WriterAgent.
 */
export class ReviewerAgent extends Agent {
  readonly name = 'Reviewer';
  readonly description = 'Validates code changes for correctness, security, and quality';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    let lastError: string | undefined;

    if (context.fileChanges.length === 0) {
      this.report(context, 'skipped', 'No changes to review');
      return {
        success: true,
        summary: 'No files to review',
        details: 'The WriterAgent did not produce any file changes.',
      };
    }

    this.report(context, 'reviewing', `Reviewing ${context.fileChanges.length} change(s) for correctness, security, and quality…`);

    // The rate-limit handler can swap the LLM mid-review (auto-switch), so the
    // loop must call through a mutable reference, not the original parameter.
    let activeCallLLM = callLLM;

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      try {
        const prompt = this.buildPrompt(context);
        this.report(context, 'thinking', 'Checking for security issues, edge cases, and type safety…');
        const response = await activeCallLLM(prompt, {
          temperature: 0.2,
          maxTokens: 4096,
        });

        // Log the review as a conversation message
        context.conversations.push({
          from: 'Reviewer',
          to: 'Orchestrator',
          content: response,
          timestamp: Date.now(),
        });

        const hasCriticalIssues = this.hasCriticalIssues(response);

        this.report(
          context,
          hasCriticalIssues ? 'blocked' : 'passed',
          hasCriticalIssues
            ? 'Found critical issues — the change will be sent back for repair'
            : 'Review passed — changes are safe to apply',
        );

        return {
          success: !hasCriticalIssues,
          summary: hasCriticalIssues
            ? 'Review found critical issues'
            : 'Review passed',
          details: response,
          error: hasCriticalIssues
            ? 'Critical issues found — see review details'
            : undefined,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // ── Rate-limit handling via the orchestrator (decision #26) ─────
        // A 429 with a reset hint (e.g. "try again in 18.2s") needs the FULL
        // wait — the fixed backoff below would fire every attempt inside the
        // reset window and kill the review on a transient TPM blip. Long
        // hints delegate to context.onRateLimit so the orchestrator can wait
        // silently, auto-switch provider (storm/exhaustion), or prompt.
        if (isRateLimitError(lastError) && context.onRateLimit) {
          const retryAfterMs = parseRetryAfterHint(lastError) || BASE_RETRY_DELAY_MS;

          if (retryAfterMs >= LONG_WAIT_THRESHOLD_MS) {
            const action = await context.onRateLimit({
              retryAfterMs,
              modelName: parseModelName(lastError),
              agentName: this.name,
              errorMessage: lastError.slice(0, 300),
            });

            if (action.action === 'abort') {
              logger.error(`Reviewer aborted by user: ${lastError}`);
              return {
                success: false,
                summary: 'Review aborted by user due to rate limit',
                error: lastError,
              };
            }

            if (action.action === 'skip') {
              logger.info('Reviewer step skipped by user');
              return {
                success: true,
                summary: 'Skipped by user (rate limit)',
                details: 'The review step was skipped because the API rate limit was exceeded.',
              };
            }

            if (action.action === 'switch-model') {
              logger.info('Switching model per user request...');
              activeCallLLM = action.callLLM ?? activeCallLLM;
              // Brief pause before retrying with the new provider/model.
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }

            // 'retry': wait the full reset hint, then retry.
            logger.warn(
              `Reviewer rate limited. Waiting ${(retryAfterMs / 1000).toFixed(1)}s as chosen by user...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
          }
        }

        // ── Standard retry for transient errors ───────────────────────
        if (attempt < MAX_API_RETRIES) {
          if (isRateLimitError(lastError)) {
            // Short rate limit: auto-retry with the hint-aware delay.
            const delayMs = calculateRetryDelay(attempt, lastError);
            logger.warn(
              `Reviewer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Waiting ${(delayMs / 1000).toFixed(1)}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else {
            // Other transient errors (timeout, network): standard backoff.
            const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            logger.warn(
              `Reviewer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Retrying in ${delayMs}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        logger.error(`Reviewer failed after ${MAX_API_RETRIES + 1} API attempts: ${lastError}`);
        return {
          success: false,
          summary: 'Review failed',
          error: lastError,
        };
      }
    }

    // Unreachable
    return {
      success: false,
      summary: 'Review failed',
      error: lastError || 'Unknown error',
    };
  }

  /**
   * Build the review prompt from the task plan, relevant context, and changes.
   *
   * Session 20 (Decision 3 — spec→verify): when the orchestrator seeded the
   * RequestContract acceptance criteria into context.metadata, they are
   * appended as an Acceptance Criteria section. The reviewer must then emit a
   * per-criterion verdict line (PASS/FAIL), and any FAIL marks the review as
   * blocking — "done" means the changes satisfy the contract, not just a
   * loose goal match.
   */
  private buildPrompt(context: AgentContext): string {
    // Format the task description
    const taskDescriptions = context.taskPlan
      .filter((s) => s.agentType === 'writer')
      .map((s) => `  - ${s.description}`)
      .join('\n');

    // Format the file changes as diffs
    const diffs = context.fileChanges
      .map((change) => {
        const header = `--- a/${change.path}\n+++ b/${change.path}`;
        if (change.originalContent && change.newContent) {
          // Simple diff: show old and new
          return `${header}\n@@ ... @@\n${change.originalContent}\n---\n${change.newContent}`;
        }
        if (change.status === 'created') {
          return `${header}\n@@ -0,0 +1 @@\n+ (new file)\n${change.newContent}`;
        }
        return header;
      })
      .join('\n\n');

    const acceptanceCriteria = (context.metadata?.acceptanceCriteria as string[] | undefined) ?? [];
    const criteriaSection =
      acceptanceCriteria.length > 0
        ? `\n\n## Acceptance Criteria\nThe user (via the request contract) defined these success criteria. Verify EACH one explicitly against the changes.\n${acceptanceCriteria
            .map((c, i) => `${i + 1}. ${c}`)
            .join('\n')}\n\nAfter your issue review, emit a verdict line for EVERY criterion:\n- PASS: <criterion>\n- FAIL: <criterion> — <reason>\n\nAny FAIL means the changes do not satisfy the contract — mark the overall review as blocked.`
        : '';

    // Wire failure lessons into reviewer: the reviewer should know about past
    // failures so it can check for known issues that caused problems before.
    const failureLessonContext = context.metadata?.failureLessonContext as string | undefined;
    const memorySection = failureLessonContext
      ? `\n\n## Known Failure Patterns\nCheck specifically for these issues — they caused failures in similar past tasks:${failureLessonContext}`
      : '';

    return `${REVIEWER_SYSTEM_PROMPT}\n\n## Task Description\n${taskDescriptions || context.goal}\n\n## Changes to Review\n${diffs || '(No changes provided)'}${criteriaSection}${memorySection}\n\n## Instructions\nReview the above changes. Identify any issues and provide feedback.`;
  }

  /**
   * Check if the review response contains any critical issues.
   * Looks for "CRITICAL:" (with colon) at the start of a bullet or line.
   * This avoids false positives from LLMs that say things like
   * "No critical issues found" (which lacks the colon prefix).
   */
  private hasCriticalIssues(review: string): boolean {
    // Match "CRITICAL:" (with colon) on its own line, as a bullet, or in flow text.
    // The colon prefix is critical — it's how the prompt tells the LLM to format issues.
    // "No critical issues found" won't match; "CRITICAL: SQL injection" will.
    const criticalPrefix = /(?:^|\n|[-*]\s*)CRITICAL\s*:/im;

    // Session 20: a per-criterion FAIL verdict from the Acceptance Criteria
    // section means the changes do not satisfy the contract → blocking.
    const criterionFail = /(?:^|\n)[-*]?\s*FAIL\s*:/im;

    // Also match the old patterns for backwards compatibility
    const oldPatterns = [
      /🔴/,
      /\bBlocking\b/,
      /\bSecurity\s*vulnerability\b/i,
    ];

    return (
      criticalPrefix.test(review) ||
      criterionFail.test(review) ||
      oldPatterns.some((p) => p.test(review))
    );
  }
}
