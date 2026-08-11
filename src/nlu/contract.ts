/**
 * Session 20 — RequestContract layer (DESIGN_DECISIONS Decision 3:
 * "understanding-first — neither Freebuff nor Hermes ever shows the user what
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
import { parseRequestSync, parseRequest, type ParsedRequest } from './parser.js';
import { RULE_TRUST_THRESHOLD, type ModeHint, type NluIntent } from './intent.js';
import type { NluEntities } from './schema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Action vocabulary (mirrors the C3 action map labels) ───────────────────

const ACTION_LABEL: Record<string, string> = {
  build: 'create',
  resume: 'continue',
  repair: 'fix',
  assess: 'explain',
  configure: 'configure',
  ask: 'help',
};

/** Default acceptance criteria per intent — deterministic, zero cost. */
const CRITERIA_BY_INTENT: Record<NluIntent, string[]> = {
  create: [
    'The requested files/features are created as described',
    'Existing functionality is not broken',
    'The code is syntactically valid',
  ],
  fix: [
    'The reported problem is resolved',
    'No regressions in surrounding code',
    'The fix is verifiable (tests or a clear repro)',
  ],
  continue: [
    'Prior work is preserved',
    'The remaining steps complete the goal',
  ],
  explain: [
    'The answer is accurate and grounded in the project',
  ],
  configure: [
    'The configuration is valid and applied',
  ],
  unknown: [],
};

/** Keyword → risk flag pairs (deterministic scan on the request text). */
const RISK_RULES: Array<{ re: RegExp; flag: string }> = [
  { re: /\b(delete|remove|rm(?!\.)|drop|purge)\b/i, flag: 'deletes or removes files' },
  { re: /\b(overwrite|replace|rewrite|wipe)\b/i, flag: 'overwrites existing files' },
  { re: /\b(api\s*key|token|secret|password|credential|private\s*key)\b/i, flag: 'touches credentials or secrets' },
  { re: /\b(commit|push|publish|release|tag)\b/i, flag: 'writes to git history or publishes' },
  { re: /\b(migrat(e|ion)|schema\s*change)\b/i, flag: 'database or schema migration' },
  { re: /\b(force|--force)\b/i, flag: 'force operation' },
];

// ─── Builder ────────────────────────────────────────────────────────────────

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
export async function buildRequestContract(
  goal: string,
  opts?: { callLLM?: LLMCallFn; cwd?: string },
): Promise<RequestContract> {
  const parsed = parseRequestSync(goal);

  // LLM enrichment ONLY below the trust threshold (and only when a callLLM is
  // available) — the shared C2 verify call, never an extra one.
  let effective: ParsedRequest = parsed;
  let source: RequestContract['source'] = 'rule';
  if (opts?.callLLM && parsed.confidence < RULE_TRUST_THRESHOLD) {
    try {
      const verified = await parseRequest(goal, opts.callLLM, opts.cwd);
      effective = verified;
      source = verified.source === 'rule-fallback' ? 'rule-fallback' : 'llm';
    } catch {
      // Rule result stands — the contract never crashes over enrichment.
      source = 'rule-fallback';
    }
  }

  return contractFromParsed(goal, effective, source);
}

/**
 * Synchronous variant for call sites that must not await (display-only paths
 * where the rule contract is enough). Never performs a model call.
 */
export function buildRequestContractSync(goal: string): RequestContract {
  return contractFromParsed(goal, parseRequestSync(goal), 'rule');
}

/**
 * Build a contract from an ALREADY-PARSED request — the zero-reparse variant
 * for call sites that parsed the goal anyway (e.g. the pipeline tool). The
 * rule result is used directly; never performs a model call.
 */
export function contractFromParsed(
  goal: string,
  parsed: ParsedRequest,
  source: RequestContract['source'] = 'rule',
): RequestContract {
  return buildContract(goal, parsed, source);
}

function buildContract(
  goal: string,
  parsed: ParsedRequest,
  source: RequestContract['source'],
): RequestContract {
  const entities = parsed.entities ?? emptyEntities();

  // Target = files mentioned + project hint; scope = frameworks + keywords.
  const target = [...new Set([
    ...(entities.files || []),
    ...(entities.project ? [entities.project] : []),
  ])].slice(0, 4);
  const scope = [...new Set([
    ...(entities.frameworks || []),
    ...(entities.keywords || []),
  ])].slice(0, 6);

  return {
    goal,
    intent: parsed.intent,
    confidence: parsed.confidence,
    action: parsed.action.name,
    actionLabel: ACTION_LABEL[parsed.action.name] ?? parsed.action.name,
    mode: parsed.mode,
    target,
    scope,
    constraints: extractConstraints(goal),
    acceptanceCriteria: CRITERIA_BY_INTENT[parsed.intent] ?? [],
    riskFlags: extractRiskFlags(goal),
    source,
  };
}

// ─── Deterministic extraction helpers ───────────────────────────────────────

/** Explicit guardrail phrasing parsed from the text (deterministic). */
function extractConstraints(goal: string): string[] {
  const constraints: string[] = [];
  const m = goal.match(
    /\b(?:don'?t|do not|without|avoid|never|keep|preserve)\s+([^.,;!?]+)/i,
  );
  if (m && m[1].trim()) constraints.push(`Do not ${m[1].trim().toLowerCase()}`);
  return constraints.slice(0, 3);
}

/** Destructive / sensitive markers found in the request text. */
function extractRiskFlags(goal: string): string[] {
  return RISK_RULES.filter(({ re }) => re.test(goal)).map(({ flag }) => flag);
}

function emptyEntities(): NluEntities {
  return { files: [], frameworks: [], keywords: [] };
}

// ─── Card rendering (the 🧠 Understood display) ─────────────────────────────

/** One-line pipeline description for the card. */
const MODE_LABEL: Record<string, string> = {
  dev: 'generating new code, files or features',
  recall: 'picking up prior work',
  execute: 'running the coding pipeline',
  chat: 'answering directly (no file writes)',
  config: 'applying configuration',
};

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
export function renderContractCard(
  contract: RequestContract,
  opts?: { footer?: string; resumable?: boolean },
): string {
  const lines: string[] = [];
  const pct = Math.round(contract.confidence * 100);
  lines.push(
    `🧠 Understood (${pct}%): ${contract.actionLabel} — ${MODE_LABEL[contract.mode] ?? 'running the pipeline'}`,
  );

  if (contract.target.length > 0) {
    lines.push(`  target:  ${contract.target.join(', ')}`);
  }
  if (contract.scope.length > 0) {
    lines.push(`  scope:   ${contract.scope.join(' · ')}`);
  }
  if (contract.constraints.length > 0) {
    lines.push(`  guard:   ${contract.constraints.join(' · ')}`);
  }
  if (contract.acceptanceCriteria.length > 0) {
    lines.push(
      `  criteria:${contract.acceptanceCriteria.map((c) => `\n    • ${c}`).join('')}`,
    );
  }
  lines.push(
    `  risks:   ${contract.riskFlags.length > 0 ? contract.riskFlags.join(', ') : 'none'}`,
  );
  lines.push(
    opts?.footer ??
      (opts?.resumable === false
        ? '→ Running the pipeline — you can interrupt anytime.'
        : '→ Running the coding pipeline — you can interrupt anytime; checkpoints keep it resumable.'),
  );
  return lines.join('\n');
}
