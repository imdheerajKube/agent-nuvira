/**
 * Completion contract — "I am done" is a CLAIM, and the turn checks it.
 *
 * WHY THIS EXISTS (measured 2026-10-25). Cline makes finishing an ACT, not a
 * silence: `submit_and_exit({summary, verified})`, a reminder injected while the run
 * is open ("a response without the submit_and_exit tool call will be considered not
 * completed"), and `verified` set true only when the tool output shows the
 * requirements are met. agent-nuvira's turn ends when the model stops calling
 * tools, so "I stopped" and "the request is satisfied" are the same event — which is
 * why it finished a build task in 14 of its 30 minutes with no README, no e2e tests
 * and no tracking files while claiming success.
 *
 * This module is the part of Cline's design worth copying, and only that part: the
 * model must STATE completion, and the statement is judged against evidence the
 * turn actually gathered (the requirement ledger, the check ledger, the test-binding
 * report). A claim of `verified: true` that the evidence contradicts is refused —
 * the model keeps working. A claim of `verified: false` is a legal ending, but it
 * must carry the unmet list, which then reaches the user instead of being rounded
 * up to "done".
 *
 * The tool that carries this (`finish`) has no transport in this module: it is a
 * pure decision function, so the rule is testable without a model, a registry or a
 * filesystem.
 */

export interface CompletionClaim {
  /** One line: what was delivered. Required — an unstated deliverable is not a claim. */
  summary?: string;
  /**
   * `true` = the tool output shows the requirements are met.
   * `false` = it does not, and `unmet` must say what is missing.
   */
  verified?: boolean;
  /** What is NOT done, when `verified` is false. */
  unmet?: string[];
  /** Optional per-requirement account (`{ id, how }`) — evaluated as prose only. */
  requirements?: Array<{ id?: string; how?: string }>;
}

/** What the turn knows, independent of the model's claim. */
export interface CompletionEvidence {
  /** Enforceable requirement rows that did not resolve. */
  unmet: readonly string[];
  /**
   * Checks whose LATEST run failed.
   *
   * `stale` = the tree changed after the verdict. `preExisting` = it was already red
   * before this turn changed anything and has not got worse (see `RedCheck`), which
   * makes it the repository's condition rather than a contradiction of this turn.
   */
  redChecks: readonly { command: string; stale?: boolean; preExisting?: boolean }[];
  /** Modules this turn wrote that no test imports (already a named gap). */
  unboundModules?: readonly string[];
  /**
   * Files the REQUEST named by path (from `deliverablesNamedIn`), with whether they
   * exist now.
   *
   * WHY THIS IS A CONTRADICTION AND NOT A WARNING (measured 2026-10-29, BUG-SEEDED):
   * the ask said "Write `docs/BUGS_FOUND.md`: for each defect, path:line …", and the
   * turn fixed all four seeded bugs, wrote a test file, and ended without the report —
   * its own last words were "next steps: write up the audit report". Cline, on the
   * same ask, wrote 164 lines of it. Nothing in the loop refused: the fixed-vocabulary
   * `required-artifacts` gate (todo.md, README, e2e…) does not know an arbitrary path,
   * so the omission cost the turn nothing except the thing the user asked for — the
   * scorecard had no axis for it either, which is the same blind spot one layer down.
   * A path the user asked for by name is a fact about the deliverable, so a
   * `verified:true` claim that omits it is refused — and `verified:false` with the gap
   * in `unmet` stays a legal ending.
   */
  namedDeliverables?: readonly { path: string; exists: boolean }[];
  /**
   * A runnable entry point this turn wrote while no followable README exists.
   * Measured: all three agents on the same prompt wrote docs and none wrote a
   * README, so "the project is done" is not true of a project nobody can start.
   */
  quickstart?: { entry: string };
  /**
   * The ask claimed production/deploy, the turn made the project runnable, and no
   * operational artefact exists. See `doc-claims.ts` — the deployment row of the
   * documentation score is the one a runnable-but-undeployed project loses, whether
   * or not its README is perfect.
   */
  production?: { asked: string; entry: string; pointerTo?: string };
  /** Did the turn write any file? */
  wroteFiles: boolean;
  /** How many real (non-inspection) checks ran this turn. */
  checksRan: number;
}

/**
 * The turn's live evidence, published to tools so `finish` can judge a claim
 * against the SAME facts the loop's end-of-turn gate reads.
 *
 * A function rather than a snapshot: a tool call happens mid-turn and the ledger
 * changes with every write, so the tool must read the evidence as of NOW.
 */
export interface TurnLedgerSnapshot {
  /** Enforceable requirement rows that did not resolve, as told to the model. */
  unmet: string[];
  redChecks: { command: string; stale: boolean; preExisting?: boolean }[];
  unboundModules: string[];
  /** See {@link CompletionEvidence.namedDeliverables}. */
  namedDeliverables?: { path: string; exists: boolean }[];
  /** See {@link CompletionEvidence.quickstart}. */
  quickstart?: { entry: string };
  /** See {@link CompletionEvidence.production}. */
  production?: { asked: string; entry: string; pointerTo?: string };
  wroteFiles: boolean;
  checksRan: number;
  /**
   * Whether the loop's shape predictions are in force for this turn (see
   * `ToolLoopOptions.advisoryNudges`). `finish` shows the advisory notes only when
   * they are, so a caller that silenced the opinions does not get them back through
   * the tool result.
   */
  advisoryGates?: boolean;
  /** Requirement counts, for the account line. */
  satisfied: number;
  total: number;
  unknown: number;
}

export interface CompletionVerdict {
  accepted: boolean;
  /**
   * What CONTRADICTS the claim. Only facts an executed command produced belong here —
   * a red check, a claim of verification with no check ever run, a claim with no
   * summary. These are the only things that may refuse an ending.
   */
  problems: string[];
  /**
   * Advisory gaps: true statements about a shape the loop PREDICTED (a test that should
   * import a module, a README it expected, an artifact it recognised by name). They are
   * shown to the model and to the user, and they never refuse an ending.
   *
   * WHY THIS SPLIT EXISTS (measured 2026-10-27). The enterprise run ended with 9/100
   * because a refusal named a test that existed and passed 7/7: the test imported its
   * settings modules through `importlib` in a fresh interpreter, which the static-import
   * scanner cannot see. A prediction about the shape of correct work was allowed to
   * overrule a command that had already proved the work. Evidence outranks prediction;
   * when they disagree, the prediction is what gets corrected.
   */
  warnings: string[];
  /** One-line account for the tool result / trace, accepted or not. */
  summary: string;
}

/** Markers the loop reads off the tool result — never prose guessing. */
export const FINISH_ACCEPTED_MARKER = 'Completion accepted';
export const FINISH_REFUSED_MARKER = 'Completion NOT accepted';

/**
 * Judge a completion claim against the turn's own evidence.
 *
 * The rules, in the order they fire:
 *  1. a claim with no summary is not a completion (nothing was stated);
 *  2. `verified: true` is refused while an enforceable requirement is unmet;
 *  3. …while a check is red;
 *  4. …while the turn wrote files and ran no check at all;
 *  5. …while a module it wrote has no test that imports it (when that question
 *     applies — the caller only fills `unboundModules` then);
 *  6. `verified: false` is ACCEPTED, and its `unmet` list is what the user sees.
 *
 * Nothing here can be argued with in prose: every refusal names an artifact, a
 * command or a requirement row.
 */
export function judgeCompletion(claim: CompletionClaim, evidence: CompletionEvidence): CompletionVerdict {
  const problems: string[] = [];
  const summary = String(claim.summary ?? '').trim();
  if (!summary) {
    problems.push('say in one line what you delivered — a completion with no summary states nothing');
  }

  const unbound = evidence.unboundModules ?? [];
  const warnings: string[] = [];
  if (claim.verified !== false) {
    // A path the request named is the deliverable, not a suggestion (see
    // `namedDeliverables`). Named before the advisory rows on purpose: this is the
    // one gap that is a fact about the ask itself.
    const missingNamed = (evidence.namedDeliverables ?? []).filter((entry) => !entry.exists);
    for (const entry of process.env.NUVIRA_NO_NAMED_REFUSAL === '1' ? [] : missingNamed.slice(0, 4)) {
      problems.push(
        `\`${entry.path}\` is named in the request and does not exist — write it (real content, not a placeholder), or call finish with \`verified:false\` and say in \`unmet\` that it is missing`,
      );
    }
    if (evidence.unmet.length > 0) {
      for (const row of evidence.unmet.slice(0, 6)) warnings.push(`not done (advisory): ${row}`);
      if (evidence.unmet.length > 6) warnings.push(`…and ${evidence.unmet.length - 6} more unmet requirement(s)`);
    }
    // A check that was ALREADY red before this turn changed anything, and has not got
    // worse, is the repository's condition — not a contradiction of this turn's work.
    // It stays visible as an observation (the answer must still say the suite is red)
    // and stops being a reason to refuse the ending, because no correct work on the
    // task can make someone else's 113-failure baseline go green, and a turn that
    // tries burns its steps on a bug it did not cause (measured 2026-10-29: the
    // BUG-SEEDED arm re-ran a red baseline suite instead of writing the report).
    const reds = [...evidence.redChecks].sort((a, b) => Number(!!a.preExisting) - Number(!!b.preExisting));
    for (const red of reds) {
      if (red.preExisting) {
        warnings.push(
          `\`${red.command}\` was already failing before this turn changed anything and is no worse now — do not chase it; say in the answer that the suite is red and which failures pre-date this work`,
        );
        continue;
      }
      problems.push(
        red.stale
          ? `\`${red.command}\` failed and has not been re-run since the code changed`
          : `\`${red.command}\` is red`,
      );
    }
    if (evidence.wroteFiles && evidence.checksRan === 0) {
      problems.push('files were changed and no check ever ran — "verified" cannot be true without a command observing it');
    }
    if (evidence.quickstart) {
      warnings.push(
        `\`${evidence.quickstart.entry}\` makes the project runnable and there is no README a fresh clone could follow — write it, or say in \`unmet\` that it is missing`,
      );
    }
    if (evidence.production) {
      const p = evidence.production;
      warnings.push(
        p.pointerTo
          ? `the request says \`${p.asked}\` and the deployment story is only \`${p.pointerTo}\` — a directory whose name does not say what is inside it, so nothing a reader opens first says how it ships. Add \`docs/DEPLOYMENT.md\` (build, release, env), or a Dockerfile/compose file, or say in \`unmet\` that it does not ship`
          : `the request says \`${p.asked}\` and \`${p.entry}\` makes the project runnable, but nothing in the tree says how it reaches a server (compose file, Dockerfile, deploy directory, deployment doc or deploy workflow) — add one, or say in \`unmet\` that it does not ship`,
      );
    }
    if (unbound.length > 0) {
      for (const module of unbound.slice(0, 3)) {
        warnings.push(`\`${module}\` is new and no test file was found importing it (advisory — a test may exercise it without a static import)`);
      }
      if (unbound.length > 3) warnings.push(`…and ${unbound.length - 3} more module(s) with no test found by static analysis`);
    }
  } else if (!Array.isArray(claim.unmet) || claim.unmet.filter((u) => String(u).trim()).length === 0) {
    // A legal ending, but it has to say what is missing: `verified: false` with an
    // empty list is indistinguishable from a shrug, and the caller renders that list.
    problems.push('verified:false must list what is NOT done in `unmet` — otherwise the user cannot tell what is missing');
  }

  const accepted = problems.length === 0;
  return {
    accepted,
    problems,
    warnings,
    summary: accepted
      ? [
          claim.verified === false
            ? `accepted with ${claim.unmet?.length ?? 0} stated gap(s)`
            : 'accepted — the checks that ran back the claim',
          warnings.length > 0 ? `${warnings.length} advisory note(s)` : '',
        ]
          .filter(Boolean)
          .join(', ')
      : `${problems.length} contradiction(s) between the claim and the turn's evidence`,
  };
}

/**
 * The message the model receives when it is about to end a turn with outstanding,
 * CHECKABLE work. One message, every gap, and both ways out: close them, or state
 * them with `finish({verified:false})` so they reach the user instead of vanishing.
 *
 * Bounded by construction: at most 6 named items, and the caller spends it once.
 */
export function completionNudge(input: {
  unmet: readonly string[];
  unboundModules?: readonly string[];
  redChecks?: readonly string[];
  extra?: readonly string[];
}): string {
  const items: string[] = [];
  for (const row of input.unmet) items.push(`  - not done: ${row}`);
  for (const module of input.unboundModules ?? []) items.push(`  - \`${module}\` is new and no test imports it`);
  for (const command of input.redChecks ?? []) items.push(`  - \`${command}\` is red`);
  for (const item of input.extra ?? []) items.push(`  - ${item}`);
  const shown = items.slice(0, 6);
  const more = items.length > shown.length ? `\n  …and ${items.length - shown.length} more.` : '';
  return [
    'Before this turn ends: the request asked for things that are not satisfied yet, and the loop can name them.',
    ...shown,
    more,
    'Close them now — they are cheaper than another turn.',
    'If some genuinely cannot be done here, call `finish` with `verified:false` and put them in `unmet`, so the user is told instead of being given a rounded-up "done".',
  ]
    .filter(Boolean)
    .join('\n');
}
