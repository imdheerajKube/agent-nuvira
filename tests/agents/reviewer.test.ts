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
