/**
 * Deliverable corpus — COLLECT the case item 13's residual needs, instead of
 * inventing a detector for it.
 *
 * THE PROBLEM THIS EXISTS FOR. Bundle 23 catches an authored artifact materially
 * SHORTER than a magnitude the ask stated, and Bundle 19 catches one that admits
 * its own content was omitted. Neither reaches the remaining shape: a deliverable
 * that is complete and on-length yet simply GENERIC — the case none of the live
 * runs has produced, and the one no deterministic rule can judge, because judging
 * it from vocabulary is the defect this programme exists to remove.
 *
 * So this module does not judge. It COLLECTS. When a turn delivers a single
 * authored artifact that trips neither the omission nor the shortfall check, the
 * bare facts of that delivery (the ask, the file, its length, a bounded excerpt)
 * are appended here. If the user then reports the turn as a miss — the SAME
 * correction signal (`detectRegressionSignal`) the working-state ledger and the
 * bandit already use — the most recent candidate is labelled `rejected`.
 *
 * That pair — a fluent, on-length delivery plus a human's verdict on it — is the
 * ground truth a measured quality signal must be fit to. Until rows carry the
 * label the corpus is deliberately INERT: nothing reads it, nothing routes on it,
 * and no score is derived from it. It is a dataset, not a detector. Deriving a
 * signal from `verdict: null` rows, or from the excerpt's wording, would be the
 * phrase-list defect one layer down.
 *
 * Storage: `<memory>/deliverable-candidates.jsonl` (honours `NUVIRA_MEMORY_DIR`).
 * Every write is best-effort — collection must NEVER break a turn.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Rows kept on disk (oldest drop first) — a dataset, not an unbounded log. */
export const MAX_DELIVERABLE_CANDIDATES = 500;
/** Characters of the artifact kept per row: enough to fit features to, bounded. */
export const DELIVERABLE_EXCERPT_MAX = 2000;
/** Characters of the ask kept per row. */
export const DELIVERABLE_ASK_MAX = 500;

/** One collected delivery, and (once the user speaks) the verdict on it. */
export interface DeliverableCandidate {
  /** Epoch ms the delivery was recorded. */
  ts: number;
  /** The user's ask that produced the deliverable. */
  ask: string;
  /** The file the turn wrote. */
  path: string;
  /** Words actually delivered. */
  deliveredWords: number;
  /** The magnitude the ask stated, when it stated one. */
  targetWords?: number;
  /** The turn's own verdict, so a reader can see what was already known. */
  verification?: string;
  /** A bounded excerpt of the artifact. */
  excerpt: string;
  /** The trace this delivery belongs to, so a later verdict can label THIS row. */
  traceId?: string;
  /**
   * `null` — the user has not judged the turn; `'accepted'` / `'rejected'` — they
   * did. A boolean `rejected: false` is deliberately NOT used: it cannot tell
   * "the user accepted it" from "the user never said", and reading silence as
   * acceptance would fabricate the positive class a fitted signal needs most
   * (the same rule the bandit follows).
   */
  verdict: 'accepted' | 'rejected' | null;
  /** Epoch ms the verdict was recorded. */
  verdictAt?: number;
}

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function corpusPath(): string {
  return join(memoryDir(), 'deliverable-candidates.jsonl');
}

/** The corpus path — exported so tests and an inspection surface can name it. */
export function deliverableCorpusPath(): string {
  return corpusPath();
}

/** Parse the JSONL store; a malformed line is skipped, never fatal. */
export function readDeliverableCandidates(): DeliverableCandidate[] {
  try {
    if (!existsSync(corpusPath())) return [];
    const out: DeliverableCandidate[] = [];
    for (const line of readFileSync(corpusPath(), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as DeliverableCandidate;
            if (row && typeof row.path === 'string' && typeof row.ask === 'string') {
          // Tolerate the short-lived shape that predates the tri-state verdict: an
          // old `rejected: true` row is a rejection, and is MIGRATED on read so the
          // rest of the module has exactly one shape to reason about.
          if (row.verdict === undefined && (row as { rejected?: unknown }).rejected === true) {
            row.verdict = 'rejected';
          }
          if (row.verdict === undefined) row.verdict = null;
          out.push(row);
        }
      } catch {
        // A corrupt line is skipped — a collection store must not become a landmine.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeCandidates(rows: DeliverableCandidate[]): void {
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    const capped = rows.slice(-MAX_DELIVERABLE_CANDIDATES);
    writeFileSync(corpusPath(), capped.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  } catch {
    // Best-effort — collection must never break a turn.
  }
}

/**
 * Record one magnitude-satisfied authored delivery. Returns the stored row, or
 * null when there was nothing to record.
 */
export function recordDeliverableCandidate(
  input: {
    ask: string;
    path: string;
    deliveredWords: number;
    targetWords?: number;
    verification?: string;
    excerpt: string;
    traceId?: string;
  },
  now: number = Date.now(),
): DeliverableCandidate | null {
  if (!input.path || !input.excerpt) return null;
  const row: DeliverableCandidate = {
    ts: now,
    ask: (input.ask || '').replace(/\s+/g, ' ').slice(0, DELIVERABLE_ASK_MAX),
    path: input.path,
    deliveredWords: input.deliveredWords,
    ...(input.targetWords !== undefined ? { targetWords: input.targetWords } : {}),
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    excerpt: input.excerpt.slice(0, DELIVERABLE_EXCERPT_MAX),
    verdict: null,
  };
  const rows = readDeliverableCandidates();
  rows.push(row);
  writeCandidates(rows);
  return row;
}

/**
 * Label the most recent UNLABELLED candidate as rejected.
 *
 * Called when the user's next message reports the previous turn as a miss. Only
 * the newest unlabelled row is touched: a correction speaks about the most recent
 * delivery, and a row that already carries a verdict must not be relabelled by a
 * later, unrelated complaint. Returns true when a row was labelled.
 */
export function markLastDeliverableRejected(now: number = Date.now()): boolean {
  return labelNewestUnlabelled('rejected', now);
}

/**
 * Label the most recent UNLABELLED row with `verdict`.
 *
 * The general form of {@link markLastDeliverableRejected}, for callers that carry
 * a verdict but not a trace id (the tier-3 behavioural path can infer a label from
 * what the user did without a trace to attach it to). Only the newest unlabelled
 * row is touched — a verdict speaks about the most recent delivery, and a row that
 * already carries one must not be relabelled by a later, unrelated signal. Returns
 * true when a row was labelled.
 */
export function labelNewestUnlabelled(
  verdict: 'accepted' | 'rejected',
  now: number = Date.now(),
): boolean {
  const rows = readDeliverableCandidates();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].verdict === null) {
      rows[i] = { ...rows[i], verdict, verdictAt: now };
      writeCandidates(rows);
      return true;
    }
  }
  return false;
}

/**
 * Label the delivery that belongs to `traceId` with the user's EXPLICIT verdict.
 *
 * Unlike {@link markLastDeliverableRejected} (which the derived correction signal
 * uses), this is the reliable path: the row knows which trace produced it, so the
 * label lands on the RIGHT delivery rather than on "the most recent one".
 *
 * When no row carries this trace, a REJECTION still falls back to the newest
 * unlabelled row — the delivery may predate the trace link — but an ACCEPTANCE
 * does not: inventing a positive label for a delivery we cannot identify is
 * exactly the fabricated sample this corpus refuses. Returns true when a row was
 * labelled.
 */
export function labelDeliverableByTrace(
  traceId: string,
  verdict: 'accepted' | 'rejected',
  now: number = Date.now(),
): boolean {
  const rows = readDeliverableCandidates();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].traceId === traceId) {
      rows[i] = { ...rows[i], verdict, verdictAt: now };
      writeCandidates(rows);
      return true;
    }
  }
  return verdict === 'rejected' ? markLastDeliverableRejected(now) : false;
}

/** Forget the whole corpus (CLI/test escape hatch). */
export function clearDeliverableCandidates(): void {
  writeCandidates([]);
}
