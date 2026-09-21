/**
 * AGENT answer-quality gate — an agent reply that is the model's own TRACE is
 * retried ONCE with a corrective instruction, then left to the render sites.
 *
 * WHY THE ORCHESTRATOR NEEDS ITS OWN GATE. The loop engine (chat, `nuvira
 * execute`, every pipeline run through the loop) rejects a reasoning/contract
 * reply at generation time — see `detectAnswerQualityFailure` in
 * `src/inference/tool-call-utils.ts`. The ORCHESTRATOR's agents do not go
 * through that loop: each one is handed its own `LLMCallFn` and calls
 * `provider.generate` directly, so nothing in that path ever asked "is this
 * addressed to the reader, or is this thinking?". Observed live (2026-09-21) as
 * an agent summary that was literally:
 *
 *   The user wants a project plan for a "multiple screen calculator and unit
 *   converter" with a GUI and cross-platform support.
 *
 *   I should use the `plan_todo` tool to create a structured plan.
 *
 * which the report then rendered as `• ✅ Reasoner: The user wants …`. The
 * render sites (`composePipelineReply`, `printOrchestrationResult`) already
 * salvage or suppress such a summary; this is the layer that tries to FIX it
 * rather than only hide it.
 *
 * WHY A WRAPPER AND NOT A CHECK INSIDE EVERY AGENT: the agent boundary is the
 * only place that is simultaneously (a) reached by every agent type — planner,
 * reasoner, writer, tester, debugger, and any strategy-selected substitute —
 * and (b) narrow enough that a retry cannot mis-fire on the orchestrator's
 * HOUSEKEEPING calls (file finding, memory summarisation, JSON extraction),
 * which build their own prompts from `createFileFinderLLM` and friends and are
 * deliberately NOT wrapped.
 *
 * WHY "RETURN THE ORIGINAL" AS THE LAST RESORT: if the corrective retry also
 * narrates, the honest thing is not to invent a nicer string — a downstream
 * consumer may be parsing this content, and the render sites suppress a traced
 * summary anyway. Returning the original keeps the failure visible where it can
 * be handled instead of hiding it one layer lower.
 */

import type { LLMCallFn } from './agent.js';
import { detectAnswerQualityFailure, stripReasoningLeak } from '../inference/tool-call-utils.js';
import { logger } from '../utils/logger.js';

/**
 * The corrective instruction appended to the ONE retry.
 *
 * Written as a direct correction of the observed failure mode (narrating the
 * conversation to itself) rather than a restatement of the output format: the
 * live traces were not format violations, they were the model addressing the
 * wrong reader.
 */
export const ANSWER_QUALITY_CORRECTION = [
  '',
  '',
  'IMPORTANT — your previous reply described your own reasoning, planning, or the instructions you were given instead of producing the result.',
  'Reply with the RESULT itself, addressed to the reader. Do not mention the user, the conversation, these instructions, or what you intend to do next.',
].join('\n');

export interface AnswerQualityGateMeta {
  /** Agent label for the log line (e.g. `writer`, `Reasoner`, `planner`). */
  agent: string;
  /** Task id, when the caller has one — keeps the warning correlatable. */
  taskId?: string;
}

/** Human wording for the log line, shared by both call sites. */
function describeFailure(kind: 'confusion' | 'reasoning'): string {
  return kind === 'reasoning' ? 'its own reasoning' : 'tool-contract confusion';
}

/**
 * Wrap an agent's LLM call so a traced reply is never treated as the agent's
 * deliverable.
 *
 * Strictly ADDITIVE: a reply that is not a quality failure is returned
 * untouched after exactly one underlying call, so the normal path costs nothing
 * (no extra latency, no extra tokens). Only a detected failure pays for the
 * single corrective retry.
 */
export function withAgentAnswerQualityGate(
  callLLM: LLMCallFn,
  meta: AnswerQualityGateMeta,
): LLMCallFn {
  const where = meta.taskId ? `${meta.agent}/${meta.taskId}` : meta.agent;
  return async (prompt, options) => {
    const first = await callLLM(prompt, options);
    const failure = detectAnswerQualityFailure(first);
    if (!failure) return first;

    logger.warn(
      `      ⚠️ ${where} answered with ${describeFailure(failure.kind)} instead of the result — retrying once with a corrective instruction.`,
    );
    try {
      const retry = await callLLM(prompt + ANSWER_QUALITY_CORRECTION, options);
      if (retry.trim() && !detectAnswerQualityFailure(retry)) return retry;
      logger.warn(`      ⚠️ ${where} narrated again on the corrective retry — leaving the raw reply for the report to handle.`);
    } catch (err) {
      // A failed RETRY must never turn a bad-but-answerable task into an
      // exception the agent never sees: the caller's error handling belongs to
      // the real call, which already returned.
      logger.warn(
        `      ⚠️ ${where} corrective retry failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      );
    }

    // Both attempts narrated. Deliver the salvageable part when there is one
    // (two of the three live traces had a real answer BEHIND the trace), and
    // otherwise the original text — never an invented placeholder.
    const salvaged = stripReasoningLeak(first);
    return salvaged.trim() ? salvaged : first;
  };
}
