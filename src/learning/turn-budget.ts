/**
 * THE WALL CLOCK FOR ONE TURN.
 *
 * WHY THIS EXISTS (measured 2026-10-27). Every budget the loop had counted STEPS, and
 * a step is not a unit of time. The nuvira arm of the head-to-head spent its last ten
 * minutes debugging a Playwright runner that would not start and closed the turn with
 * no README; the Cline arm finished in 48 minutes and shipped 42 paths of OpenAPI. The
 * loop could not tell those two situations apart, because it never knew what time it
 * was.
 *
 * A step count is also the wrong shape for the user's side of the contract: what a
 * person allocates to a task is MINUTES, and what they expect when it runs out is a
 * delivered, honestly-described result — not silence from an external `timeout`.
 *
 * So the budget is stated once, here, in minutes:
 *
 *   - `turn.maxMinutes` in the config sets it (`nuvira config set turn.maxMinutes 30`);
 *   - `0` disables it, which restores the step-only behaviour exactly;
 *   - absent means the default below.
 *
 * Sixty minutes is chosen from the only evidence there is: the benchmark harness capped
 * every arm at 60, the winning arm used 48, and a coding CLI turn beyond an hour is
 * almost always one that is stuck rather than productive. The closing window the loop
 * derives from it (20%) then reserves about twelve minutes for writing the handover and
 * answering — which is precisely the stretch the measured failure spent on Playwright.
 *
 * WHAT THIS IS NOT: a kill switch. The loop does not truncate a productive turn at the
 * bell; it stops OPENING work and spends the reserved time closing (see
 * `ToolLoopOptions.maxDurationMs`).
 */

/** Default budget for one turn, in minutes. */
export const TURN_BUDGET_DEFAULT_MINUTES = 60;
/** A budget below this is a mistake, not an intention. */
export const TURN_BUDGET_MIN_MINUTES = 1;
/** ...and above this it is indistinguishable from "no budget". */
export const TURN_BUDGET_MAX_MINUTES = 24 * 60;

export interface TurnBudget {
  /** `false` when the user turned the wall clock off (`turn.maxMinutes: 0`). */
  enabled: boolean;
  /** The budget in milliseconds; `undefined` when disabled. */
  ms?: number;
  /** The budget in minutes, for a message a person reads. */
  minutes?: number;
  /** Where the number came from, so the trace can say why a turn closed. */
  source: 'config' | 'default' | 'off';
}

/** The shape this needs from a config manager (the same one `toolsets.ts` uses). */
interface ConfigManagerLike {
  getAll?: () => unknown;
}

/**
 * Resolve the turn budget.
 *
 * A config that cannot be read yields the DEFAULT rather than "no budget": a broken
 * config should not silently remove the only protection against a turn that never
 * closes, and the default is the behaviour a fresh install gets anyway.
 */
export function resolveTurnBudget(cm?: ConfigManagerLike): TurnBudget {
  let minutes: unknown;
  try {
    minutes = (cm?.getAll?.() as { turn?: { maxMinutes?: unknown } } | undefined)?.turn?.maxMinutes;
  } catch {
    minutes = undefined;
  }
  if (minutes === 0) return { enabled: false, source: 'off' };
  const numeric = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes) : undefined;
  const chosen =
    numeric === undefined
      ? TURN_BUDGET_DEFAULT_MINUTES
      : Math.min(TURN_BUDGET_MAX_MINUTES, Math.max(TURN_BUDGET_MIN_MINUTES, numeric));
  return {
    enabled: true,
    ms: chosen * 60_000,
    minutes: chosen,
    source: numeric === undefined ? 'default' : 'config',
  };
}
