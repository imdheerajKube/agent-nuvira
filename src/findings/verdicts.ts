/**
 * WS1 (#23) — a finding, its verdict, and the gate that keeps the two honest.
 *
 * WHY THIS EXISTS. This repository has already paid for the bug this closes: a
 * claim that was true-looking and unverified reached a user as fact. The tool
 * descriptions reported success for work that had not happened
 * (`docs/TOOL_TRUTHFULNESS_TRACKER.md`), the dashboard shipped a bundle that did
 * not contain a tab that had been written and reviewed, and a WhatsApp task
 * reported completion while the deliverable was never authored
 * (`docs/rca_false_success_and_no_resume.md`). Every one of those is the same
 * defect in a different costume: something was ASSERTED, nothing was CHECKED,
 * and the assertion travelled as if it had been.
 *
 * The codebase already knows the right shape for this and uses it in one place.
 * `src/nlu/learnings.ts` documents that "a learning is written ONLY when a
 * misreading has been CONFIRMED by the model", and `src/nlu/intent-confirm.ts`
 * is the probe that produces that confirmation. But the confirmation it produced
 * was the model saying so — an assertion about an assertion, with no evidence
 * attached. That is the gap: a verdict two-valued enough to be checked, and an
 * evidence requirement strong enough that "CONFIRMED" cannot be typed in.
 *
 * THE MODEL. A finding is a CLAIM plus a VERDICT plus an OUTCOME plus EVIDENCE:
 *
 *   claim    — what is being asserted, in the words the reader will see.
 *   verdict  — CONFIRMED (something was produced that a second party could
 *              check) or PLAUSIBLE (a reasoned guess). Binary on purpose: a
 *              0.7 confidence invites arithmetic on a number nobody calibrated,
 *              and the interesting question is only ever "can this be checked".
 *   outcome  — what became of it (kept, corrected, dropped, not persisted). A
 *              finding with no outcome is a status report, not a finding.
 *   evidence — the concrete things that were checked: a verbatim line, a command
 *              and its real output, a path. Never a restatement of the claim.
 *
 * THE GATE, and why it is enforced in code rather than by convention. A rule
 * that lives in a comment is a rule the next contributor is free to be
 * enthusiastic about. `confirmFinding` refuses a promotion with no usable
 * evidence and returns the finding STILL PLAUSIBLE with the reason attached —
 * a refusal, not a throw, because "we could not verify this" is a normal outcome
 * of a probe and must not take down the turn that asked. `enforceVerdicts` then
 * applies the same rule to a whole batch on the way OUT, so no code path —
 * including one written later by someone who never read this file — can emit a
 * CONFIRMED finding that carries nothing.
 *
 * TWO DELIBERATE LIMITS.
 *  1. This module does not decide what a finding MEANS or who may produce one.
 *     It is the vocabulary and the gate, so every surface can report the same
 *     shape and a reader can compare them (that is the parity requirement WS0
 *     exists to measure).
 *  2. It never invents evidence, and never treats its absence as failure of the
 *     finding: a PLAUSIBLE finding is a legitimate, useful, honest object. The
 *     only thing this module refuses is the promotion.
 */

/**
 * What a finding is worth, in the only two amounts that matter.
 *
 * - `CONFIRMED` — something was produced that a second party could check.
 * - `PLAUSIBLE` — reasoned, not verified. The default, and never a failure.
 */
export type Verdict = 'CONFIRMED' | 'PLAUSIBLE';

/**
 * The kinds of check that can produce evidence.
 *
 * `quote` is a verbatim span of the input (the part of a request a reading
 * depends on); `command` is a command line and its REAL output; `file` is a path
 * that was read; `observation` is a value a probe actually returned. Kept as a
 * closed set so a reader can tell how strong a piece of evidence is without
 * parsing prose — and so `describeFinding` can render it uniformly.
 */
export type EvidenceKind = 'quote' | 'command' | 'file' | 'observation';

/**
 * One check that was actually performed.
 *
 * `ref` is the evidence itself — the line, the command, the path — never a
 * summary of it. A blank `ref` is not evidence: it is the type satisfied and the
 * work skipped, which is precisely the defect this module exists to refuse.
 */
export interface Evidence {
  kind: EvidenceKind;
  ref: string;
  /** Optional context: the output, the surrounding line, the reason. */
  detail?: string;
}

/** A claim, its verdict, what became of it, and what was checked. */
export interface Finding {
  /** What is asserted, in the words the reader will see. */
  claim: string;
  verdict: Verdict;
  /** What became of the finding. Required: a finding with no outcome is a status report. */
  outcome: string;
  /** The checks behind a CONFIRMED verdict. Empty is legal — for a PLAUSIBLE one. */
  evidence: readonly Evidence[];
  /** Where the finding came from, so a reader can weigh it (`intent-confirm`, `review`, …). */
  source: string;
  /** When it was recorded. Volatile: never part of a comparison between surfaces. */
  at?: number;
}

/** The result of asking for a promotion, including the refusal. */
export interface Promotion {
  /** The finding AFTER the attempt — PLAUSIBLE and unchanged when refused. */
  finding: Finding;
  promoted: boolean;
  /** Why it was refused. Present exactly when `promoted` is false. */
  reason?: string;
}

/** What `plausibleFinding` needs. Everything else has a defensible default. */
export interface FindingInput {
  claim: string;
  outcome: string;
  source: string;
  evidence?: readonly Evidence[];
  at?: number;
}

/**
 * A usable piece of evidence: a non-blank `ref`.
 *
 * Whitespace-only is rejected rather than trimmed to "": a caller that passed
 * `' '` passed nothing, and accepting it would make the gate trivially avoidable.
 */
function isUsable(evidence: Evidence | undefined): boolean {
  return Boolean(evidence) && typeof evidence!.ref === 'string' && evidence!.ref.trim().length > 0;
}

/**
 * True when this finding carries anything that was actually checked.
 *
 * Exported because the question "is this checkable" is asked in more places than
 * the gate: a report renderer may want to group a batch by it, and a caller
 * deciding whether to spend a model call on verification wants it before, not
 * after.
 */
export function hasEvidence(finding: Finding): boolean {
  return finding.evidence.some(isUsable);
}

/**
 * The usable evidence on a finding, in order.
 *
 * A finding is normalised on the way in, so this is not a filter a caller must
 * remember to apply — it exists so a renderer can show the evidence and never
 * the blanks.
 */
export function evidenceOf(finding: Finding): Evidence[] {
  return finding.evidence.filter(isUsable);
}

/**
 * Record a claim that has NOT been checked.
 *
 * Deliberately the constructor: a finding cannot be BORN confirmed. Evidence can
 * only arrive through `confirmFinding`, so the gate cannot be bypassed by a
 * caller that helpfully knew the answer all along — the only way to a CONFIRMED
 * verdict is the function that requires the evidence.
 *
 * Evidence passed here is KEPT (a caller that did check something should not lose
 * it) but does not by itself promote the verdict; promotion is a separate,
 * explicit act. That keeps "what we know" and "what we decided" from collapsing
 * into one step that no one can audit.
 */
export function plausibleFinding(input: FindingInput): Finding {
  return {
    claim: input.claim,
    verdict: 'PLAUSIBLE',
    outcome: input.outcome,
    evidence: [...(input.evidence ?? [])],
    source: input.source,
    ...(input.at !== undefined ? { at: input.at } : {}),
  };
}

/**
 * Promote a PLAUSIBLE finding to CONFIRMED — or refuse, and say why.
 *
 * The refusal is the point of the module. It returns the finding UNCHANGED and
 * PLAUSIBLE rather than throwing, because "we could not check this" is the
 * ordinary outcome of a probe against a world that may be offline, and a probe
 * must never be able to take down the turn that asked it. Callers that need to
 * branch on the answer read `promoted`.
 *
 * A CONFIRMED finding cannot be promoted again (nothing to do), and a CONFIRMED
 * finding whose evidence is IMPOSSIBLE cannot exist: `enforceVerdicts` demotes
 * it. Both cases are reported rather than silently accepted.
 */
export function confirmFinding(
  finding: Finding,
  evidence: readonly Evidence[] = [],
  options: { outcome?: string; at?: number } = {},
): Promotion {
  const combined = [...finding.evidence, ...evidence];
  const outcome = options.outcome ?? finding.outcome;

  if (finding.verdict === 'CONFIRMED' && hasEvidence(finding)) {
    return {
      finding: { ...finding, outcome, ...(options.at !== undefined ? { at: options.at } : {}) },
      promoted: false,
      reason: 'already CONFIRMED — a verdict is recorded once, and the evidence that earned it is on the finding',
    };
  }

  if (!combined.some(isUsable)) {
    return {
      finding: { ...finding, outcome, evidence: combined, ...(options.at !== undefined ? { at: options.at } : {}) },
      promoted: false,
      reason:
        'no usable evidence — a CONFIRMED verdict means something was CHECKED, so it needs a command ' +
        'and its output, a path that was read, a quote from the input, or a value a probe returned. ' +
        'A restatement of the claim is not evidence, and a blank reference is not a check.',
    };
  }

  return {
    finding: {
      ...finding,
      verdict: 'CONFIRMED',
      outcome,
      evidence: combined,
      ...(options.at !== undefined ? { at: options.at } : {}),
    },
    promoted: true,
  };
}

/** Force a finding back to PLAUSIBLE, keeping why. The inverse of a promotion. */
export function demoteFinding(finding: Finding, why: string): Finding {
  if (finding.verdict === 'PLAUSIBLE') return finding;
  const note = finding.outcome.includes(why) ? finding.outcome : `${finding.outcome} — ${why}`;
  return { ...finding, verdict: 'PLAUSIBLE', outcome: note };
}

/**
 * The gate applied to a batch, on the way out.
 *
 * This is what makes the rule unfalsifiable-by-accident: ANY batch of findings
 * about to be reported, logged or persisted can be passed through here, and a
 * CONFIRMED verdict that carries nothing is demoted with the reason recorded in
 * its own outcome. `confirmFinding` protects the direct path; this protects the
 * paths nobody has written yet, including a finding assembled by hand in a
 * module that never imported `confirmFinding`.
 *
 * Returns the repaired findings AND the claims that were demoted, because a
 * silent repair would hide the wiring bug that produced the claim — the demotion
 * is correct behaviour, and its CAUSE is still something a caller should see.
 */
export function enforceVerdicts(
  findings: readonly Finding[],
  why = 'not promoted: no usable evidence',
): { findings: Finding[]; demoted: string[] } {
  const demoted: string[] = [];
  const repaired = findings.map((finding) => {
    if (finding.verdict !== 'CONFIRMED' || hasEvidence(finding)) return finding;
    demoted.push(finding.claim);
    return demoteFinding(finding, why);
  });
  return { findings: repaired, demoted };
}

/**
 * One action the RUN actually performed, as the loop observed it.
 *
 * Supplied to the gate so a finding's evidence can be checked against reality:
 * a `command` evidence ref is only as good as the command that really ran, and
 * a `file` ref only as good as the path that was really read or written. This is
 * the fact a finding's own prose cannot be.
 */
export interface ExecutedAction {
  /** The tool that ran (e.g. `run_terminal`, `read_file`). */
  tool: string;
  /** The shell command, for an exec tool. */
  command?: string;
  /** The path, for a file tool. */
  path?: string;
  /** Whether the tool reported success. Provenance does not require success —
   * a failing command is real evidence about a failure — but a caller may use it. */
  ok: boolean;
}

/** The outcome of checking a finding's evidence against the run's actions. */
export interface ProvenanceResult {
  /** The finding AFTER the check (demoted, and with fabricated refs dropped). */
  finding: Finding;
  /** Evidence refs that could NOT be corroborated by any executed action. */
  unproven: Array<{ kind: EvidenceKind; ref: string; reason: string }>;
  /** True when the finding was demoted to PLAUSIBLE because NOTHING it cited was corroborated. */
  demoted: boolean;
}

/** Normalize a command for comparison: trim, drop a `$`/backtick wrapper, collapse whitespace. */
function normCommand(text: string): string {
  return text
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/^`+|`+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Does a cited command correspond to a command that really ran?
 *
 * Deliberately tolerant about formatting (whitespace, `$`, backticks) and about
 * a wrapper — a model may cite `npm test` for `npm test -- --run`, and both are
 * the same check. Deliberately INTOLERANT about content: a command whose tokens
 * differ (`pyinstaller --clean -y x.spec` vs the `pyinstaller x.spec` that
 * actually ran) matches neither direction and is refused. Provenance is not
 * adjudicating whether the command SUCCEEDED — only whether it happened.
 */
function commandsMatch(ref: string, executed: string): boolean {
  const a = normCommand(ref);
  const b = normCommand(executed);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Normalize a path: strip a `./`, unify separators, drop trailing slashes. */
function normPath(text: string): string {
  return text
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Does a cited path correspond to a path that was really read or written? */
function pathsMatch(ref: string, executed: string): boolean {
  const a = normPath(ref);
  const b = normPath(executed);
  if (!a || !b) return false;
  if (a === b) return true;
  // Absolute vs relative of the same file — compare on a segment boundary so
  // `b.py` never matches `other-b.py`.
  return b.endsWith('/' + a) || a.endsWith('/' + b);
}

/**
 * Check a CONFIRMED finding's evidence against the actions the run actually
 * performed, and demote it when none of its checkable evidence is real.
 *
 * WHY THIS EXISTS. `confirmFinding` promotes on the PRESENCE of a non-blank
 * evidence ref, not its PROVENANCE — so a model that cannot type `CONFIRMED` can
 * still type a `command` ref for a command it never ran and have the finding
 * recorded as fact. That is the live failure this closes: a turn whose build
 * command FAILED (exit 1) and which then recorded a `CONFIRMED` finding citing
 * `pyinstaller --clean -y AukatCheck.spec` — a command that appears nowhere in
 * the run. See `docs/ISSUE_false-success_model-vs-framework.md`.
 *
 * RULES:
 *   - only CONFIRMED findings are checked; a PLAUSIBLE one is already honest;
 *   - only `command` and `file` refs are checkable — a `quote`/`observation`
 *     cannot be mechanically corroborated and is left alone (a residual, named
 *     in the docs);
 *   - an unproven ref is DROPPED from the finding (the gate never keeps evidence
 *     it could not verify);
 *   - if the finding had checkable evidence and NONE of it was corroborated, the
 *     finding is demoted to PLAUSIBLE with the refs and the reason in its
 *     outcome, so the report reads honestly rather than silently.
 *
 * Pure and deterministic — the caller supplies the actions, so this needs no
 * filesystem or run context of its own.
 */
export function enforceEvidenceProvenance(
  finding: Finding,
  actions: readonly ExecutedAction[],
): ProvenanceResult {
  if (finding.verdict !== 'CONFIRMED') return { finding, unproven: [], demoted: false };

  const usable = evidenceOf(finding);
  const checkable = usable.filter((e) => e.kind === 'command' || e.kind === 'file');
  if (checkable.length === 0) return { finding, unproven: [], demoted: false };

  const unproven: ProvenanceResult['unproven'] = [];
  const kept: Evidence[] = [];
  let corroborated = 0;

  for (const evidence of usable) {
    if (evidence.kind !== 'command' && evidence.kind !== 'file') {
      kept.push(evidence);
      continue;
    }
    const hit =
      evidence.kind === 'command'
        ? actions.some((a) => a.command !== undefined && commandsMatch(evidence.ref, a.command))
        : actions.some((a) => a.path !== undefined && pathsMatch(evidence.ref, a.path));
    if (hit) {
      corroborated += 1;
      kept.push(evidence);
    } else {
      unproven.push({
        kind: evidence.kind,
        ref: evidence.ref,
        reason:
          evidence.kind === 'command'
            ? 'no command matching this reference was executed this turn'
            : 'no file read or written this turn matches this reference',
      });
    }
  }

  if (corroborated === 0) {
    const cited = unproven.map((u) => `${u.kind} ${JSON.stringify(u.ref)}`).join(', ');
    const reason = `evidence not corroborated — ${cited} (${unproven[0]!.reason})`;
    return {
      finding: { ...demoteFinding(finding, reason), evidence: kept },
      unproven,
      demoted: true,
    };
  }

  // At least one checkable ref is real: the finding stands, but the refs that
  // could not be corroborated are stripped rather than kept on a CONFIRMED claim.
  return { finding: { ...finding, evidence: kept }, unproven, demoted: false };
}

/**
 * Claims carrying a CONFIRMED verdict and no usable evidence.
 *
 * The assertion form of `enforceVerdicts`, for a caller that would rather fail
 * than repair — a test, or a check that is about the producing code rather than
 * the report.
 */
export function unsupportedConfirmations(findings: readonly Finding[]): string[] {
  return findings
    .filter((finding) => finding.verdict === 'CONFIRMED' && !hasEvidence(finding))
    .map((finding) => finding.claim);
}

/**
 * The wire form: plain JSON a surface can log, return over IPC or write to a
 * report.
 *
 * Present so the five surfaces report a finding IDENTICALLY (the WS0 requirement)
 * rather than each inventing a shape — a gateway log line and a child's IPC frame
 * that disagree about a verdict are a parity failure nobody would notice until a
 * user compared two outputs. `at` is deliberately excluded: it differs on every
 * invocation, so comparing it would fail for surfaces that behave identically,
 * the same reason `observation.ts` keeps timing out of the compared projection.
 */
export interface WireFinding {
  claim: string;
  verdict: Verdict;
  outcome: string;
  evidence: Array<{ kind: EvidenceKind; ref: string; detail?: string }>;
  source: string;
}

/** One finding, reduced to the comparable wire form. */
export function toWire(finding: Finding): WireFinding {
  return {
    claim: finding.claim,
    verdict: finding.verdict,
    outcome: finding.outcome,
    evidence: evidenceOf(finding).map((e) => ({
      kind: e.kind,
      ref: e.ref,
      ...(e.detail ? { detail: e.detail } : {}),
    })),
    source: finding.source,
  };
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['quote', 'command', 'file', 'observation'];

/**
 * Read a finding back off the wire, defensively.
 *
 * Returns `undefined` for anything malformed rather than guessing, and — the
 * part that matters — a payload claiming CONFIRMED with no usable evidence comes
 * back PLAUSIBLE. A reader on the other side of an IPC boundary or a log file
 * cannot trust the producer, so the gate is re-applied on the way in rather than
 * assumed to have been applied on the way out.
 */
export function fromWire(value: unknown): Finding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<WireFinding>;
  if (typeof raw.claim !== 'string' || !raw.claim.trim()) return undefined;
  if (typeof raw.outcome !== 'string') return undefined;
  if (typeof raw.source !== 'string') return undefined;
  if (raw.verdict !== 'CONFIRMED' && raw.verdict !== 'PLAUSIBLE') return undefined;

  const evidence: Evidence[] = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter(
          (e): e is { kind: EvidenceKind; ref: string; detail?: string } =>
            Boolean(e) &&
            typeof e === 'object' &&
            EVIDENCE_KINDS.includes((e as { kind: EvidenceKind }).kind) &&
            typeof (e as { ref?: unknown }).ref === 'string',
        )
        .map((e) => ({
          kind: e.kind,
          ref: e.ref,
          ...(typeof e.detail === 'string' && e.detail ? { detail: e.detail } : {}),
        }))
    : [];

  const finding: Finding = {
    claim: raw.claim,
    verdict: raw.verdict,
    outcome: raw.outcome,
    evidence,
    source: raw.source,
  };
  // Re-applied, not trusted: see the docstring.
  return enforceVerdicts([finding]).findings[0]!;
}

/** How one piece of evidence reads. */
function describeEvidence(evidence: Evidence): string {
  const label = evidence.kind === 'command' ? 'ran' : evidence.kind === 'file' ? 'read' : evidence.kind;
  return `${label} ${evidence.kind === 'quote' ? `"${evidence.ref}"` : evidence.ref}${
    evidence.detail ? ` (${evidence.detail})` : ''
  }`;
}

/**
 * One line a person reads, used everywhere so two surfaces cannot render the
 * same finding two ways.
 *
 * The evidence is shown for a CONFIRMED verdict and the reason for a PLAUSIBLE
 * one, because those are the two things a reader needs to decide whether to
 * trust the line — and printing a confidence number neither of them can act on
 * is how a report starts lying politely.
 */
export function describeFinding(finding: Finding): string {
  const head = `${finding.verdict === 'CONFIRMED' ? '✅' : '🔎'} ${finding.claim} — ${finding.outcome}`;
  const evidence = evidenceOf(finding);
  if (finding.verdict === 'CONFIRMED' && evidence.length > 0) {
    return `${head}\n  evidence: ${evidence.map(describeEvidence).join('; ')}`;
  }
  return `${head}\n  no evidence — reported as PLAUSIBLE, not verified.`;
}

/**
 * A batch, summarised: how many are confirmed, and how many are still guesses.
 *
 * Exists so a caller cannot report a total without also having to look at the
 * split. "12 findings" reads as twelve facts; "12 findings (3 confirmed, 9
 * plausible)" cannot.
 */
export function summarizeVerdicts(findings: readonly Finding[]): string {
  const confirmed = findings.filter((f) => f.verdict === 'CONFIRMED' && hasEvidence(f)).length;
  const plausible = findings.length - confirmed;
  return `${findings.length} finding(s): ${confirmed} confirmed, ${plausible} plausible`;
}
