/**
 * `finish` — the completion act.
 *
 * The tool exists because a turn that ends by going quiet cannot be distinguished
 * from a turn that ended because it ran out of things to say. Cline solved this with
 * `submit_and_exit({summary, verified})`; this is the same contract, with the one
 * addition that makes it ours: the claim is judged against the turn's OWN evidence
 * (the requirement ledger, the check ledger, the test-binding report) instead of
 * being taken on trust, and a contradicted claim is returned as work to do rather
 * than as an ending.
 *
 * It is NOT an `endsAgentStep` tool on purpose. A tool that ends the step would skip
 * every end-of-turn gate the loop owns (verification, artifacts, plan close-out) —
 * which is exactly the escape hatch the measured failure used. Instead a refused
 * claim is a normal tool result and the model continues in the same turn.
 *
 * A `verified:false` claim IS accepted: the point is honesty, not greenness. What it
 * may not be is silent — the unmet list it carries is what the user is shown.
 */

import type { ToolContext } from './registry.js';
import {
  FINISH_ACCEPTED_MARKER,
  FINISH_REFUSED_MARKER,
  judgeCompletion,
  type CompletionClaim,
} from '../learning/completion-contract.js';

/** The proof, as the model states it; the loop checks it against its own record. */
export interface FinishArgs extends CompletionClaim {}

function normalizeClaim(args: unknown): CompletionClaim {
  const raw = (args ?? {}) as Record<string, unknown>;
  const unmet = Array.isArray(raw.unmet)
    ? raw.unmet.map((u) => String(u ?? '').trim()).filter(Boolean)
    : typeof raw.unmet === 'string' && raw.unmet.trim()
      ? [raw.unmet.trim()]
      : undefined;
  const requirements = Array.isArray(raw.requirements)
    ? raw.requirements
        .map((entry) => {
          const item = (entry ?? {}) as Record<string, unknown>;
          const id = typeof item.id === 'string' ? item.id.trim() : '';
          const how = typeof item.how === 'string' ? item.how.trim() : '';
          return id || how ? { ...(id ? { id } : {}), ...(how ? { how } : {}) } : null;
        })
        .filter((entry): entry is { id?: string; how?: string } => entry !== null)
    : undefined;
  return {
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    // Absent `verified` is treated as a CLAIM of verification: the tool's description
    // tells the model to set it, and reading silence as `false` would let a model
    // skip the check by omitting the field.
    verified: raw.verified === false ? false : true,
    ...(unmet ? { unmet } : {}),
    ...(requirements ? { requirements } : {}),
  };
}

function accountLine(snapshot: { satisfied: number; total: number; unknown: number }): string {
  const parts = [`${snapshot.satisfied}/${snapshot.total} requirement(s) satisfied`];
  if (snapshot.total - snapshot.satisfied - snapshot.unknown > 0) {
    parts.push(`${snapshot.total - snapshot.satisfied - snapshot.unknown} unmet`);
  }
  if (snapshot.unknown > 0) parts.push(`${snapshot.unknown} not machine-checkable`);
  return parts.join(', ');
}

/** Run the completion claim. Returns the text the model reads next. */
export async function runFinish(args: unknown, ctx: ToolContext): Promise<string> {
  const claim = normalizeClaim(args);
  const snapshot = ctx.turnLedger?.() ?? null;

  // No ledger attached (a direct call, a surface that does not publish one): the
  // claim is still normalized and echoed, but nothing can be checked against it and
  // the result says so instead of implying it was verified.
  if (!snapshot) {
    const note = claim.verified === false
      ? `${FINISH_ACCEPTED_MARKER} with ${claim.unmet?.length ?? 0} stated gap(s).`
      : `${FINISH_ACCEPTED_MARKER} — no turn ledger is attached, so the claim was not checked against the turn's evidence.`;
    if (!String(claim.summary ?? '').trim()) {
      return `${FINISH_REFUSED_MARKER} — say in one line what you delivered (\`summary\`), then call finish again.`;
    }
    return note;
  }

  const verdict = judgeCompletion(claim, {
    unmet: snapshot.unmet,
    redChecks: snapshot.redChecks,
    unboundModules: snapshot.unboundModules,
    ...(snapshot.namedDeliverables ? { namedDeliverables: snapshot.namedDeliverables } : {}),
    ...(snapshot.quickstart ? { quickstart: snapshot.quickstart } : {}),
    ...(snapshot.production ? { production: snapshot.production } : {}),
    wroteFiles: snapshot.wroteFiles,
    checksRan: snapshot.checksRan,
  });

  if (verdict.accepted) {
    // The advisory notes are TRUE statements about the tree that the loop had OPINIONS
    // about (a README it expected, a module no static import reaches). They are shown
    // here — the model may still act on them — and they can never refuse the ending.
    // A caller that silenced the opinions gets none back (`advisoryGates:false`).
    const advisories = snapshot.advisoryGates === false ? [] : verdict.warnings;
    return [
      `${FINISH_ACCEPTED_MARKER} — ${accountLine(snapshot)}.`,
      claim.verified === false
        ? `Your ${claim.unmet?.length ?? 0} stated gap(s) will be given to the user verbatim; do not describe the work as complete.`
        : 'The claim matches the turn\'s evidence. Write the answer for the user now, then suggest_followups.',
      ...(advisories.length > 0          ? [
            '',
            'Advisory notes (never reasons to refuse an ending — any statement by a command outranks them). If one does not apply to this task, say why; if it does, close it now or in the answer:',
            ...advisories.map((w) => `  - ${w}`),
          ]
        : []),
    ].join('\n');
  }

  return [
    `${FINISH_REFUSED_MARKER} — ${verdict.problems.length} contradiction(s) between the claim and the turn's evidence:`,
    ...verdict.problems.map((p) => `  - ${p}`),
    '',
    'Do the work above, then call finish again.',
    'If it genuinely cannot be done in this turn, call finish with `verified:false` and list it under `unmet` — that ending is accepted, and the user is told what is missing.',
  ].join('\n');
}
