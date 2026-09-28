/**
 * Number formatting with a PINNED locale.
 *
 * WHY THIS EXISTS. `n.toLocaleString()` follows the machine's default locale, so
 * one build printed `1,048,576` on an en-US box, `10,48,576` on en-IN and
 * `1.048.576` on de-DE. That is wrong twice over:
 *
 *   1. A count in a report, a log line, or a bug report is a FACT, and it must
 *      read the same on every machine.
 *   2. A locale-dependent value cannot be asserted deterministically. The
 *      dashboard chip suite and the long-form progress suite passed in CI and
 *      failed on a developer machine for exactly this reason, and de-DE renders a
 *      word count as `35.000`, which reads as a decimal rather than as 35,000.
 *
 * THE CONVENTION. Every user-visible number goes through {@link formatCount}.
 * This is the same choice the codebase already made in the places it pinned a
 * locale by hand (`toLocaleString('en-US')`, `toLocaleDateString('en-US', …)`) —
 * it is now made once, here, instead of at each call site.
 *
 * SCOPE. Numbers only. Dates still vary by machine in the sites that do not pass
 * a locale; that is a separate decision and is deliberately not covered here.
 *
 * The locale is `en-US` because the grouping is unambiguous: it separates every
 * three digits and never uses a character (a dot, a space, a narrow no-break
 * space) that another locale would read as a decimal point.
 */
const EN_US = new Intl.NumberFormat('en-US');

/** Format a count for display: `1048576` → `1,048,576`, on every machine. */
export function formatCount(n: number): string {
  return EN_US.format(n);
}
