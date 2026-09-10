/**
 * C2 — LLM verify + entity extraction.
 *
 * When the C1 rule path is confident (≥ RULE_TRUST_THRESHOLD) the rule result
 * wins and NO model call happens. Only BELOW the threshold does the router-
 * selected cheap model get ONE structured JSON call to confirm intent and
 * extract entities — the deterministic fast-path stays zero-cost (the plan's
 * "deterministic fast-path first, LLM verify only on ambiguity").
 *
 * Tool-schema discipline:
 * - The extraction schema is declared ONCE in `src/nlu/schema.ts` (zod + JSON
 *   schema) and validated with safeParse — no per-prompt hack-parsing.
 * - Parse strategies mirror failure-lessons (`tryParseArray`): ```json code
 *   block → direct JSON → greedy first-{ last-} slice.
 * - Provider fallback: if the LLM call fails OR returns unparseable/invalid
 *   JSON, we return the RULE result and log the miss — never a guess, never a
 *   crash. The caller's fallback chain (router) decides whether to retry.
 *
 * Entities are extracted two ways and merged:
 * - Deterministic (always, zero network): file paths, temporal refs via the C1
 *   recognizer, framework/keyword hints. Project id is resolved lazily from
 *   cwd via the A2 `deriveProjectId` (git slug / cwd hash) — same dynamic-
 *   import pattern as memory-integration.
 * - LLM (only on verify): richer frameworks/keywords/memoryHint.
 * Deterministic project/timeRange win over the LLM's (the machine's values
 * are ground truth; the model's are hints).
 */
import type { LLMCallFn } from '../agents/agent.js';
import { classifyIntent, extractTimeRange, RULE_TRUST_THRESHOLD, type IntentResult, type ModeHint, type NluIntent, type TimeRange } from './intent.js';
import { type NluEntities, type VerifyResponse } from './schema.js';
/**
 * Resolved intent → pipeline hint. THE single mapping (mirrors C1's rule
 * returns); the LLM path derives modeHint from the RESOLVED intent so intent
 * and modeHint never diverge (reviewer-caught: inheriting the pre-verify rule's
 * modeHint broke the C3 action-map invariant when the LLM overrode the intent).
 */
export declare const MODE_HINT_BY_INTENT: Record<NluIntent, ModeHint | null>;
/** The verified result: rule result, enriched by entities (and optionally LLM). */
export interface VerifiedIntent {
    intent: NluIntent;
    /** 0–1. 0 = unknown — the caller decides (C3 threshold). */
    confidence: number;
    modeHint: ModeHint | null;
    /** Merged entities (deterministic always + LLM when verified). */
    entities: NluEntities;
    /** One-line prior-context hint (LLM-only, optional). */
    memoryHint?: string;
    /** Convenience: entities.timeRange (recognizer or LLM). */
    timeRange?: TimeRange;
    /** Which path produced this result. */
    source: 'rule' | 'llm' | 'rule-fallback';
}
/**
 * Deterministic entity extraction — pure, synchronous, zero network.
 * Always runs; the LLM only enriches below the trust threshold.
 *
 * @param text      The user request.
 * @param projectId Optional pre-resolved project id (A2 `deriveProjectId().id`).
 *                  Resolved lazily by `verifyIntent` when cwd is provided.
 */
export declare function extractDeterministicEntities(text: string, projectId?: string): NluEntities;
/**
 * Verify a below-threshold rule result with ONE structured LLM call.
 * Returns the merged VerifiedIntent. NEVER throws — on any failure (LLM error,
 * unparseable JSON, schema violation) it returns the rule result with
 * `source: 'rule-fallback'` and logs the miss (mirrors failure-lessons).
 *
 * @param ruleResult The C1 rule result (below RULE_TRUST_THRESHOLD).
 * @param callLLM    LLM function (the caller supplies a router-cheap model).
 * @param cwd        Optional cwd for the deterministic project entity
 *                   (A2 `deriveProjectId` — git slug / cwd hash).
 */
export declare function verifyIntent(text: string, ruleResult: IntentResult, callLLM: LLMCallFn, cwd?: string): Promise<VerifiedIntent>;
/**
 * Parse + validate the LLM's structured response. Mirrors failure-lessons
 * `tryParseArray`: ```json code block → direct JSON → greedy first-{ last-}
 * slice. Returns null when nothing parses to a schema-valid VerifyResponse.
 */
export declare function parseVerifyResponse(raw: string): VerifyResponse | null;
/**
 * Full C2 pipeline for a request: classify with C1 rules, then verify only
 * when below the trust threshold. This is the function C3's parser calls.
 *
 * @param text    The user request.
 * @param callLLM LLM function for the verify call (router-cheap model).
 * @param cwd     Optional cwd for the project entity.
 */
export declare function analyzeRequest(text: string, callLLM: LLMCallFn, cwd?: string): Promise<VerifiedIntent>;
export { classifyIntent, extractTimeRange, RULE_TRUST_THRESHOLD };
export type { IntentResult, NluIntent };
//# sourceMappingURL=entities.d.ts.map