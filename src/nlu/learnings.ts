/**
 * NLU learnings — the record of what the router READ WRONG, applied to the next
 * ask that means the same thing.
 *
 * WHY THIS EXISTS. Every routing mistake in this codebase had the same shape: a
 * rule keyed off a surface word, the ask was quietly misread, and the mistake
 * was indistinguishable from a fresh ask on the next message. An agent that
 * cannot learn from a confirmed misreading is a frozen ruleset, not something
 * that improves — which is precisely the complaint this module answers.
 *
 * A learning is written ONLY when a misreading has been CONFIRMED by the model
 * (see `intent-confirm.ts`), never from a guess and never from a failure alone:
 * a turn can fail for reasons that say nothing about its intent (quota, network,
 * an oversized prompt), and teaching the router from those would make it worse
 * with every outage. The correction is stored with the ask that earned it, so
 * the store stays inspectable — a human can read exactly which asks were
 * misread and how.
 *
 * CONFIRMED NOW MEANS SOMETHING CHECKABLE (`src/findings/verdicts.ts`). It used
 * to mean "the model said so": a correction it could not justify was persisted
 * anyway, and a rule outlives the conversation — it re-routes every later ask
 * that matches, with nothing on file to review. The probe's stated reason is
 * recorded as the evidence, and a correction without one stays PLAUSIBLE: acted
 * on for this turn, never taught as a rule.
 *
 * MATCHING IS DELIBERATELY NARROW. A learning applies to the same ask, not to a
 * similar-looking one: word order and repeated words are ignored (token set), but
 * nothing else is. A loose match would be worse than no learning at all — the
 * observed object-blindness ("create a *project plan*" vs "create a *plan* for
 * my kid") is exactly the distinction a fuzzy matcher would erase.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveNuviraDataPath } from '../config/paths.js';
import type { AskKind } from './conversation-gate.js';

/** One confirmed correction of a routing reading. */
export interface NluLearning {
  id: string;
  /** Token-set signature of the ask this was learned from (see `signatureOf`). */
  signature: string;
  /** The ask, verbatim — so a stored learning is readable, not a token soup. */
  example: string;
  /** The kind the ask was read AS (the mistake). */
  from: AskKind;
  /** The kind it should have been (the correction). */
  to: AskKind;
  /** How the correction was established. */
  source: 'intent-confirm';
  recordedAt: number;
  /** How many times this learning changed a routing decision. */
  hits: number;
  lastAppliedAt?: number;
  /** The model's one-line reason, kept for the store's audit value. */
  reason?: string;
}

/** Bounded: an unbounded rule store is a slow-motion routing failure. */
const MAX_LEARNINGS = 200;
const FILE_NAME = 'nlu-learnings.json';

/**
 * Words that carry no routing signal — dropped from a signature so an ask that
 * differs only by politeness ("please", "can you") matches the learning.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'please', 'can', 'could', 'would', 'will', 'you', 'i', 'me',
  'my', 'our', 'your', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'is',
  'are', 'be', 'it', 'that', 'this', 'with', 'do', 'does', 'some', 'new',
]);

function storePath(): string {
  return resolveNuviraDataPath(FILE_NAME);
}

interface StoreShape {
  version: number;
  learnings: NluLearning[];
}

/**
 * A token-set signature: lowercase, punctuation removed, stopwords dropped,
 * deduped, sorted. Word order and repetition are intentionally invisible — the
 * SAME ask phrased as "for class 4, create a plan" is the same request — while
 * any word that carries meaning still distinguishes it.
 */
export function signatureOf(text: string | null | undefined): string {
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return [...new Set(tokens)].sort().join(' ');
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `nlu-${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* fall through */
  }
  return `nlu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let cache: { learnings: NluLearning[]; mtimeMs: number } | null = null;

/**
 * Read the store, cached on mtime. This runs on the routing hot path (every
 * inbound message), so a real file read per ask is not acceptable — and a
 * stale cache is not either, since a learning is written by a DIFFERENT process
 * in the dashboard/gateway case.
 */
export function loadLearnings(): NluLearning[] {
  try {
    const path = storePath();
    if (!existsSync(path)) {
      cache = { learnings: [], mtimeMs: 0 };
      return [];
    }
    const mtimeMs = statSync(path).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.learnings;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape;
    const learnings = Array.isArray(parsed?.learnings) ? parsed.learnings.filter(isLearning) : [];
    cache = { learnings, mtimeMs };
    return learnings;
  } catch {
    // A corrupt store must never break routing — an empty rule set is correct.
    cache = { learnings: [], mtimeMs: 0 };
    return [];
  }
}

function writeLearnings(learnings: NluLearning[]): void {
  try {
    const path = storePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: StoreShape = { version: 1, learnings: learnings.slice(0, MAX_LEARNINGS) };
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
    cache = { learnings: payload.learnings, mtimeMs: statSync(path).mtimeMs };
  } catch {
    cache = null;
    // Best-effort — a learning that cannot be persisted must not fail the turn.
  }
}

function isLearning(value: unknown): value is NluLearning {
  if (!value || typeof value !== 'object') return false;
  const o = value as Partial<NluLearning>;
  return (
    typeof o.id === 'string' &&
    typeof o.signature === 'string' &&
    typeof o.example === 'string' &&
    (o.from === 'chat' || o.from === 'pipeline') &&
    (o.to === 'chat' || o.to === 'pipeline') &&
    o.from !== o.to
  );
}

/**
 * Record a confirmed misreading.
 *
 * One entry per (signature, target): re-confirming the same correction refreshes
 * the existing learning instead of accumulating duplicates, and a LATER
 * correction that contradicts an earlier one replaces it — the newest confirmed
 * verdict is the truth, and keeping both would leave the store self-contradictory.
 */
export function recordLearning(input: {
  text: string;
  from: AskKind;
  to: AskKind;
  reason?: string;
  now?: number;
}): NluLearning | undefined {
  const signature = signatureOf(input.text);
  if (!signature || input.from === input.to) return undefined;
  const now = input.now ?? Date.now();
  const learnings = loadLearnings();
  const existing = learnings.find((l) => l.signature === signature && l.to === input.to);
  if (existing) {
    existing.from = input.from;
    existing.example = input.text;
    existing.recordedAt = now;
    if (input.reason) existing.reason = input.reason;
    writeLearnings(learnings);
    return existing;
  }
  // A contradicting correction for the same ask is superseded, not merged.
  const kept = learnings.filter((l) => l.signature !== signature);
  const learning: NluLearning = {
    id: newId(),
    signature,
    example: input.text,
    from: input.from,
    to: input.to,
    source: 'intent-confirm',
    recordedAt: now,
    hits: 0,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  writeLearnings([learning, ...kept]);
  return learning;
}

/**
 * How much of the learning's own ask this ask contains.
 *
 * CONTAINMENT (shared / smaller set), not Jaccard: the common near-miss is an
 * ask that ADDS a word to the one that was misread ("…to speak english" →
 * "…to speak english fluently"), which a symmetric measure punishes exactly as
 * hard as changing the object. Containment asks the question that matters — "is
 * this the ask I was taught about?" — and the thresholds below keep it from
 * matching a merely related one.
 */
function containment(askTokens: Set<string>, learningTokens: Set<string>): number {
  const smaller = Math.min(askTokens.size, learningTokens.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const w of learningTokens) if (askTokens.has(w)) shared++;
  return shared / smaller;
}

/**
 * A signature must carry at least this much meaning to be matched loosely.
 * A two-word signature ("create plan") is a keyword, and matching it against
 * every ask that contains those words would misroute far more than it fixes.
 */
const MIN_TOKENS_FOR_CONTAINMENT = 3;
/** And the two asks must share at least this many meaningful words. */
const MIN_SHARED_TOKENS = 3;
/**
 * The learning's ask must be FULLY present in this ask.
 *
 * That asymmetry is the point, and it was measured: ADDING or REMOVING a word
 * ("…to speak english" / "…to speak english fluently") keeps the object and
 * matches; SUBSTITUTING a word ("…the data pipeline…" → "…the build pipeline…")
 * does not, because the object may have changed. A 0.8 threshold matched that
 * substitution, which is a real misroute — the same object-blindness a fuzzy
 * matcher would reintroduce.
 */
const CONTAINMENT_THRESHOLD = 1;

/**
 * The learning that applies to this ask, if any.
 *
 * An exact signature match wins. Otherwise a near-identical ask is accepted —
 * same object, one word added or removed — under all three guards above.
 * Nothing looser: a wrong correction silently misroutes a request, which is the
 * class of bug this store exists to fix.
 */
export function matchLearning(text: string | null | undefined): NluLearning | undefined {
  const signature = signatureOf(text);
  if (!signature) return undefined;
  const learnings = loadLearnings();
  const exact = learnings.find((l) => l.signature === signature);
  if (exact) return exact;

  const askTokens = new Set(signature.split(' ').filter(Boolean));
  let best: { l: NluLearning; score: number } | undefined;
  for (const l of learnings) {
    const learningTokens = new Set(l.signature.split(' ').filter(Boolean));
    if (learningTokens.size < MIN_TOKENS_FOR_CONTAINMENT) continue;
    let shared = 0;
    for (const w of learningTokens) if (askTokens.has(w)) shared++;
    if (shared < MIN_SHARED_TOKENS) continue;
    const score = containment(askTokens, learningTokens);
    if (score < CONTAINMENT_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && l.recordedAt > best.l.recordedAt)) {
      best = { l, score };
    }
  }
  return best?.l;
}

/**
 * Apply a learning to a verdict. Returns the corrected kind plus the learning
 * that changed it, so the caller can report WHY the route differs from the
 * rules (an unexplained override is its own bug).
 */
export function applyLearning(
  text: string | null | undefined,
  verdict: AskKind,
): { kind: AskKind; learning: NluLearning } | undefined {
  const learning = matchLearning(text);
  if (!learning) return undefined;
  if (learning.to === verdict) return undefined; // already right; nothing to change
  return { kind: learning.to, learning };
}

/** Record one applied hit (best-effort; telemetry must not break routing). */
export function noteLearningApplied(id: string, now: number = Date.now()): void {
  try {
    const learnings = loadLearnings();
    const learning = learnings.find((l) => l.id === id);
    if (!learning) return;
    learning.hits = (learning.hits || 0) + 1;
    learning.lastAppliedAt = now;
    writeLearnings(learnings);
  } catch {
    /* best-effort */
  }
}

/** Every stored learning, newest first (CLI / dashboard inspection). */
export function listLearnings(): NluLearning[] {
  return loadLearnings();
}

/** Drop one learning (a correction that turned out wrong must be removable). */
export function removeLearning(id: string): boolean {
  const learnings = loadLearnings();
  const kept = learnings.filter((l) => l.id !== id);
  if (kept.length === learnings.length) return false;
  writeLearnings(kept);
  return true;
}

/** Test/ops escape hatch: forget everything. */
export function clearLearnings(): void {
  writeLearnings([]);
}
