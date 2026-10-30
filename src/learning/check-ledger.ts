/**
 * Check ledger — a red check must be ANSWERED, not outlived.
 *
 * WHY THIS EXISTS (measured 2026-10-25). The verification gate asks "did anything
 * observe the change", and a failing run answers it: `npm test` reported 3 failing
 * specs, the turn edited two files, answered "the tests pass", and every gate was
 * satisfied because *a* check had run. The competing agents on the same task showed
 * the missing loop explicitly — failing command → diagnosis → green re-run — and
 * nuvira's transcript had the failing command and then prose.
 *
 * The loop already records every action it took (`executedActions`), in order. This
 * module reads that record and answers two questions with no model and no clock:
 *
 *   1. which checks last ended RED, and
 *   2. whether the workspace changed AFTER that verdict (so the red one is stale
 *      and the honest move is to re-run it) or has not changed at all.
 *
 * It deliberately does not decide whether the failure MATTERS. A red check may be a
 * flaky integration test the user knows about; the rule is that the turn has to say
 * so, not that the check must be made green by any means.
 */

/** One check the turn ran, as the loop observed it. */
export interface CheckRun {
  /** The command text, or a stable label for a non-terminal check. */
  command: string;
  tool: string;
  ok: boolean;
  /** How many workspace mutations had landed when this check ran. */
  afterWrites: number;
  /**
   * What the command exercised (`classifyCheck(...).kinds`). Used to keep this
   * rule to the project's OWN checks: a `node --check missing.js` probe or a
   * one-off script that exits non-zero is not a red suite, and nagging it would
   * be the loop arguing with an experiment the model already explained.
   *
   * Absent → the caller has already decided the run is a check.
   */
  kinds?: readonly string[];
  /**
   * How many failures the OUTPUT reported, when the output said so.
   *
   * This is what separates "the suite this turn broke" from "the suite was already
   * red when the turn arrived" — the difference between a real regression and a
   * repo nobody could get green (see {@link unansweredRedChecks}). Undefined when
   * the output did not name a count: the rule then falls back to the old, stricter
   * reading rather than guessing.
   */
  failing?: number;
}

/** The kinds that make a failed command a RED CHECK rather than a failed experiment. */
const REAL_CHECK_KINDS: ReadonlySet<string> = new Set(['tests', 'typecheck', 'lint', 'build']);

export interface RedCheck {
  command: string;
  tool: string;
  /** The workspace changed after this verdict, so the verdict is stale. */
  stale: boolean;
  /** How many mutations landed after it. */
  writesSince: number;
  /**
   * The check was ALREADY failing before this turn changed anything, and it has not
   * got worse (same command, latest failure count ≤ the first run's).
   *
   * A pre-existing failure is a fact about the repository, not a contradiction of
   * this turn's work: no amount of correct work on the task makes a 113-failure
   * baseline go green, and a turn that chases it burns steps on someone else's bug.
   * It stays visible (the answer must still say the suite is red) but it stops
   * being a reason to refuse `finish`. Only claimed when the counts are KNOWN and
   * did not increase — a missing count keeps the stricter reading.
   */
  preExisting?: boolean;
  /** The failure count on the first (pre-edit) run, when it was known. */
  baseline?: number;
}

/**
 * The failure count a test runner printed, when it printed one.
 *
 * Deliberately conservative — one number, from the shapes the benchmark's projects
 * actually emit (`125 failed`, `FAILED (failures=3, errors=17)`, `3 tests failed`).
 * No count, no claim: the caller keeps the stricter verdict rather than assume.
 */
export function parseFailingCount(output: string): number | undefined {
  const text = String(output ?? '');
  const patterns = [
    /(\d+)\s+(?:tests?\s+)?failed\b/i,
    /failures?\s*=\s*(\d+)/i,
    /\((\d+)\s+(?:tests?\s+)?fail(?:ed|ures)\b/i,
  ];
  let best: number | undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value)) continue;
    // The FIRST shape that matches wins: `125 failed, 487 passed` is the count, and
    // a later `failures=3` inside a summary table must not overwrite it.
    best = value;
    break;
  }
  if (best === undefined) return undefined;
  // An "errors=17" style run reports failures AND errors; the run is red either way,
  // and the count that matters for comparison is their sum when both are named.
  const errors = /errors?\s*=\s*(\d+)/i.exec(text);
  if (errors && /failures?\s*=\s*\d+/i.test(text)) {
    const n = Number.parseInt(errors[1], 10);
    if (Number.isFinite(n)) return best + n;
  }
  return best;
}

/**
 * The checks whose LATEST outcome was a failure.
 *
 * Last-run-wins is the whole rule: a command that failed and was then re-run green
 * is answered, and re-nagging it would be the loop arguing with its own evidence.
 * `writes` is the turn's mutation count at the moment the question is asked.
 */
export function unansweredRedChecks(runs: readonly CheckRun[], writes: number): RedCheck[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    if (!run.command) continue;
    if (run.kinds && !run.kinds.some((kind) => REAL_CHECK_KINDS.has(kind))) continue;
    latest.set(run.command, run);
  }
  const out: RedCheck[] = [];
  for (const run of latest.values()) {
    if (run.ok) continue;
    const writesSince = Math.max(0, writes - run.afterWrites);
    // THE BASELINE: the first run of this command, before the turn had changed
    // anything. Only a run taken on an untouched tree can say what the repo looked
    // like when the turn arrived.
    const first = runs.find((r) => r.command === run.command);
    const baseline =
      first && first.afterWrites === 0 && !first.ok ? first.failing : undefined;
    const worsened = baseline !== undefined && run.failing !== undefined ? run.failing > baseline : true;
    const preExisting =
      first !== undefined && first.afterWrites === 0 && !first.ok && !worsened;
    out.push({
      command: run.command,
      tool: run.tool,
      stale: writesSince > 0 && !preExisting,
      writesSince,
      ...(preExisting ? { preExisting: true } : {}),
      ...(baseline !== undefined ? { baseline } : {}),
    });
  }
  // Stale failures first (a re-run can answer them), then the ones that still
  // fail on the current tree.
  return out.sort((a, b) => Number(b.stale) - Number(a.stale));
}

/** The nudge: name the command, say whether it is stale, and demand an answer. */
export function redCheckNudge(red: readonly RedCheck[]): string {
  const lines = red.slice(0, 3).map((r) => {
    if (r.preExisting) {
      return `  - \`${r.command}\` was ALREADY red before you changed anything${r.baseline !== undefined ? ` (${r.baseline} failure(s) on the first run)` : ''} and is not worse now — it is the repository's own state, not this turn's work`;
    }
    if (r.stale) {
      return `  - \`${r.command}\` FAILED, and the code changed ${r.writesSince} time(s) afterwards without re-running it`;
    }
    return `  - \`${r.command}\` FAILED and has not passed since`;
  });
  return [
    'A check this turn ran ended RED. That is a fact the turn must answer, not outlive.',
    ...lines,
    'Fix it and re-run the SAME command, or — if the failure is pre-existing, unrelated, or environmental — say exactly that in your answer, quoting the failing output.',
    'Do not describe the work as verified, working or complete while its check is red.',
  ].join('\n');
}
