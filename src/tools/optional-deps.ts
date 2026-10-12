/**
 * Optional-tool install recipes (`nuvira tools install <name>`).
 *
 * WHY THIS EXISTS. Several tools are OPTIONAL by design — the heavy download is
 * the user's decision, not something a fresh clone should pay for. `browser`
 * (playwright) documents its own opt-in in its module header as
 * "`nuvira tools install browser`", and no such command existed: the docstring
 * described a surface the CLI did not have, so the only path was knowing the
 * npm incantation by heart. This module is the DATA TABLE behind that command.
 *
 * Two rules:
 *   1. A recipe names the package that MUST resolve for the tool to be
 *      available, so the result can be verified rather than announced. The
 *      `packageName` here is the same string the tool's own availability probe
 *      resolves — a test asserts the two agree, so the command cannot install
 *      one thing while the tool waits for another.
 *   2. A recipe never claims success. It states what it ran and what the probe
 *      says AFTER, and a missing binary download is reported as the remaining
 *      step rather than a failure of the whole install.
 *
 * Pure data + lookup — no spawn, no fs, so the CLI decides and the test asserts.
 */

export interface OptionalToolRecipe {
  /** Command argument: `nuvira tools install <id>`. */
  id: string;
  /** What the tool can do once installed, in the user's words. */
  enables: string;
  /**
   * The npm package whose resolvability IS the tool's availability. Must match
   * the probe in the tool module (asserted by test/optional-deps).
   */
  packageName: string;
  /** Install command for the package itself. */
  installPackage: string;
  /**
   * A one-time asset download the package needs before it can actually run
   * (playwright ships the driver, not the browser binary). Empty when none.
   */
  installBinaries?: string;
  /** What to do by hand when the automated install cannot run here. */
  manualHint: string;
}

export const OPTIONAL_TOOL_RECIPES: OptionalToolRecipe[] = [
  {
    id: 'browser',
    enables:
      'the `browser` tool — open/click/type/extract/screenshot on a real page, with the session persisting between calls (login flows, dynamic sites)',
    packageName: 'playwright',
    installPackage: 'npm install playwright',
    installBinaries: 'npx playwright install chromium',
    manualHint:
      'Install manually with `npm install playwright && npx playwright install chromium`. The chromium download is ~150 MB and only has to happen once.',
  },
];

/** Look a recipe up by id. Returns null for an unknown tool (never guesses). */
export function getOptionalToolRecipe(id: string): OptionalToolRecipe | null {
  const wanted = String(id ?? '').trim().toLowerCase();
  return OPTIONAL_TOOL_RECIPES.find((r) => r.id === wanted) ?? null;
}

/** One line per known tool, so `tools install` with no argument can list them. */
export function describeOptionalTools(): string[] {
  return OPTIONAL_TOOL_RECIPES.map((r) => `${r.id} — ${r.enables}`);
}
