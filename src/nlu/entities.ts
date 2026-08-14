/**
 * C2 — LLM verify + entity extraction.
 *
 * When the C1 rule path is confident (≥ RULE_TRUST_THRESHOLD) the rule result
 * wins and NO model call happens. Only BELOW the threshold does the router-
 * selected cheap model get ONE structured JSON call to confirm intent and
 * extract entities — the deterministic fast-path stays zero-cost (the plan's
 * "deterministic fast-path first, LLM verify only on ambiguity").
 *
 * Mirrors Hermes tool-schema discipline:
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
import { logger } from '../utils/logger.js';

import {
  classifyIntent,
  extractTimeRange,
  RULE_TRUST_THRESHOLD,
  type IntentResult,
  type ModeHint,
  type NluIntent,
  type TimeRange,
} from './intent.js';
import {
  verifyResponseSchema,
  type NluEntities,
  type VerifyResponse,
} from './schema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Resolved intent → pipeline hint. THE single mapping (mirrors C1's rule
 * returns); the LLM path derives modeHint from the RESOLVED intent so intent
 * and modeHint never diverge (reviewer-caught: inheriting the pre-verify rule's
 * modeHint broke the C3 action-map invariant when the LLM overrode the intent).
 */
export const MODE_HINT_BY_INTENT: Record<NluIntent, ModeHint | null> = {
  create: 'dev',
  continue: 'recall',
  fix: 'execute',
  explain: 'chat',
  configure: 'config',
  write: 'chat',
  unknown: null,
};

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

// ─── Deterministic entity extraction (zero network) ─────────────────────────

/** Curated framework/keyword hints — a fast signal for routing + memory. */
const FRAMEWORK_HINTS = [
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'node', 'node.js',
  'typescript', 'javascript', 'python', 'django', 'flask', 'fastapi', 'go',
  'rust', 'java', 'spring', 'rails', 'laravel', 'php', 'docker', 'kubernetes',
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite', 'graphql',
  'jwt', 'oauth', 'tailwind', 'express', 'nest', 'nuxt', 'astro', 'solidity',
  'terraform', 'ansible', 'fastify', 'prisma', 'sequelize',
];

/** Heuristic file-path tokens (quoted, or containing a path separator + ext). */
const FILE_PATH_RE =
  /["'`]([\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|yml|yaml|toml|sh|css|html|sql|config|env|dart|rb|php|c|cpp|h))["'`]|([\w-]+\/[\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|yml|yaml|toml|sh|css|html|sql|config|env))/gi;

/**
 * Deterministic entity extraction — pure, synchronous, zero network.
 * Always runs; the LLM only enriches below the trust threshold.
 *
 * @param text      The user request.
 * @param projectId Optional pre-resolved project id (A2 `deriveProjectId().id`).
 *                  Resolved lazily by `verifyIntent` when cwd is provided.
 */
export function extractDeterministicEntities(
  text: string,
  projectId?: string,
): NluEntities {
  const entities: NluEntities = { files: [], frameworks: [], keywords: [] };

  // Project: caller-provided (A2 project id: `repo:owner/repo` or `cwd:<hash>`).
  if (projectId) entities.project = projectId;

  // File paths: quoted tokens or path-separator tokens with an extension.
  const files = new Set<string>();
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const hit = (match[1] || match[2] || '').trim();
    if (hit) files.add(hit);
  }
  entities.files = [...files].slice(0, 12);

  // Temporal refs: the C1 recognizer (deterministic, no model call).
  const timeRange = extractTimeRange(text);
  if (timeRange) entities.timeRange = timeRange;

  // Framework/keyword hints.
  const lower = text.toLowerCase();
  for (const hint of FRAMEWORK_HINTS) {
    if (new RegExp(`\\b${hint.replace(/\./g, '\\.')}\\b`).test(lower)) {
      entities.frameworks.push(hint);
    }
  }
  entities.frameworks = [...new Set(entities.frameworks)].slice(0, 8);

  return entities;
}

// ─── LLM verify ─────────────────────────────────────────────────────────────

const VERIFY_PROMPT = `You are a request-understanding layer for a developer coding agent. Classify the user's request and extract entities as STRICT JSON.

The request is one of these intents:
- "create" — build/generate/write NEW code, files, projects, plugins, addons
- "continue" — resume/pick up prior work ("continue", "resume", "pick up where I left off")
- "fix" — repair a bug, debug, resolve an error
- "explain" — answer a question, explain how something works, walk me through
- "configure" — set up api keys, switch providers/models, change config
- "unknown" — anything not clearly one of the above

Return ONLY a JSON object matching EXACTLY this shape (no markdown fences, no commentary):
{
  "intent": "create" | "continue" | "fix" | "explain" | "configure" | "unknown",
  "confidence": 0.0,
  "entities": {
    "files": ["path-like tokens from the request"],
    "frameworks": ["framework or tech keywords"],
    "keywords": ["other notable keywords"]
  },
  "memoryHint": "one short sentence on what prior context would help (optional)"
}

User request: {{REQUEST}}`;

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
export async function verifyIntent(
  text: string,
  ruleResult: IntentResult,
  callLLM: LLMCallFn,
  cwd?: string,
): Promise<VerifiedIntent> {
  // Project id is resolved lazily (dynamic import, memory-integration pattern)
  // only when cwd is provided — the pure rule path stays import-light.
  let projectId: string | undefined;
  if (cwd) {
    try {
      const { deriveProjectId } = await import('../config/workspace.js');
      projectId = deriveProjectId(cwd).id;
    } catch {
      // Best-effort — project detection must never break extraction.
    }
  }
  const deterministic = extractDeterministicEntities(text, projectId);

  // Fast path: rule is already confident — no model call at all.
  if (ruleResult.confidence >= RULE_TRUST_THRESHOLD) {
    return {
      ...ruleResult,
      entities: deterministic,
      timeRange: ruleResult.timeRange || deterministic.timeRange,
      source: 'rule',
    };
  }

  const prompt = VERIFY_PROMPT.replace('{{REQUEST}}', text);
  let response: string;
  try {
    response = await callLLM(prompt, { temperature: 0, maxTokens: 512 });
  } catch (err) {
    logger.debug(`NLU verify LLM call failed — using rule result: ${err}`);
    return {
      ...ruleResult,
      entities: deterministic,
      timeRange: ruleResult.timeRange || deterministic.timeRange,
      source: 'rule-fallback',
    };
  }

  const parsed = parseVerifyResponse(response);
  if (!parsed) {
    logger.debug('NLU verify returned unparseable/invalid JSON — using rule result');
    return {
      ...ruleResult,
      entities: deterministic,
      timeRange: ruleResult.timeRange || deterministic.timeRange,
      source: 'rule-fallback',
    };
  }

  // Merge: deterministic project/timeRange are ground truth; the LLM enriches
  // files/frameworks/keywords and can raise intent confidence.
  const merged: NluEntities = {
    project: deterministic.project || parsed.entities.project,
    files: [
      ...new Set([
        ...(deterministic.files || []),
        ...(parsed.entities.files || []),
      ]),
    ].slice(0, 16),
    timeRange: deterministic.timeRange || parsed.entities.timeRange,
    frameworks: [
      ...new Set([
        ...(deterministic.frameworks || []),
        ...(parsed.entities.frameworks || []),
      ]),
    ].slice(0, 12),
    keywords: [...new Set(parsed.entities.keywords || [])].slice(0, 16),
  };

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    // Derive from the RESOLVED intent so intent and modeHint always agree
    // (the action map keys on intent; a stale rule hint would misroute).
    modeHint: MODE_HINT_BY_INTENT[parsed.intent],
    entities: merged,
    memoryHint: parsed.memoryHint,
    timeRange: merged.timeRange,
    source: 'llm',
  };
}

/**
 * Parse + validate the LLM's structured response. Mirrors failure-lessons
 * `tryParseArray`: ```json code block → direct JSON → greedy first-{ last-}
 * slice. Returns null when nothing parses to a schema-valid VerifyResponse.
 */
export function parseVerifyResponse(raw: string): VerifyResponse | null {
  const candidates: string[] = [];

  // Strategy 1: a ```json (or bare ```) code block — extract its contents.
  const blockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) candidates.push(blockMatch[1].trim());

  // Strategy 2: the whole trimmed response as direct JSON.
  candidates.push(raw.trim());

  // Strategy 3: greedy first-{ … last-} extraction (objects, not arrays).
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = verifyResponseSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Fall through to the next strategy
    }
  }
  return null;
}

// ─── Convenience ────────────────────────────────────────────────────────────

/**
 * Full C2 pipeline for a request: classify with C1 rules, then verify only
 * when below the trust threshold. This is the function C3's parser calls.
 *
 * @param text    The user request.
 * @param callLLM LLM function for the verify call (router-cheap model).
 * @param cwd     Optional cwd for the project entity.
 */
export async function analyzeRequest(
  text: string,
  callLLM: LLMCallFn,
  cwd?: string,
): Promise<VerifiedIntent> {
  const ruleResult = classifyIntent(text);
  return verifyIntent(text, ruleResult, callLLM, cwd);
}

// ─── Re-exports (one import for the NLU layer) ──────────────────────────────

export { classifyIntent, extractTimeRange, RULE_TRUST_THRESHOLD };
export type { IntentResult, NluIntent };
