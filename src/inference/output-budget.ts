/**
 * Learned output budgets — "this pair needs more room than the default".
 *
 * A truncated step is EVIDENCE: the provider said `finish_reason: 'length'`, so
 * the model did not fail — it ran out of tokens. Re-asking it with the SAME cap
 * is how a working reasoning model gets stuck in a loop of empty answers and then
 * replaced. The adapter therefore remembers the cap it was given for that exact
 * pair and raises the floor on the next call, up to a bounded ceiling.
 *
 * Why here and not in the tool loop: the loop decides WHETHER to retry, but only
 * the adapter builds the request. Keeping the escalation at the request boundary
 * means every path benefits (chat tools, execute tools, streaming, plain
 * generate) without threading a token budget through four call signatures.
 *
 * WHY IN MEMORY, WITH A TTL. The evidence is about the current workload (a long
 * agent turn), not a permanent property of the model — a model that needed 8K for
 * one reasoning step serves short answers with 2K all day. A 30-minute TTL keeps
 * the escalation where it was earned and lets a fresh process start clean.
 */

import { escalatedOutputBudget, MAX_ESCALATED_OUTPUT_TOKENS } from '../learning/empty-completion.js';

/** How long a learned floor applies (ms). */
export const OUTPUT_BUDGET_TTL_MS = 30 * 60 * 1000;

interface LearnedBudget {
  maxTokens: number;
  expiresAt: number;
}

const learned = new Map<string, LearnedBudget>();

function keyOf(provider: string, model: string): string {
  return `${provider}|${model}`;
}

/**
 * Record that `provider/model` hit its output cap at `usedMaxTokens`, and return
 * the raised budget its next request should use.
 */
export function noteOutputBudgetExhausted(provider: string, model: string, usedMaxTokens?: number): number {
  const next = escalatedOutputBudget(usedMaxTokens);
  const current = learned.get(keyOf(provider, model));
  const maxTokens = Math.min(
    MAX_ESCALATED_OUTPUT_TOKENS,
    Math.max(next, current && current.expiresAt > Date.now() ? current.maxTokens : 0),
  );
  learned.set(keyOf(provider, model), { maxTokens, expiresAt: Date.now() + OUTPUT_BUDGET_TTL_MS });
  return maxTokens;
}

/** The floor a pair has earned, if any and not expired. */
export function rememberedOutputBudget(provider: string, model: string): number | undefined {
  const entry = learned.get(keyOf(provider, model));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    learned.delete(keyOf(provider, model));
    return undefined;
  }
  return entry.maxTokens;
}

/** Test hook: forget every learned floor. */
export function clearOutputBudgetMemory(): void {
  learned.clear();
}
