/**
 * C1 — NLU rule fast-path.
 *
 * Deterministic intent classification for developer requests. Pure rules only:
 * zero network, zero model calls, <5ms typical. Unknown inputs return
 * `confidence: 0` (never a guess) so the C2 LLM-verify path takes over.
 *
 * Mirrors the Freebuff/Hermes methodology (single dispatch loop, no user-facing
 * mode picker): the intent + modeHint resolved here is the vocabulary the C3
 * action map and the orchestrator pipeline consume, so intent resolution and
 * tool dispatch share one source of truth.
 *
 * Temporal references ("last week", "yesterday", "2 days ago") are extracted
 * via `@microsoft/recognizers-text-date-time` — MIT, pure JS, no model call —
 * which alone covers the headline "continue last week's plan" case.
 */

import { recognizeDateTime, Culture } from '@microsoft/recognizers-text-date-time';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The intents C1 can resolve deterministically. */
export type NluIntent = 'create' | 'continue' | 'fix' | 'explain' | 'configure' | 'unknown';

/** The pipeline a resolved intent should run (C3 action-map key). */
export type ModeHint = 'dev' | 'recall' | 'execute' | 'chat' | 'config';

/** A temporal reference normalized from the recognizer. */
export interface TimeRange {
  /** The matched surface text, e.g. "last week". */
  text: string;
  /** ISO start (ranges) or point (dates). */
  start?: string;
  /** ISO end (present for ranges). */
  end?: string;
  /** TIMEX expression when available. */
  timex?: string;
}

/** The deterministic classification result. */
export interface IntentResult {
  intent: NluIntent;
  /** 0–1. 0 means unknown — C2 must verify. */
  confidence: number;
  /** The pipeline hint, or null for unknown. */
  modeHint: ModeHint | null;
  /** Present only for continue/resume with a temporal reference. */
  timeRange?: TimeRange;
}

/** Rule confidence above which the rule path is trusted (C2 only below this). */
export const RULE_TRUST_THRESHOLD = 0.8;

// ─── Pure rule matchers ─────────────────────────────────────────────────────
// Every rule is a pure function with a unit test; each returns a full match or
// null so `classifyIntent` is a plain priority walk — no shared state.

/** Explain/interrogative → chat ("explain caching", "how do I add JWT auth?"). */
export function matchExplainRule(text: string): IntentResult | null {
  if (
    /\b(?:explain|describe|assess|evaluate|analyze|compare|walk me through|tell me about)\b/i.test(
      text,
    ) ||
    /^(?:what|how|why|when|where|which|can you|could you|would you)\b/i.test(text)
  ) {
    return { intent: 'explain', confidence: 0.8, modeHint: 'chat' };
  }
  return null;
}

/**
 * Continue/resume → recall, with a temporal timeRange when the text carries one
 * ("continue last week's ecommerce plan" → timeRange for last week).
 * The reference date is injectable for deterministic tests.
 */
export function matchContinueRule(text: string, referenceDate: Date = new Date()): IntentResult | null {
  if (
    /\b(?:continue|resume|pick ?up|keep going|carry on|left off|start from where|go back to)\b/i.test(
      text,
    )
  ) {
    const timeRange = extractTimeRange(text, referenceDate);
    return {
      intent: 'continue',
      confidence: timeRange ? 0.95 : 0.9,
      modeHint: 'recall',
      ...(timeRange ? { timeRange } : {}),
    };
  }
  return null;
}

/**
 * Fix/debug → execute ("fix the login bug", "debug the failing test").
 *
 * The keywords must be WHOLE words: a hyphen or underscore on either side means
 * the token is part of an identifier (e.g. the project name `nuvira-fix-validation`
 * or a branch `fix-123`) — a request mentioning it is not a fix request. \b
 * alone is insufficient: it treats `-` and `_` as word boundaries, so
 * "deploy the project nuvira-fix-validation" would false-positive into fix.
 */
export function matchFixRule(text: string): IntentResult | null {
  if (/(?:^|[^\w-])(?:fix|debug|repair|troubleshoot|resolve)(?:$|[^\w-])/i.test(text)) {
    return { intent: 'fix', confidence: 0.85, modeHint: 'execute' };
  }
  return null;
}

/** Configure → config ("configure the gemini api key", "switch provider"). */
export function matchConfigureRule(text: string): IntentResult | null {
  // Guard: a CREATE request whose object happens to be a "config" ("create a
  // config file") must reach the create rule, not configure. Config wins only
  // when the sentence does NOT lead with a create verb.
  if (/^(?:please\s+)?(?:create|generate|write|build|make)\b/i.test(text)) return null;
  if (
    /\b(?:configure|config)\b/i.test(text) ||
    /\bapi ?key\b/i.test(text) ||
    /\b(?:switch|change) (?:model|provider)\b/i.test(text)
  ) {
    return { intent: 'configure', confidence: 0.85, modeHint: 'config' };
  }
  return null;
}

/**
 * Create/build → dev. Requires a verb-initial command or a project-object noun
 * so "the build failed" (build as noun) and "make sure tests pass" never
 * false-positive into developer mode.
 */
export function matchCreateRule(text: string): IntentResult | null {
  // Verb-initial, unambiguous commands: "create a CLI tool", "implement JWT auth".
  if (
    /^(?:please\s+)?(?:create|generate|implement|scaffold|bootstrap|develop|set up)\b/i.test(
      text,
    )
  ) {
    return { intent: 'create', confidence: 0.9, modeHint: 'dev' };
  }
  // Verb + article: "write a test", "build an api", "add a route". "add" is
  // here (and in the object-noun branch below) — NOT in the verb-initial list
  // — so the common developer phrasing "add auth to the app" routes to dev
  // mode while "add 2 + 2" (no article, no project noun) never false-positives.
  if (/^(?:please\s+)?(?:build|write|make|add)\s+(?:a|an|the|new)\s+/i.test(text)) {
    return { intent: 'create', confidence: 0.85, modeHint: 'dev' };
  }
  // Verb + project-object noun anywhere: "I want to create a new module".
  const objectNoun =
    /\b(?:file|program|script|app(?:lication)?|function|class|module|component|page|route|api|endpoint|service|cli|tool|package|library|project|plugin|addon|extension|website|server|client|database|schema|feature|daemon|worker)\b/i;
  if (
    (/\b(?:create|generate|implement|scaffold|develop|add)\b/i.test(text) ||
      /\b(?:build|write|set up)\b/i.test(text)) &&
    objectNoun.test(text)
  ) {
    return { intent: 'create', confidence: 0.85, modeHint: 'dev' };
  }
  return null;
}

// ─── Temporal extraction ────────────────────────────────────────────────────

/**
 * Extract the first temporal reference from text via the Microsoft recognizer
 * (MIT, pure JS, no network). Returns undefined when none is found.
 * The reference date is injectable for deterministic tests.
 */
export function extractTimeRange(text: string, referenceDate: Date = new Date()): TimeRange | undefined {
  try {
    const matches = recognizeDateTime(text, Culture.English, undefined, referenceDate);
    const first = matches[0];
    if (!first) return undefined;
    const value = first.resolution?.values?.[0];
    const range: TimeRange = { text: first.text };
    if (value?.timex) range.timex = value.timex;
    if (value?.type === 'daterange' && value.start && value.end) {
      range.start = value.start;
      range.end = value.end;
    } else if (value?.value) {
      range.start = value.value;
    } else if (value?.start) {
      range.start = value.start;
    }
    return range;
  } catch {
    // The recognizer must never break classification — C2 will verify.
    return undefined;
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Classify a user request deterministically.
 *
 * Priority order: explain → continue → fix → configure → create. Interrogatives
 * win first so "explain how to build X" is a chat question, not a dev command;
 * "continue" wins over "build" so "continue building the app" resumes recall.
 * Unknown inputs return `{ intent: 'unknown', confidence: 0 }` — never a guess.
 */
export function classifyIntent(text: string, referenceDate: Date = new Date()): IntentResult {
  const trimmed = text.trim();
  if (!trimmed) return { intent: 'unknown', confidence: 0, modeHint: null };

  return (
    matchExplainRule(trimmed) ??
    matchContinueRule(trimmed, referenceDate) ??
    matchFixRule(trimmed) ??
    matchConfigureRule(trimmed) ??
    matchCreateRule(trimmed) ??
    { intent: 'unknown', confidence: 0, modeHint: null }
  );
}
