/**
 * Turn feedback — the user's verdict on a turn, recorded as the LABEL a quality
 * signal is fit to.
 *
 * THE GAP THIS CLOSES. Every honesty signal the harness has is DERIVED: a tool
 * ran, a plan step closed, a flag fired. None of them answers "was this any
 * good?", and a quality score fit to derived signals would just be a second copy
 * of the verification verdict. The missing input was a LABEL, and the only source
 * of one is the person who asked.
 *
 * WHY THIS IS THE CHEAPEST SOURCE. The derived correction signal
 * (`detectRegressionSignal`) yields NEGATIVES ONLY — silence is not acceptance, so
 * it can never produce the positive class. An explicit verdict yields both, which
 * is what makes a fitted `P(accepted | features)` possible at all.
 *
 * WHAT IT DOES NOT DO. It fits nothing and routes nothing. Recording the label
 * and using it are separate decisions, and the second one waits until enough rows
 * exist to mean anything (see `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §4.2).
 *
 * PROVENANCE IS PART OF THE LABEL. A verdict carries its `source` ('cli' |
 * 'dashboard') so a future fit can weigh a human judgement against a derived one,
 * and the corpus keeps `verdict: null` for "not judged" — never a fabricated
 * `false`, because reading silence as acceptance would manufacture the positive
 * class rather than measure it.
 */

import { getTrace, listTraces, recordTraceVerdict } from './reasoning-trace.js';
import { labelDeliverableByTrace } from './deliverable-corpus.js';

/** The two things a user can say about a turn. */
export type TurnVerdict = 'accepted' | 'rejected';

/**
 * Where a verdict came from — kept so a fit can separate them.
 *
 * `'cli'` / `'dashboard'` are a PERSON's explicit verdict. `'derived'` is a
 * BEHAVIOURAL one (tier 3): the harness observed the user re-ask, hand-edit the
 * artifact, or leave it untouched and reference it — an inference, not a
 * statement. Keeping them apart is the whole reason the source is stored: a fit
 * can weigh a human judgement above an inference from what the run happened to
 * see.
 */
export type VerdictSource = 'cli' | 'dashboard' | 'derived';

/** One recorded verdict, as reported back to the caller. */
export interface RatedTurn {
  traceId: string;
  goal: string;
  verdict: TurnVerdict;
  source: VerdictSource;
  at: number;
  /** True when a deliverable-corpus row was labelled by this verdict. */
  corpusLabeled: boolean;
}

/**
 * The verdict words the CLI accepts. Deliberately narrow — `good`/`bad` are the
 * friendly forms, `accepted`/`rejected` the precise ones. No synonyms beyond
 * these: a parser that accepts eight spellings is a parser nobody can predict.
 */
export function parseVerdict(text: string): TurnVerdict | null {
  switch ((text || '').trim().toLowerCase()) {
    case 'good':
    case 'accepted':
    case 'accept':
      return 'accepted';
    case 'bad':
    case 'rejected':
    case 'reject':
      return 'rejected';
    default:
      return null;
  }
}

/** The most recent trace, or null when nothing has been recorded yet. */
export function latestRateableTraceId(): string | null {
  try {
    return listTraces(1)[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Record the user's verdict on a turn: on the trace (the durable per-turn record)
 * and, when the turn delivered an authored artifact, on that specific corpus row.
 *
 * `traceId` is optional — omitted, it means "the turn I just saw", which is the
 * common case for the CLI. Both writes are best-effort and reported, never thrown:
 * feedback must never break anything.
 */
export function rateTurn(input: {
  verdict: TurnVerdict;
  traceId?: string;
  source: VerdictSource;
  now?: number;
}): { ok: true; rated: RatedTurn } | { ok: false; error: string } {
  const now = input.now ?? Date.now();
  const traceId = input.traceId ?? latestRateableTraceId() ?? undefined;
  if (!traceId) {
    return { ok: false, error: 'No trace to rate yet — run a turn first.' };
  }
  const trace = getTrace(traceId);
  if (!trace) {
    return { ok: false, error: `Trace not found: ${traceId}` };
  }
  if (!recordTraceVerdict(traceId, input.verdict, input.source, now)) {
    return { ok: false, error: `Could not record the verdict on ${traceId}.` };
  }
  let corpusLabeled = false;
  try {
    corpusLabeled = labelDeliverableByTrace(traceId, input.verdict, now);
  } catch {
    // A corpus write is best-effort — the verdict on the trace is the durable half.
    corpusLabeled = false;
  }
  return {
    ok: true,
    rated: { traceId, goal: trace.goal, verdict: input.verdict, source: input.source, at: now, corpusLabeled },
  };
}

/** Recent verdicts, most recent first, for a review surface. */
export function listTurnVerdicts(limit = 20): Array<{
  traceId: string;
  goal: string;
  verdict: TurnVerdict;
  source: VerdictSource;
  at: number;
}> {
  try {
    return listTraces(limit)
      .filter((t) => t.userVerdict)
      .map((t) => ({
        traceId: t.id,
        goal: t.goal,
        verdict: t.userVerdict!.verdict,
        source: t.userVerdict!.source,
        at: t.userVerdict!.at,
      }));
  } catch {
    return [];
  }
}
