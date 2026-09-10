/**
 * Session 20 — RequestContract layer (DESIGN_DECISIONS Decision 3:
 * "understanding-first — the user is never shown what
 * it understood; they just run").
 *
 * The contract makes understanding VISIBLE and VERIFIABLE:
 * - `buildRequestContract(goal)` resolves every request into a structured
 *   `{ goal, intent, action, target, scope, constraints, acceptanceCriteria,
 *   riskFlags }` contract — the same shape the Copilot parity review and the
 *   design doc call the "request contract".
 * - The rule path is deterministic and ZERO-cost (reuses the shared NLU
 *   parser; no extra model call). Only when the rule result is BELOW the
 *   trust threshold does the C2 LLM verify run (the SAME call `parseRequest`
 *   would make anyway) — the contract enriches from its result, never adding
 *   a second call.
 * - `renderContractCard(contract)` prints the 🧠 Understood card BEFORE the
 *   pipeline runs. It is display-only (fast-accept by default, never a
 *   blocking wizard) — the user always sees what the agent understood, and
 *   the pipeline starts immediately.
 * - `contract.acceptanceCriteria` feed the verification pass at pipeline end
 *   (reviewer prompt + VerifyModule goal-alignment), so "done" means the
 *   changes satisfy the contract, not just a loose goal match.
 */
import type { LLMCallFn } from '../agents/agent.js';
import { type ParsedRequest } from './parser.js';
import { type ModeHint, type NluIntent } from './intent.js';
/** The resolved understanding of a user request — drives display + verify. */
export interface RequestContract {
    /** The raw user request. */
    goal: string;
    /** Resolved intent (rule or LLM-verified). */
    intent: NluIntent;
    /** 0–1 confidence. */
    confidence: number;
    /** Tool-vocabulary action (build/resume/repair/assess/configure/ask). */
    action: string;
    /** Human action label for the card (create / continue / fix / …). */
    actionLabel: string;
    /** The pipeline that runs (dev / recall / execute / chat / config). */
    mode: ModeHint;
    /** What the request is ABOUT — files/projects mentioned. */
    target: string[];
    /** Which areas/tech the request touches (frameworks + keywords). */
    scope: string[];
    /** Explicit guardrails parsed from the text (e.g. "don't touch tests"). */
    constraints: string[];
    /**
     * Success criteria the verification pass checks the changes against.
     * Rule-derived per intent (zero cost); enriched by the LLM verify when it
     * already runs (below-threshold requests).
     */
    acceptanceCriteria: string[];
    /** Destructive / sensitive markers (deletes, overwrites, credentials…). */
    riskFlags: string[];
    /** Which path produced the contract. */
    source: 'rule' | 'llm' | 'rule-fallback';
}
/**
 * Resolve a user request into a structured contract.
 *
 * Rule path (default): deterministic parse + entity extraction, zero network,
 * zero extra model calls. The acceptance criteria are action-derived; target
 * and scope come from the parsed entities; risk flags come from a keyword
 * scan of the request.
 *
 * LLM enrichment: pass `callLLM` to enrich a BELOW-THRESHOLD request using
 * the SAME C2 verify call `parseRequest` makes (no second call). When the
 * rule result is already confident, no model call happens even with callLLM.
 *
 * @param goal    The user request.
 * @param opts    Optional callLLM (C2 verify reuse) + cwd (project entity).
 */
export declare function buildRequestContract(goal: string, opts?: {
    callLLM?: LLMCallFn;
    cwd?: string;
}): Promise<RequestContract>;
/**
 * Synchronous variant for call sites that must not await (display-only paths
 * where the rule contract is enough). Never performs a model call.
 */
export declare function buildRequestContractSync(goal: string): RequestContract;
/**
 * Build a contract from an ALREADY-PARSED request — the zero-reparse variant
 * for call sites that parsed the goal anyway (e.g. the pipeline tool). The
 * rule result is used directly; never performs a model call.
 */
export declare function contractFromParsed(goal: string, parsed: ParsedRequest, source?: RequestContract['source']): RequestContract;
/**
 * Render the compact 🧠 Understood card. Display-only — callers print it
 * before the pipeline starts (fast-accept by default, never a blocking
 * wizard). When the request has no target/scope/criteria the lines are
 * omitted so the card stays tight.
 *
 * @param opts
 *   - `footer`: replaces the default footer entirely (e.g. plan shows a
 *     plan-specific next step, not a pipeline claim).
 *   - `resumable`: when `false` (and no footer given), the footer drops the
 *     checkpoint claim so the card never overpromises resumability for runs
 *     that don't enable checkpoints.
 */
export declare function renderContractCard(contract: RequestContract, opts?: {
    footer?: string;
    resumable?: boolean;
}): string;
//# sourceMappingURL=contract.d.ts.map