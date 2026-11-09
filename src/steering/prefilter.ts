/**
 * The deterministic prefilter — the judgments that must never depend on a model.
 *
 * Length, emptiness, explicit stop/pause controls, duplicate content, and
 * prompt-injection attempts are all decidable without intelligence. Deciding them
 * HERE means a malicious message never reaches the Change Steward as an
 * instruction, and a stop request does not wait for a semantic classification.
 *
 * The injection scan is deliberately conservative: it flags attempts to change
 * the RUN'S POLICY (approval gates, safety rules, system prompt) or to extract
 * secrets, not every message that happens to contain the word "ignore". A false
 * rejection is recoverable (the user can resubmit); a false acceptance is not.
 */

import { contentHash } from './ids.js';
import type { ChangeImpact, ChangeKind, ChangeRelation, ChangeTiming } from './types.js';

/** Above this a message is refused before it reaches any store or model. */
export const MAX_GUIDANCE_CHARS = 8000;

/** Below this there is nothing to act on. */
export const MIN_GUIDANCE_CHARS = 2;

export type ExplicitControl = 'stop' | 'pause' | 'none';

export interface PrefilterResult {
  ok: boolean;
  /** A plain-English refusal/reason when `ok` is false. */
  reason?: string;
  malicious: boolean;
  control: ExplicitControl;
  contentHash: string;
  /** The trimmed text (bounded) that downstream layers may use. */
  text: string;
}

const INJECTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(previous|prior|above|all|your)\b[\s\S]{0,30}\b(instructions?|rules?|prompt|policies|policy|guidelines?)\b/i,
    reason: 'attempts to override the run’s instructions or policy',
  },
  {
    re: /\b(system\s*prompt|developer\s*message|hidden\s*instructions?)\b/i,
    reason: 'asks for or claims to change the system prompt',
  },
  {
    re: /\b(jailbreak|developer\s*mode|do\s*anything\s*now|DAN\s*mode)\b/i,
    reason: 'attempts a jailbreak',
  },
  {
    re: /\b(bypass|disable|turn\s*off|skip|remove)\b[\s\S]{0,30}\b(approval|safety|guardrail|policy|gate|confirmation)\b/i,
    reason: 'attempts to bypass an approval or safety gate',
  },
  {
    re: /\b(print|reveal|show|dump|exfiltrate|send|leak)\b[\s\S]{0,40}\b(api\s*key|secret|token|password|credential|\.env)\b/i,
    reason: 'asks for a secret or credential',
  },
  {
    re: /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\b[\s\S]{0,40}\b(unrestricted|unfiltered|root|admin|system)\b/i,
    reason: 'attempts to replace the agent’s role',
  },
  {
    re: /\b(curl|wget|fetch|post)\b[\s\S]{0,80}\b(process\.env|\$[A-Z_]*(KEY|TOKEN|SECRET)|api[_-]?key)\b/i,
    reason: 'attempts to send credentials to an external endpoint',
  },
];

const STOP_RE = /^\s*(?:please\s+)?(stop|abort|halt|kill|cancel)(?:\s+(?:the\s+)?(?:run|work|everything|now|immediately))?\s*[.!]?\s*$/i;
const STOP_SOFT_RE = /^\s*(?:please\s+)?stop\s+(?:after|once|when)\b/i;
const PAUSE_RE = /^\s*(?:please\s+)?(pause|hold|wait)\b/i;

/** Does the text try to change policy, safety rules, or extract secrets? */
export function scanInjection(text: string): { malicious: boolean; reason?: string } {
  const value = String(text ?? '');
  for (const { re, reason } of INJECTION_PATTERNS) {
    if (re.test(value)) return { malicious: true, reason };
  }
  return { malicious: false };
}

/** Explicit controls are matched exactly enough that a normal sentence is not a stop. */
export function detectControl(text: string): ExplicitControl {
  const value = String(text ?? '').trim();
  if (!value) return 'none';
  if (STOP_RE.test(value)) return 'stop';
  if (STOP_SOFT_RE.test(value)) return 'stop';
  if (PAUSE_RE.test(value)) return 'pause';
  return 'none';
}

/** The full prefilter. Returns a refusal instead of throwing. */
export function prefilterGuidance(raw: string): PrefilterResult {
  const text = String(raw ?? '').trim();
  const hash = contentHash(text);
  if (text.length < MIN_GUIDANCE_CHARS) {
    return { ok: false, reason: 'Guidance is empty.', malicious: false, control: 'none', contentHash: hash, text };
  }
  if (text.length > MAX_GUIDANCE_CHARS) {
    return {
      ok: false,
      reason: `Guidance is too long (${text.length} chars; the limit is ${MAX_GUIDANCE_CHARS}). Split it into smaller requests.`,
      malicious: false,
      control: 'none',
      contentHash: hash,
      text: text.slice(0, MAX_GUIDANCE_CHARS),
    };
  }
  const injection = scanInjection(text);
  if (injection.malicious) {
    return {
      ok: false,
      reason: `Guidance cannot change the run’s policy or safety rules — ${injection.reason}. No plan change was made.`,
      malicious: true,
      control: 'none',
      contentHash: hash,
      text,
    };
  }
  return {
    ok: true,
    malicious: false,
    control: detectControl(text),
    contentHash: hash,
    text,
  };
}

/** A deterministic classification used when no model is available or it fails. */
export interface DeterministicAssessment {
  relation: ChangeRelation;
  kind: ChangeKind;
  timing: ChangeTiming;
  impact: ChangeImpact;
  confidence: number;
  rationale: string;
}

/**
 * A rules-only first pass. It is intentionally conservative: where the text is
 * ambiguous it returns `on_task` + `clarification` at low confidence so policy
 * asks the user rather than guessing. This is the documented fallback for a model
 * outage, not a replacement for the Steward.
 */
export function classifyDeterministically(
  text: string,
  intentHint?: 'guidance' | 'question' | 'new_task',
  control: ExplicitControl = 'none',
): DeterministicAssessment {
  const value = String(text ?? '').trim();
  const lower = value.toLowerCase();

  if (control === 'stop') {
    return { relation: 'control', kind: 'stop', timing: 'now', impact: 'high', confidence: 0.99, rationale: 'An explicit stop command.' };
  }
  if (control === 'pause') {
    return { relation: 'control', kind: 'pause', timing: 'now', impact: 'low', confidence: 0.99, rationale: 'An explicit pause command.' };
  }
  if (intentHint === 'question' || /\?\s*$/.test(value) || /^(what|how|why|where|which|who|when|can you explain|status)\b/i.test(lower)) {
    return { relation: 'meta', kind: 'question', timing: 'now', impact: 'low', confidence: 0.8, rationale: 'A question about the run, not a change to it.' };
  }
  if (intentHint === 'new_task' || /^(also|additionally|new task|separately|after this)\b/i.test(lower)) {
    return {
      relation: 'new_task',
      kind: 'add',
      timing: 'after_run',
      impact: 'high',
      confidence: 0.72,
      rationale: 'Reads as separate work outside the active objective.',
    };
  }
  const isReplacement = /\b(instead of|replace|swap|migrate|switch to|rather than)\b/i.test(lower);
  const isNegativeConstraint = /\b(do not|don't|dont|never|must not|mustn't|avoid|without)\b/i.test(lower);
  const isRemoval = /\b(stop after|only need|drop|skip|remove|no longer|out of scope|reduce|simplify)\b/i.test(lower);
  const isCorrection = /\b(wrong|incorrect|actually|correction|mistake|that's not)\b/i.test(lower);
  const isPriority = /\b(priority|prioritize|first|faster|urgent|sooner)\b/i.test(lower);
  const isQuality = /\b(overengineer|too complex|too much|simplif|cleaner|bloated)\b/i.test(lower);
  const isTests = /\b(test|tests|coverage|spec)\b/i.test(lower);
  const isDocs = /\b(doc|docs|readme|documentation)\b/i.test(lower);

  if (isNegativeConstraint && !isReplacement) {
    return {
      relation: 'on_task',
      kind: 'constraint',
      timing: 'next_safe_point',
      impact: 'high',
      confidence: 0.78,
      rationale: 'A negative guardrail: it narrows what the run may touch.',
    };
  }
  if (isReplacement) {
    return {
      relation: 'on_task',
      kind: 'modify',
      timing: 'next_safe_point',
      impact: 'high',
      confidence: 0.76,
      rationale: 'Replaces an approved choice, which is material scope.',
    };
  }
  if (isCorrection) {
    return {
      relation: 'on_task',
      kind: 'correction',
      timing: 'next_safe_point',
      impact: 'high',
      confidence: 0.74,
      rationale: 'Corrects an earlier assumption and may invalidate completed work.',
    };
  }
  if (isRemoval) {
    return {
      relation: 'on_task',
      kind: 'remove',
      timing: 'next_safe_point',
      impact: 'medium',
      confidence: 0.7,
      rationale: 'Reduces scope; policy will refuse to delete completed work.',
    };
  }
  if (isPriority) {
    return {
      relation: 'on_task',
      kind: 'priority',
      timing: 'next_safe_point',
      impact: 'low',
      confidence: 0.68,
      rationale: 'Changes ordering, not the contract.',
    };
  }
  if (isQuality) {
    return {
      relation: 'on_task',
      kind: 'quality_feedback',
      timing: 'next_safe_point',
      impact: 'medium',
      confidence: 0.66,
      rationale: 'Quality feedback that should become a concrete simplification proposal.',
    };
  }
  if (isTests || isDocs || /\b(add|include|ensure|cover)\b/i.test(lower)) {
    return {
      relation: 'on_task',
      kind: 'add',
      timing: 'next_safe_point',
      impact: isTests || isDocs ? 'low' : 'medium',
      confidence: 0.65,
      rationale: 'Additive work inside the active objective.',
    };
  }
  return {
    relation: 'on_task',
    kind: 'clarification',
    timing: 'next_safe_point',
    impact: 'low',
    confidence: 0.45,
    rationale: 'The intent is ambiguous without a semantic assessment.',
  };
}
