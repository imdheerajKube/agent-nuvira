/**
 * Capability mode — the one switch that decides how much the agent spends on
 * REASONING versus how much it saves.
 *
 * The product decision behind it: an agent is judged on whether it DELIVERS on
 * the ask, with depth, and navigates its own failures — and a single bad
 * experience is enough to lose a user. Cost-saving that produces a weak, nagging
 * agent is a false economy. But cost is real, so the user owns the trade:
 *
 *   - `balanced` (DEFAULT) — the agent uses the best model available for
 *     COMPLEX/CRITICAL work, cheaper models for simple/moderate work, and
 *     escalates when it detects a real stall. This is the recommended default:
 *     ~most of the reliability at a fraction of the cost.
 *   - `max` — cost is not a concern. Every turn routes to the strongest
 *     available model, paid models are always allowed, cost ceilings are lifted,
 *     and the loop is given the longest reasoning budget. This is "let the agent
 *     act with full depth, whatever it costs."
 *
 * What it deliberately does NOT change: every deterministic SAFETY invariant
 * (deny-first commands, the workspace boundary, the git gates, effect
 * verification). A model must never decide what is destructive, in either mode —
 * so this switch can widen AUTONOMY and MODEL QUALITY, never the safety surface.
 *
 * Resolution order (highest wins): the process environment (`NUVIRA_CAPABILITY_MODE`
 * or the legacy `BUFF_CAPABILITY_MODE`), then `routing.capabilityMode` in the
 * config file, then the default. Read fresh on every turn, so a change applies to
 * the next turn without a restart — the same rule the size limits follow.
 */

import type { ConfigManager } from './manager.js';
import type { ReasoningEffort } from './types.js';

/** The two modes. `balanced` is the default; `max` ignores cost. */
export type CapabilityMode = 'balanced' | 'max';

/**
 * `max` mode's model-level REASONING floor — the difference between "prefer
 * strong" (a scoring nudge that a cheap-but-strong-enough model can still win)
 * and "require strong" (a hard eligibility gate). This is what makes the max
 * promise checkable: candidates whose SERVED model scores below it are
 * eliminated.
 *
 * 0.7 is the same calibration the router already trusts for the asks that must
 * not be served by a weak model (effect-observing `verification`/`debugging`,
 * and `planning`): it drops stacked fast-lite ids (`…-flash-lite` ≈ 0.65) and
 * small models, while keeping a 70B id (≈ 0.80), a single `-flash` id (≈ 0.75)
 * and frontier-family ids. It is NEVER a dead-end — the router's benign
 * fallback restores the full ranking when the floor would eliminate everyone,
 * so a deployment whose only credentialed provider is weak still gets served.
 */
export const MAX_CAPABILITY_MIN_REASONING = 0.7;

/**
 * The reasoning depth `max` requests from a routed model, when that model is
 * verified to accept a reasoning-effort parameter. `high` is the strongest
 * value the OpenAI-compatible family accepts, and the largest thinking budget
 * for the native families — i.e. "as much as this model will give."
 */
export const MAX_CAPABILITY_REASONING_EFFORT: ReasoningEffort = 'high';

/** The default when nothing is configured. */
export const DEFAULT_CAPABILITY_MODE: CapabilityMode = 'balanced';

/** Env names, `NUVIRA_*` first with the legacy `BUFF_*` alias accepted. */
const ENV_NAMES = ['NUVIRA_CAPABILITY_MODE', 'BUFF_CAPABILITY_MODE'];

/**
 * Parse a raw value into a mode. Accepts the two canonical names plus the
 * intuitive synonyms a user might type, so a typo cannot silently leave the
 * agent on the cheaper mode when the user asked for maximum depth:
 *   - `max` / `maximum` / `unlimited` / `performance` / `performance-first` → 'max'
 *   - `balanced` / `balance` / `default` → 'balanced'
 * Returns null for anything unrecognized (the caller then falls through to the
 * next source rather than guessing).
 */
export function parseCapabilityMode(raw: string | undefined | null): CapabilityMode | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'max' || v === 'maximum' || v === 'unlimited' || v === 'performance' || v === 'performance-first') {
    return 'max';
  }
  if (v === 'balanced' || v === 'balance' || v === 'default') return 'balanced';
  return null;
}

/**
 * The effective capability mode for this process.
 *
 * Reads the environment first (a shell export wins over the file, exactly like
 * every other process switch), then the config file, then the default. Pure and
 * never throws — a config read failure falls back to the default rather than
 * breaking a turn.
 */
export function resolveCapabilityMode(cm?: ConfigManager): CapabilityMode {
  for (const name of ENV_NAMES) {
    const parsed = parseCapabilityMode(process.env[name]);
    if (parsed) return parsed;
  }
  try {
    const routing = cm?.getAll?.()?.routing as { capabilityMode?: unknown } | undefined;
    const parsed = parseCapabilityMode(typeof routing?.capabilityMode === 'string' ? routing.capabilityMode : undefined);
    if (parsed) return parsed;
  } catch {
    // Best-effort — a config failure must not break routing.
  }
  return DEFAULT_CAPABILITY_MODE;
}

/** True when the user has asked for maximum capability (cost is not a concern). */
export function isMaxCapability(cm?: ConfigManager): boolean {
  return resolveCapabilityMode(cm) === 'max';
}

/**
 * The routing knobs a capability mode implies — the SINGLE mapping consumed by
 * the resolve-options assembly, so every entry point (chat, execute, orchestrator)
 * reads the mode the same way and no surface gets a degraded routing experience.
 *
 * `balanced` leaves every knob untouched (`undefined` = "use the configured
 * value"), so the existing behaviour is byte-identical when the mode is default.
 * `max` applies the cost-relaxing overrides:
 *   - `preferenceMode: 'performance-first'` — the router stops preferring cheap
 *     candidates and scores on capability;
 *   - `allowPaid: true` — paid/high-capacity models are always eligible, even
 *     for simple tasks;
 *   - `maxCostUsd: undefined` — no per-call cost ceiling;
 *   - `minReasoning: MAX_CAPABILITY_MIN_REASONING` — require a strong served
 *     model (see the constant), so "max" cannot be satisfied by a cheap, weak
 *     model that merely happens to be allowed.
 */
export interface CapabilityRoutingPolicy {
  preferenceMode?: 'balanced' | 'performance-first';
  allowPaid?: boolean;
  maxCostUsd?: number;
  /** Served-model reasoning floor (0–1); candidates below it are eliminated. */
  minReasoning?: number;
  /**
   * Provider-neutral request for more reasoning depth, applied at the adapter
   * boundary ONLY when the routed provider × model has been verified to accept
   * the corresponding parameter (default-deny; see reasoning-effort.ts).
   * `balanced` leaves this undefined (no request-side change at all); `max`
   * asks for the strongest reasoning a model supports. This is the ceiling the
   * routing floor alone cannot raise: a floor PICKS a strong model, this asks
   * that model to THINK harder.
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * The reasoning depth the current capability mode asks for, or `undefined`
 * when the mode does not request one (`balanced`). Convenience over
 * `capabilityRoutingPolicy(resolveCapabilityMode(cm))` for call sites that
 * only need this one knob. Reading it is cheap and never throws.
 */
export function capabilityReasoningEffort(cm?: ConfigManager): ReasoningEffort | undefined {
  return capabilityRoutingPolicy(resolveCapabilityMode(cm)).reasoningEffort;
}

/** The routing policy for a mode. `balanced` returns an empty object (no overrides). */
export function capabilityRoutingPolicy(mode: CapabilityMode): CapabilityRoutingPolicy {
  if (mode === 'max') {
    return {
      preferenceMode: 'performance-first',
      allowPaid: true,
      maxCostUsd: undefined,
      // Not just "prefer capability" — require it. A paid-but-weak model must
      // not satisfy a mode whose whole promise is "the strongest model."
      minReasoning: MAX_CAPABILITY_MIN_REASONING,
      // And having PICKED a strong model, ask it to reason deeply. Gated
      // per-model (default-deny) so this can never break a model that lacks the
      // parameter. See reasoning-effort.ts.
      reasoningEffort: MAX_CAPABILITY_REASONING_EFFORT,
    };
  }
  return {};
}
