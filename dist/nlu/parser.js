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
import { classifyIntent } from './intent.js';
import { analyzeRequest, extractDeterministicEntities } from './entities.js';
import { resolveAction } from './actions.js';
// ─── Entry points ───────────────────────────────────────────────────────────
/**
 * Deterministic parse — rule-only, zero network, <5ms. The hot path every
 * action command uses for menu gates and routing seeds. Entities are
 * deterministic only (no cwd/project resolution — kept import-light and sync).
 */
export function parseRequestSync(text) {
    const rule = classifyIntent(text);
    const action = resolveAction(rule.intent);
    return {
        intent: rule.intent,
        confidence: rule.confidence,
        entities: extractDeterministicEntities(text),
        action,
        mode: action.mode,
        source: 'rule',
    };
}
/**
 * Full parse — C2 LLM verify runs ONLY when the rule result is below the
 * trust threshold; otherwise identical to `parseRequestSync` at zero cost.
 * Same ParsedRequest shape as the sync path (drop-in at the dispatch site).
 *
 * @param callLLM LLM function for the verify call (router-cheap model).
 * @param cwd     Optional cwd for the deterministic project entity.
 */
export async function parseRequest(text, callLLM, cwd) {
    const verified = await analyzeRequest(text, callLLM, cwd);
    const action = resolveAction(verified.intent);
    return {
        intent: verified.intent,
        confidence: verified.confidence,
        entities: verified.entities,
        action,
        mode: action.mode,
        memoryHint: verified.memoryHint,
        source: verified.source,
    };
}
//# sourceMappingURL=parser.js.map