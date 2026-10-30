/**
 * Output caps for tool results — the numbers in ONE place, and a window that
 * tells the model how much it is missing.
 *
 * WHY THIS EXISTS (measured 2026-10-25, Cline head-to-head). Each tool carried
 * its own cap and they were inconsistent: `run_terminal` returned **6 000** chars
 * while `read_file` returned 60 000, and Cline returns 48 000 for the same
 * command. The waste guard's own comment records the symptom — `npm test` run
 * FOUR times in one turn, each with a different output filter — because a 6 000
 * char window on a failing suite exposes the first few failures and nothing else,
 * and re-running is the only way the model can see the rest.
 *
 * The cap is not the fix by itself; the NOTICE is. A truncated window that says
 * "12 345 characters omitted from the middle, here is the first and last part,
 * narrow the command instead of re-running it" turns a dead end into a next
 * step. A silent cut teaches the model that the output it wanted does not exist.
 *
 * WHAT THIS DOES NOT DO: raise the thread budget. A bigger tool result is paid for
 * once in the thread and then carried by the provider's prefix cache (W1), which
 * is the only reason a 24 K window is affordable where a 6 K one was not.
 */

/**
 * Terminal output fed back to the model in one call.
 *
 * 24 000 chars ≈ 5–6 K tokens. That covers the head of a failing suite AND its
 * summary (which is where the pass/fail verdict lives) for the projects this
 * agent is used on, while staying under the point where a single result eats a
 * meaningful share of a small model's window (the loop clamps one result to half
 * the thread budget regardless — see `trimThreadBudget`).
 */
export const TERMINAL_OUTPUT_CAP = 24_000;

/** File reads are already 60 K; named here so no tool invents its own number. */
export const READ_OUTPUT_CAP = 60_000;

/** Search/list output: many short lines, so the same window as a command. */
export const SEARCH_OUTPUT_CAP = 24_000;

export interface OutputWindow {
  text: string;
  /** Characters dropped from the middle (0 when nothing was cut). */
  omittedChars: number;
  truncated: boolean;
}

/** `12,345` — a number a reader can parse at a glance. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Keep the first ~60 % and the last ~40 % of an oversized result, with a notice
 * that names both the loss and the next step.
 *
 * Head AND tail on purpose: a command's value is split between what it was doing
 * (the first lines: invocation, environment) and how it ended (the last lines: the
 * verdict, the failing assertion). Tail-only was the old behaviour for complete
 * buffers and it hid the second half of a failure list; head-only was the
 * foreground path and hid the verdict entirely.
 */
export function windowOutput(
  text: string,
  cap: number = TERMINAL_OUTPUT_CAP,
  opts: { tool?: string; hint?: string } = {},
): OutputWindow {
  const clean = text.replace(/\r\n/g, '\n');
  if (clean.length <= cap || cap <= 0) return { text: clean, omittedChars: 0, truncated: false };

  const headChars = Math.floor(cap * 0.6);
  const tailChars = cap - headChars;
  const head = clean.slice(0, headChars);
  const tail = clean.slice(clean.length - tailChars);
  const omitted = clean.length - head.length - tail.length;
  const who = opts.tool ? ` from ${opts.tool}'s output` : '';
  const hint =
    opts.hint ??
    'do NOT re-run this command to see more — narrow it instead (`grep -n`, `tail -n`, ' +
      "`--reporter=dot`, or `sed -n 'A,Bp' <file>` for a file it wrote)";

  return {
    text:
      `${head}\n\n… [${count(omitted)} characters omitted${who} — kept the first ` +
      `${count(head.length)} and the last ${count(tail.length)} of ${count(clean.length)}; ` +
      `${hint}] …\n\n${tail}`,
    omittedChars: omitted,
    truncated: true,
  };
}
