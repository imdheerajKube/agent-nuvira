/**
 * `composePipelineReply` — the pipeline's chat-facing result.
 *
 * The gateway builds this from the STRUCTURED pipeline result (one verdict, one
 * labelled count pair, one line per agent). The orchestrator's AGENTS run their
 * own model calls, so unlike the loop engine they are not covered by the
 * generation-time quality gate — a leaked reasoning trace can still arrive as
 * an agent summary. Observed live in a real `nuvira execute` run:
 *
 *   Agent summary: "The user wants a project plan for a \"multiple screen
 *   calculator and unit converter\" … I should use the `plan_todo` tool to
 *   create a structured plan."
 *
 * A chat sender must not receive that as an agent's report line.
 */

import { describe, it, expect } from 'vitest';
import { composePipelineReply } from '../../src/gateway/registry.js';

/** Verbatim shape from the live run. */
const REASONING_SUMMARY = [
  'The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support.',
  '',
  'I should use the `plan_todo` tool to create a structured plan.',
].join('\n');

describe('composePipelineReply — agent summaries are sanitized', () => {
  it('never relays the model\'s working notes as an agent report line', () => {
    const reply = composePipelineReply({
      success: true,
      summary: '❌ Completed 2/3 tasks with some failures in 9.6s',
      structured: {
        tasksCompleted: 7,
        tasksTotal: 7,
        agentResults: [
          { agent: 'Reasoner', success: true, summary: REASONING_SUMMARY },
          { agent: 'Planner', success: true, summary: 'Created 7 task steps' },
        ],
      },
    });

    expect(reply).not.toContain('The user wants a project plan');
    expect(reply).not.toContain('plan_todo');
    expect(reply).toContain('Reasoner');
    expect(reply).toContain('no usable summary');
    // Real agent output is untouched.
    expect(reply).toContain('Created 7 task steps');
    // ONE verdict and ONE count pair — the pre-existing contract.
    expect(reply.startsWith('✅ Done — 7/7 steps completed · 2/2 agents ok')).toBe(true);
    expect(reply).not.toContain('❌ Completed 2/3 tasks');
  });

  it('strips a raw followups payload from an agent summary too', () => {
    const reply = composePipelineReply({
      success: true,
      summary: 'Done',
      structured: {
        tasksCompleted: 1,
        tasksTotal: 1,
        agentResults: [
          {
            agent: 'writer',
            success: true,
            summary:
              'Wrote the plan.\n\n**suggest_followups**\n```json\n{"followups":[{"prompt":"Next?"}]}\n```',
          },
        ],
      },
    });
    expect(reply).toContain('Wrote the plan.');
    expect(reply).not.toContain('suggest_followups');
    expect(reply).not.toContain('"followups"');
  });

  it('replaces a reasoning-only summary on the thrown path (no structured result)', () => {
    const reply = composePipelineReply({
      success: false,
      summary: `❌ Failed — ${REASONING_SUMMARY}`,
    });
    expect(reply).not.toContain('The user wants a project plan');
    expect(reply).not.toContain('plan_todo');
    expect(reply).toBe('❌ Failed — the model returned its own working notes instead of a result');
  });

  it('keeps a normal report intact', () => {
    const reply = composePipelineReply({
      success: false,
      summary: '❌ Failed — some steps failed',
      structured: {
        tasksCompleted: 0,
        tasksTotal: 7,
        agentResults: [{ agent: 'writer', success: false, summary: 'Repair budget exhausted (1 attempts)' }],
      },
    });
    expect(reply).toContain('❌ Failed — 0/7 steps completed · 0/1 agents ok');
    expect(reply).toContain('• ❌ writer: Repair budget exhausted (1 attempts)');
  });
});
