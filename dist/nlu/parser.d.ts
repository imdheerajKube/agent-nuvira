/**
 * C3 — Unified request parser.
 *
 * `parseRequestSync(text)` — the deterministic fast path (rule-only, zero
 * network, <5ms budget): C1 classifyIntent → deterministic entities → action
 * map. This is what every action command's hot path consumes (menu gates,
 * routing seeds).
 *
 * `parseRequest(text, callLLM, cwd?)` — the full path: C2 LLM verify (only
 * below the trust threshold) + entity merge. Same ParsedRequest shape, so the
 * two paths are drop-in interchangeable at the dispatch site.
 *
 * `ParsedRequest.mode` is NEVER null: `ask` (the unknown-intent action) fills
 * the gap, so dispatch code has a total pipeline hint to switch on — the
 * action map is total by construction (C3 acceptance b: one schema, two
 * consumption paths).
 */
import type { LLMCallFn } from '../agents/agent.js';
import { type ModeHint, type NluIntent } from './intent.js';
import type { NluEntities } from './schema.js';
import { type ActionDescriptor } from './actions.js';
/** The unified parse output consumed by chat, execute, plan and edit. */
export interface ParsedRequest {
    /** The resolved intent (rule or LLM-verified). */
    intent: NluIntent;
    /** 0–1. Below the trust threshold the caller should NOT hard-dispatch. */
    confidence: number;
    /** Merged entities (deterministic always; LLM enriches below threshold). */
    entities: NluEntities;
    /** The action descriptor this request maps to (never undefined). */
    action: ActionDescriptor;
    /** The pipeline that runs — derived from action, never null. */
    mode: ModeHint;
    /** One-line prior-context hint (LLM-only, optional). */
    memoryHint?: string;
    /** Which path produced this result. */
    source: 'rule' | 'llm' | 'rule-fallback';
}
/**
 * Deterministic parse — rule-only, zero network, <5ms. The hot path every
 * action command uses for menu gates and routing seeds. Entities are
 * deterministic only (no cwd/project resolution — kept import-light and sync).
 */
export declare function parseRequestSync(text: string): ParsedRequest;
/**
 * Full parse — C2 LLM verify runs ONLY when the rule result is below the
 * trust threshold; otherwise identical to `parseRequestSync` at zero cost.
 * Same ParsedRequest shape as the sync path (drop-in at the dispatch site).
 *
 * @param callLLM LLM function for the verify call (router-cheap model).
 * @param cwd     Optional cwd for the deterministic project entity.
 */
export declare function parseRequest(text: string, callLLM: LLMCallFn, cwd?: string): Promise<ParsedRequest>;
//# sourceMappingURL=parser.d.ts.map