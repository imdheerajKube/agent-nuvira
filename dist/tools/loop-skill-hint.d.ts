/**
 * Loop skill hint (`src/tools/loop-skill-hint.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 3.2: "The loop never hears about the orchestrator's skill
 * layer: the pipeline consults SkillStore.findMatch + the hub catalog before
 * planning and injects the matched methodology, but a chat/execute-loop goal
 * starts with zero knowledge that a first-party playbook exists."
 *
 * This module closes that parity gap DETERMINISTICALLY (no LLM call): given
 * the user's goal, it finds the best available skill the SAME way the
 * orchestrator does —
 *
 *   1. compiled SkillStore.findMatch (the first-party capability batch),
 *   2. the hub catalog (findHubSkillMatch — installed SKILL.md skills),
 *
 * then returns a system-prompt block that hands the model the skill's
 * methodology with an EXPLICIT escape hatch ("this is a recommendation —
 * ignore it when it does not fit") and the exact load syntax
 * (`skill` tool, {"skill":"<name>"}).
 *
 * Why an evidence filter on top of findMatch: the compiled store's threshold
 * is intentionally low (score >= 1, "manual discovery") and its scoring adds
 * a quality/usage bonus to EVERY skill — so a goal merely containing a generic
 * pattern word ("goal", "task") can false-positive. The chat loop runs on
 * EVERY message (not just pipeline goals), so the loop hint requires REAL
 * goal evidence: a name-word or tag hit, or two pattern-word hits. The
 * orchestrator does not need this (its planner only sees pipeline goals); the
 * hub catalog's own scoring is keyword-based and needs no filter.
 *
 * Safety rails (mirroring the orchestrator's injection contract):
 *   - skills.disabled[] gate — a dashboard/CLI-disabled skill is NEVER
 *     injected (the same "the toggle is never cosmetic" rule the match gates
 *     enforce elsewhere).
 *   - Website-deploy activation gate — the orchestrator requires
 *     hosting-specific intent before injecting website methodology; the loop
 *     hint applies the identical regex so "deploy the API" does not drag in
 *     static-site deployment steps.
 *   - Side-effect-free matching: the match itself marks nothing; usage is
 *     marked ONCE via markLoopSkillUsed by the caller (skillView()'s internal
 *     markUsed is deliberately avoided so the hint builder is idempotent).
 *   - Bounded injection: at most ONE methodology block per prompt, and the
 *     methodology text itself is capped (compiled: 8 steps; hub: 2000 chars)
 *     so a crowded catalog cannot balloon the system prompt.
 *   - Best-effort by construction: any store/catalog failure returns '' /
 *     null and the turn proceeds exactly as before (a hint must never break
 *     a turn).
 *
 * Consumers: chat's runChatAnswer (system prompt) and the execute loop's
 * runLoopExecutor — the two runToolLoop callers that had no skill knowledge.
 */
import type { ConfigManager } from '../config/manager.js';
/**
 * The match the hint was built from (echoed to callers for telemetry/tests).
 * `null` = no match (no skill scored, or it was gated out).
 */
export interface LoopSkillHintMatch {
    name: string;
    id: string;
    source: 'compiled' | 'hub';
}
/**
 * Did the goal show REAL evidence for this skill — a name-word hit, a tag
 * hit, or two pattern-word hits (meta-words excluded)? Guards the compiled
 * store's intentionally loose threshold: findMatch adds a quality/usage bonus
 * to every skill, so a generic word like "goal" alone must never inject
 * methodology into a chat turn. Deterministic, no LLM.
 */
export declare function hasRealGoalEvidence(goal: string, skill: {
    name: string;
    tags: string[];
    goalPattern: string;
}): boolean;
/**
 * Find the best skill for the goal across BOTH sources the orchestrator
 * consults, honoring the disabled + website-deploy activation gates (+ the
 * compiled evidence filter). Compiled wins ties (its id is the deterministic
 * seed id). Returns null when nothing matches (never a forced match).
 */
export declare function findLoopSkillMatch(goal: string, cm?: ConfigManager): Promise<LoopSkillHintMatch | null>;
/**
 * Build the system-prompt block for a matched skill, or '' when there is no
 * match. The block follows the orchestrator's injection contract:
 *
 *   - the skill is a RECOMMENDATION, the model still owns the plan (the
 *     orchestrator's "model-selected activation" phrasing),
 *   - the methodology rides in as Level-2 content (progressive disclosure —
 *     the model sees the steps without paying a tool call for them),
 *   - the exact load syntax is included so the model can refresh/parameterize
 *     via the `skill` tool mid-turn,
 *   - ONE block max (bounded system-prompt growth).
 *
 * Marks nothing: usage tracking belongs to markLoopSkillUsed (the caller
 * decides when a match actually got USED — i.e. was injected).
 *
 * @param goal       the user's goal text (matched against skill triggers)
 * @param cm         ConfigManager for the disabled-skills gate (optional)
 * @param injected   out-param: when provided, receives the match that was
 *                   injected (null when none).
 */
export declare function buildLoopSkillHint(goal: string, cm?: ConfigManager, injected?: {
    value: LoopSkillHintMatch | null;
}): Promise<string>;
/**
 * Mark an injected skill as used (usage tracking parity with the orchestrator
 * — compiled skills only; hub skills have no compiled usage counter). The
 * SINGLE usage marker for the loop hint path (the hint builder never marks).
 * Best-effort, fire-and-forget: never throws, never awaited by callers on the
 * hot path.
 */
export declare function markLoopSkillUsed(match: LoopSkillHintMatch | null): Promise<void>;
//# sourceMappingURL=loop-skill-hint.d.ts.map