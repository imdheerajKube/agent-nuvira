/**
 * Tier-3 behavioural labels — the verdict the harness can INFER from what the
 * user DID, without the user saying anything.
 *
 * WHY A THIRD TIER. An explicit verdict (`nuvira rate`, the dashboard Trace tab)
 * is the only source of a POSITIVE label, but it only exists when the user
 * bothers to give one. Between "the user rated it" and "the user said nothing at
 * all" there is behaviour the harness can OBSERVE: a re-ask, a hand-edit of the
 * delivered file, an untouched artifact the user then referenced. Those are
 * inferences, not statements, so they carry `source: 'derived'` and a fit can
 * weigh them BELOW a human judgement.
 *
 * THE RULE THAT KEEPS THIS HONEST. Silence is still NOT acceptance. An untouched
 * artifact is not a label on its own — it becomes a (weak) acceptance only when
 * the user's next message REFERENCES that artifact without reporting a regression.
 * A raw untouched file the user never mentioned stays `null`, exactly like a turn
 * nobody rated. The three signals, in priority order:
 *
 *   1. repeat-ask         — the new ask is near-identical to the delivered ask
 *                           (Jaccard similarity), so the delivery did not land.  → rejected
 *   2. hand-edit          — the delivered file changed after the turn made it,
 *                           so the user had to fix it.                          → rejected
 *   3. unchanged-referenced — the file is untouched AND the new message names it
 *                           AND no regression was reported.                      → accepted
 *
 * NOTHING ROUTES ON THIS. It labels the deliverable corpus and the turn's trace,
 * the same two places an explicit verdict writes, and that is all.
 *
 * The similarity and reference tests are MEASURED (token overlap, a filename
 * appearing in the text) — never a phrase list of "sounds like they liked it".
 */

import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  readDeliverableCandidates,
  labelNewestUnlabelled,
  labelDeliverableByTrace,
} from './deliverable-corpus.js';
import { recordTraceVerdict } from './reasoning-trace.js';

/** Why a behavioural label was derived — kept so a reader can audit the inference. */
export type BehaviouralReason = 'repeat-ask' | 'hand-edit' | 'unchanged-referenced';

/** A derived verdict. `source` is ALWAYS `'derived'` — that is the point of the tier. */
export interface BehaviouralLabel {
  verdict: 'accepted' | 'rejected';
  source: 'derived';
  reason: BehaviouralReason;
}

/**
 * Token-set Jaccard at or above which two asks are the SAME request.
 *
 * Deliberately high: a re-ask is usually near-verbatim, and a false positive here
 * would mark a genuinely NEW request as a rejection of the last one. Two different
 * asks about the same subject share only their common words, which pulls the score
 * well below this line.
 */
export const REPEAT_ASK_SIMILARITY = 0.9;

/** Filesystem timestamp slack: a write finishing at the same instant as delivery is not an edit. */
const FILE_MTIME_EPSILON_MS = 250;

/** Alphanumeric word tokens, lowercased. No stoplist — overlap is measured, not curated. */
export function normalizeAskTokens(text: string): Set<string> {
  const tokens = (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((t) => t.length >= 2));
}

/** Jaccard similarity of two asks' token sets (0 when either is empty). */
export function askSimilarity(a: string, b: string): number {
  const sa = normalizeAskTokens(a);
  const sb = normalizeAskTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Does the message NAME the artifact — its filename (with or without extension)? */
export function referencesArtifact(newAsk: string, path: string): boolean {
  if (!path) return false;
  const text = (newAsk || '').toLowerCase();
  const base = basename(path).toLowerCase();
  const stem = base.slice(0, base.length - extname(base).length);
  if (stem.length >= 2 && normalizeAskTokens(newAsk).has(stem)) return true;
  // The full filename mentioned verbatim (e.g. "guide.md") also counts.
  return base.length >= 2 && text.includes(base);
}

/** True when the file exists and its mtime is AFTER the delivery (+ slack). Never throws. */
export function wasModifiedAfter(path: string, deliveredAt: number, epsilonMs = FILE_MTIME_EPSILON_MS): boolean {
  try {
    const st = statSync(path);
    return st.mtimeMs > deliveredAt + epsilonMs;
  } catch {
    // A path we cannot resolve (different cwd, deleted file) is not evidence of an edit.
    return false;
  }
}

/**
 * The pure decision, so the inference can be unit-tested without a filesystem.
 * `null` means "no label is justified" — which is the common, honest answer.
 */
export function classifyBehaviouralLabel(input: {
  newAsk: string;
  previousAsk: string;
  reportsRegression: boolean;
  artifactPath: string | null;
  artifactModified: boolean;
  referencesArtifact: boolean;
}): BehaviouralLabel | null {
  // A reported regression is already labelled by the explicit correction path
  // (`detectRegressionSignal`). Deriving a second label for it would double-count
  // one event, so the behavioural tier stands aside.
  if (input.reportsRegression) return null;

  if (askSimilarity(input.newAsk, input.previousAsk) >= REPEAT_ASK_SIMILARITY) {
    return { verdict: 'rejected', source: 'derived', reason: 'repeat-ask' };
  }
  // An edit is checked BEFORE any acceptance: a file the user rewrote is the
  // strongest behavioural negative, whether or not they mentioned it.
  if (input.artifactModified) {
    return { verdict: 'rejected', source: 'derived', reason: 'hand-edit' };
  }
  if (input.referencesArtifact) {
    return { verdict: 'accepted', source: 'derived', reason: 'unchanged-referenced' };
  }
  return null;
}

/**
 * Read the newest UNLABELLED delivery, infer a behavioural label, and apply it.
 *
 * Returns the label that was applied, or null when nothing was justified. Every
 * write is best-effort.
 */
export function deriveAndApplyBehaviouralLabel(input: {
  newAsk: string;
  reportsRegression: boolean;
  now?: number;
}): BehaviouralLabel | null {
  if (input.reportsRegression) return null;
  let row;
  try {
    const rows = readDeliverableCandidates();
    row = [...rows].reverse().find((r) => r.verdict === null);
  } catch {
    return null;
  }
  if (!row) return null;

  const artifactModified = row.path ? wasModifiedAfter(row.path, row.ts) : false;
  const referenced = row.path ? referencesArtifact(input.newAsk, row.path) : false;
  const label = classifyBehaviouralLabel({
    newAsk: input.newAsk,
    previousAsk: row.ask,
    reportsRegression: false,
    artifactPath: row.path ?? null,
    artifactModified,
    referencesArtifact: referenced,
  });
  if (!label) return null;

  applyBehaviouralLabel(row.traceId, label, input.now ?? Date.now());
  return label;
}

/**
 * Write a derived label to the same two places an explicit verdict writes: the
 * delivery's corpus row and (when the row knows its trace) the turn's trace.
 * Best-effort — a label write must never break a turn.
 */
export function applyBehaviouralLabel(
  traceId: string | undefined,
  label: BehaviouralLabel,
  now: number = Date.now(),
): void {
  try {
    if (traceId) {
      labelDeliverableByTrace(traceId, label.verdict, now);
      recordTraceVerdict(traceId, label.verdict, label.source, now);
    } else {
      // No trace to hang it on: label the newest unlabelled row directly. The
      // cue is real (we are looking at that delivery), so this is not invention.
      labelNewestUnlabelled(label.verdict, now);
    }
  } catch {
    // Best-effort.
  }
}
