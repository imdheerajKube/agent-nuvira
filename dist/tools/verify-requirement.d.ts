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
import type { ToolContext } from './registry.js';
export interface RequirementState {
    state: 'complete' | 'needs-clarification';
    intent: string;
    confidence: number;
    /** The exact missing info (from LLM verify memoryHint, or rule heuristics). */
    missingInfo: string[];
}
/** The C2 requirementState check — see registry.ts verify_requirement tool. */
export declare function verifyRequirementTool(request: string, ctx: ToolContext): Promise<string>;
/** Assess completeness — rule path first, LLM verify below the threshold. */
export declare function assessRequirement(request: string, ctx: Pick<ToolContext, 'callLLM'>): Promise<RequirementState>;
//# sourceMappingURL=verify-requirement.d.ts.map