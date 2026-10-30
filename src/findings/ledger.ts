/**
 * Findings ledger — what earlier runs in THIS project already settled, so a later
 * run does not re-derive it (and does not re-raise what was already withdrawn).
 *
 * WHY THIS EXISTS (the gap the freebuff-vs-nuvira head-to-head measured):
 * A run records its findings on its own trace (`recordTraceFindings`), and the
 * trace is a good record — claim, verdict, outcome, evidence, gated so a
 * CONFIRMED cannot be typed in. But it is stored per RUN and keyed by nothing a
 * later run can ask for. So the audit that found the retired default judge model,
 * or the withdrawn hypothesis about `--full-run` counting, left its conclusions in
 * a file the next run never opened. The work was done and then thrown away: a
 * second pass over the same tree paid for every one of those conclusions again,
 * and could even re-raise a claim a previous pass had already disproved.
 *
 * This module is the READER, not a second store. It projects the findings already
 * persisted on traces, filtered to the current project, into the two states that
 * change what a next run should do:
 *
 *   - `CONFIRMED` — checked, with evidence. Do not re-derive: build on it.
 *   - `WITHDRAWN` — checked, then retracted, with the reason. Do not re-raise:
 *     the ground is settled in the negative direction.
 *
 * `PLAUSIBLE` is deliberately NOT recalled by default. A guess from a previous run
 * is not knowledge, and injecting it would make an old hunch look like a
 * conclusion — the exact failure the gate in `verdicts.ts` exists to prevent.
 * Callers that want it can ask for it explicitly.
 *
 * Scoping. A trace carries `workingDirectory` (added for this reason); a trace
 * WITHOUT one is skipped rather than attributed by goal text. Guessing which
 * project a finding belongs to is how a conclusion about one codebase leaks into
 * another, and a missed recall is cheap where a wrong recall is not.
 *
 * Everything here is deterministic, bounded and best-effort. No model call, no
 * new file on disk.
 */

import { listTraces } from '../learning/reasoning-trace.js';
import { normalizeProjectPath } from '../learning/working-state.js';
import { evidenceOf, type Verdict, type WireFinding } from './verdicts.js';

/** A finding recalled from a prior run, with the run that recorded it. */
export interface RecalledFinding extends WireFinding {
  /** The trace the finding was recorded on (`trace-…`). */
  runId: string;
  /** When that run started, for ordering and for a reader's \"how old is this\". */
  at?: number;
}

/** What to recall. Every field has a defensible default. */
export interface RecallOptions {
  /** Cap on findings returned (the block is bounded — it rides in a prompt). */
  max?: number;
  /** How many recent traces to scan. A deep history costs reads, not model time. */
  traces?: number;
  /** Which verdicts count as settled. Defaults to CONFIRMED + WITHDRAWN. */
  verdicts?: readonly Verdict[];
}

/**
 * The verdicts a later run should be told about.
 *
 * PLAUSIBLE is not among them on purpose: see the module docstring. A caller that
 * wants the guesses too passes `verdicts` explicitly, and takes responsibility for
 * the prompt weight and for the impression it creates.
 */
const SETTLED_VERDICTS: readonly Verdict[] = ['CONFIRMED', 'WITHDRAWN'];

/**
 * A claim's identity for dedupe: case, spacing and a trailing full stop are noise.
 *
 * Two runs that recorded "Banker's rounding makes 5/8 and 3/8 publish the same CI"
 * and the same sentence with different punctuation made ONE claim, and a reader
 * must not be shown both. Nothing cleverer (no embeddings, no stemming) — a false
 * merge would hide a distinct finding, and that is worse than a duplicate.
 */
function claimKey(claim: string): string {
  return (claim || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]$/, '');
}

/**
 * The findings earlier runs in this project settled, newest first, deduped by claim.
 *
 * Newest wins, INCLUDING when the newest occurrence is a verdict we are not
 * recalling. That order matters: if run 1 confirmed a claim and run 2 withdrew it,
 * the withdrawal is what the next run must see; if run 2 merely called it plausible
 * again, resurrecting run 1's confirmation would report a conclusion the project
 * has since stopped asserting.
 */
export function findingsForProject(
  projectPath: string,
  opts: RecallOptions = {},
): RecalledFinding[] {
  try {
    const project = normalizeProjectPath(projectPath || '');
    if (!project) return [];
    const wanted = new Set<Verdict>(opts.verdicts ?? SETTLED_VERDICTS);
    const max = opts.max && opts.max > 0 ? opts.max : 8;
    const out: RecalledFinding[] = [];
    const seen = new Set<string>();

    for (const trace of listTraces(opts.traces && opts.traces > 0 ? opts.traces : 50)) {
      // No project on the trace = no claim about which project it is about.
      if (!trace.workingDirectory) continue;
      if (normalizeProjectPath(trace.workingDirectory) !== project) continue;
      for (const finding of trace.findings ?? []) {
        const key = claimKey(finding.claim);
        if (!key) continue;
        // NEWEST WINS — marked seen before the verdict filter, on purpose.
        if (seen.has(key)) continue;
        seen.add(key);
        if (!wanted.has(finding.verdict)) continue;
        out.push({
          ...finding,
          runId: trace.id,
          ...(typeof trace.startedAt === 'number' ? { at: trace.startedAt } : {}),
        });
        if (out.length >= max) return out;
      }
    }
    return out;
  } catch {
    // Best-effort: a ledger read must never break the turn that asked.
    return [];
  }
}

/** One line per recalled finding: what was settled, on what basis, in which run. */
function describeRecalled(finding: RecalledFinding): string {
  const icon = finding.verdict === 'CONFIRMED' ? '✅' : '⛔';
  const evidence = evidenceOf(finding)
    .slice(0, 2)
    .map((e) => `${e.kind} ${e.ref}`)
    .join('; ');
  return `• ${icon} ${finding.claim} — ${finding.outcome}${
    evidence ? ` (${evidence})` : ''
  } [${finding.runId}]`;
}

/**
 * The block a turn injects: settled findings from earlier runs in this project.
 *
 * Returns '' when there is nothing settled, so a project with no history adds no
 * prompt weight — the same rule the working-state block follows. Best-effort
 * throughout.
 */
export function findingsBlockFor(projectPath: string, opts: RecallOptions = {}): string {
  try {
    const findings = findingsForProject(projectPath, opts);
    if (findings.length === 0) return '';
    return [
      '[Findings ledger — settled by EARLIER RUNS in this project]',
      ...findings.map(describeRecalled),
      'Do not re-derive these. Re-check one only if the files it cites have changed since that run;',
      'do not re-raise a ⛔ claim at all — it was checked and retracted, and the reason is on the line.',
    ].join('\n');
  } catch {
    return '';
  }
}
