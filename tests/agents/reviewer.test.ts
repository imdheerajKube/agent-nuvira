/**
 * Session 20 — ReviewerAgent acceptance-criteria wiring tests (Decision 3:
 * spec→verify). The orchestrator seeds the RequestContract criteria into
 * context.metadata; the reviewer must include them in its prompt and treat a
 * per-criterion FAIL verdict as blocking.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReviewerAgent } from '../../src/agents/agents/reviewer.js';
import type { AgentContext, FileChange, TaskStep } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const plan: TaskStep[] = [
    {
      id: 't1',
      description: 'Add JWT auth middleware',
      agentType: 'writer',
      dependsOn: [],
      status: 'completed',
    },
  ];
  const changes: FileChange[] = [
    { path: 'src/auth.ts', status: 'created', newContent: 'export const sign = (p: string) => p;' },
  ];
  return {
    goal: 'Add JWT auth middleware',
    workingDirectory: '/tmp/project',
    taskPlan: plan,
    artifacts: [],
    conversations: [],
    fileChanges: changes,
    metadata: {},
    ...overrides,
  };
}

const CRITERIA = [
  'The requested files/features are created as described',
  'Existing functionality is not broken',
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ReviewerAgent — acceptance criteria (Session 20)', () => {
  it('includes the acceptance criteria section in the review prompt when metadata seeds them', async () => {
    let capturedPrompt = '';
    const callLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return '✅ Review passed. No issues found.\nPASS: The requested files/features are created as described\nPASS: Existing functionality is not broken';
    });

    const agent = new ReviewerAgent();
    const result = await agent.execute(
      makeContext({ metadata: { acceptanceCriteria: CRITERIA } }),
      callLLM,
    );

    expect(result.success).toBe(true);
    expect(capturedPrompt).toContain('## Acceptance Criteria');
    for (const criterion of CRITERIA) {
      expect(capturedPrompt).toContain(criterion);
    }
    expect(capturedPrompt).toContain('PASS: <criterion>');
    expect(capturedPrompt).toContain('FAIL: <criterion>');
  });

  it('blocks the review when a criterion verdict is FAIL', async () => {
    const callLLM = vi.fn(async () => {
      return '✅ Review passed. No issues found.\nPASS: Existing functionality is not broken\nFAIL: The requested files/features are created as described — missing edge case';
    });

    const agent = new ReviewerAgent();
    const result = await agent.execute(
      makeContext({ metadata: { acceptanceCriteria: CRITERIA } }),
      callLLM,
    );

    expect(result.success).toBe(false);
    expect(result.summary).toContain('critical issues');
  });

  it('omits the criteria section when metadata has none (backward compatible)', async () => {
    let capturedPrompt = '';
    const callLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return '✅ Review passed. No issues found.';
    });

    const agent = new ReviewerAgent();
    const result = await agent.execute(makeContext(), callLLM);

    expect(result.success).toBe(true);
    expect(capturedPrompt).not.toContain('## Acceptance Criteria');
  });

  it('still passes a clean review without criteria verdicts', async () => {
    const callLLM = vi.fn(async () => '✅ Review passed. No issues found.');

    const agent = new ReviewerAgent();
    const result = await agent.execute(
      makeContext({ metadata: { acceptanceCriteria: CRITERIA } }),
      callLLM,
    );

    expect(result.success).toBe(true);
  });
});

describe('ReviewerAgent — rate-limit recovery (eval 429 fix)', () => {
  const RATE_LIMIT_ERROR =
    'Groq API error (429): {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` ' +
    'in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 12000, ' +
    'Used 11036, Requested 4597. Please try again in 18.165s."}}';

  it('waits out a transient reset hint via onRateLimit and succeeds (no naive 1s backoff)', async () => {
    vi.useFakeTimers();
    try {
      const callLLM = vi.fn()
        .mockImplementationOnce(async () => { throw new Error(RATE_LIMIT_ERROR); })
        .mockImplementationOnce(async () => '✅ Review passed. No issues found.');
      const onRateLimit = vi.fn(async () => ({ action: 'retry' } as const));

      const agent = new ReviewerAgent();
      const execPromise = agent.execute(makeContext({ onRateLimit }), callLLM);
      // Let the 429 surface and the handler resolve, then advance past the
      // 18.2s reset window — the retry must NOT fire inside it.
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await execPromise;

      expect(onRateLimit).toHaveBeenCalledTimes(1);
      expect(onRateLimit.mock.calls[0][0].retryAfterMs).toBeGreaterThanOrEqual(18_000);
      expect(onRateLimit.mock.calls[0][0].agentName).toBe('Reviewer');
      expect(callLLM).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the handler-provided LLM after a switch-model action', async () => {
    vi.useFakeTimers();
    try {
      const switchedLLM = vi.fn(async () => '✅ Review passed. No issues found.');
      const failingLLM = vi.fn(async () => {
        throw new Error('Rate limit reached — please try again in 5.0s');
      });
      const onRateLimit = vi.fn(async () => ({
        action: 'switch-model' as const,
        callLLM: switchedLLM,
      }));

      const agent = new ReviewerAgent();
      const execPromise = agent.execute(makeContext({ onRateLimit }), failingLLM);
      await vi.advanceTimersByTimeAsync(2_000); // 500ms pause before retry
      const result = await execPromise;

      expect(onRateLimit).toHaveBeenCalledTimes(1);
      expect(failingLLM).toHaveBeenCalledTimes(1);
      expect(switchedLLM).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the review when the handler says abort', async () => {
    const callLLM = vi.fn(async () => {
      throw new Error('Rate limit reached — please try again in 10.0s');
    });
    const onRateLimit = vi.fn(async () => ({ action: 'abort' } as const));

    const agent = new ReviewerAgent();
    const result = await agent.execute(makeContext({ onRateLimit }), callLLM);

    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('aborted');
  });
});
