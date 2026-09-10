/**
 * E3b — `verify_requirement` tool (the C2 requirementState check as a
 * reusable tool).
 *
 * Runs the shared NLU parse (rule fast-path; C2 LLM verify below the trust
 * threshold when a callLLM is available) and reports whether the request is
 * complete enough to act on:
 * - complete (rule confidence ≥ RULE_TRUST_THRESHOLD, or LLM says so), or
 * - needs-clarification with the exact missing info — the trigger for the
 *   model to call `ask_user` next (E3b acceptance: "no pipeline runs between
 *   the ask and the answer").
 *
 * The requirement-state discipline — the agent never acts on a
 * half-understood request.
 */
import { parseRequestSync, parseRequest } from '../nlu/parser.js';
import { RULE_TRUST_THRESHOLD } from '../nlu/intent.js';
/** The C2 requirementState check — see registry.ts verify_requirement tool. */
export async function verifyRequirementTool(request, ctx) {
    const state = await assessRequirement(request, ctx);
    return [
        `requirementState: ${state.state}`,
        `intent: ${state.intent}`,
        `confidence: ${Math.round(state.confidence * 100)}%`,
        ...(state.missingInfo.length > 0 ? [`missingInfo: ${state.missingInfo.join('; ')}`] : []),
    ].join('\n');
}
/** Assess completeness — rule path first, LLM verify below the threshold. */
export async function assessRequirement(request, ctx) {
    const parsed = parseRequestSync(request);
    // Rule path is trusted (or LLM verify unavailable) — report the rule state.
    if (parsed.confidence >= RULE_TRUST_THRESHOLD || !ctx.callLLM) {
        return {
            state: parsed.intent === 'unknown' ? 'needs-clarification' : 'complete',
            intent: parsed.intent,
            confidence: parsed.confidence,
            // Only unknown intents carry missing info on the rule path — a create
            // request legitimately has no existing files to scope, so "which
            // files" must never mark it incomplete.
            missingInfo: parsed.intent === 'unknown' ? ['what exactly should be done'] : [],
        };
    }
    // C2 LLM verify — enriches intent + reports memoryHint as missing info.
    try {
        const verified = await parseRequest(request, ctx.callLLM);
        return {
            state: verified.confidence >= RULE_TRUST_THRESHOLD ? 'complete' : 'needs-clarification',
            intent: verified.intent,
            confidence: verified.confidence,
            missingInfo: verified.memoryHint ? [verified.memoryHint] : ['what exactly should be done'],
        };
    }
    catch {
        // LLM verify failed — rule result stands (never a guess).
        return {
            state: parsed.intent === 'unknown' ? 'needs-clarification' : 'complete',
            intent: parsed.intent,
            confidence: parsed.confidence,
            missingInfo: parsed.intent === 'unknown' ? ['what exactly should be done'] : [],
        };
    }
}
//# sourceMappingURL=verify-requirement.js.map