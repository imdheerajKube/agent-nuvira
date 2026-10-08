/**
 * Effect declarations for nuvira's OWN confirmation-gated CLI intents.
 *
 * WHY THIS REPLACES THREE SETS. `autonomy-policy.ts` carried
 * `IRREVERSIBLE_CLI_INTENTS`, `RECOVERABLE_CLI_INTENTS` and
 * `EXTERNAL_CLI_INTENTS`. Membership was the ONLY fact each set carried, so "is it
 * reversible", "does its effect leave the machine" and "may a grant cover it" all
 * had to be re-derived by whoever read the call site.
 *
 * The two halves now agree BY CONSTRUCTION: this table declares each intent, and a
 * test asserts the declarations and the manifest's confirmation-gated intents are
 * the SAME set — so a newly gated command cannot ship without an effect, and a
 * removed one cannot leave a ghost.
 *
 * THE TRAP THE GUARD EXISTS FOR. `command-manifest.json` expresses gating in TWO
 * places: an intent's own `confirmation`, and `resolutions[].confirmation` for a
 * specific resolution of an intent. `contacts.remove` is gated ONLY through the
 * second, so a reader (or a parity check) that looks at the top-level flag alone
 * concludes it is a ghost and deletes it — which is what nearly happened while
 * building this table. The guard checks both forms.
 *
 * NOT A POLICY CHANGE. This moves an existing decision into one table; every
 * `grantCategory` and `reversible` below is what `run_cli` already computed
 * (external for publish, terminal for the recoverable system intents, nothing for
 * the irreversible local ones). Anything that would genuinely change gating
 * belongs in its own commit, not folded into a refactor.
 */

import type { EffectClass, GrantCategory } from './capability-types.js';

export interface CliIntentEffect {
  /** Matches an intent in `command-manifest.json` exactly. */
  intent: string;
  effectClass: EffectClass;
  /** Can re-running the agent undo it? */
  reversible: boolean;
  /** The session grant that may cover it (absent = NO grant can). */
  grantCategory?: GrantCategory;
  /** One sentence for a reader: why this verdict is what it is. */
  why: string;
}

const T = 'terminal' as const;

export const CLI_INTENT_EFFECTS: readonly CliIntentEffect[] = [
  // ── irreversible local: no grant may cover these, ever ──
  {
    intent: 'history.clear',
    effectClass: 'local-state',
    reversible: false,
    why: 'the conversation history is discarded; nothing re-runs it back',
  },
  {
    intent: 'memory.prune',
    effectClass: 'local-state',
    reversible: false,
    why: 'memories below the threshold are gone, and re-running cannot know which they were',
  },
  {
    intent: 'stats.cost.clear',
    effectClass: 'local-state',
    reversible: false,
    why: 'cost history is zeroed; the spends are not re-derivable',
  },
  // ── off-machine: grantable ONLY by an explicit off-machine grant ──
  {
    intent: 'publish',
    effectClass: 'external',
    reversible: false,
    grantCategory: 'external',
    why: 'a registry release leaves this machine and cannot be un-published',
  },
  // ── recoverable system intents: re-running the agent can put them back ──
  {
    intent: 'dashboard.stop',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a stopped service starts again',
  },
  {
    intent: 'gateway.stop',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a stopped gateway starts again',
  },
  {
    intent: 'permissions.disallow',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a removed RBAC grant is re-added by the matching allow',
  },
  {
    intent: 'platform.remove',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a removed platform is re-added from the same config',
  },
  {
    intent: 'health.selfheal',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'it applies fixes the doctor already diagnosed, and re-running is idempotent',
  },
  {
    intent: 'memory.optimize',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'it re-ranks and compacts memory; running it again converges',
  },
  {
    intent: 'cache.clear',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a cache rebuilds itself on the next use',
  },
  {
    intent: 'cron.remove',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a removed job is re-added with the same schedule',
  },
  {
    intent: 'skills.uninstall',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'an uninstalled skill reinstalls from the hub',
  },
  {
    // Gated through a RESOLUTION, not the intent's own flag — see the header.
    intent: 'contacts.remove',
    effectClass: 'local-state',
    reversible: true,
    grantCategory: T,
    why: 'a removed contact is re-added from the same config',
  },
];

const BY_INTENT = new Map(CLI_INTENT_EFFECTS.map((e) => [e.intent, e]));

/** The declaration for an intent, or undefined when it is not declared. */
export function cliIntentEffect(intent: string): CliIntentEffect | undefined {
  return BY_INTENT.get(intent);
}

/**
 * The derived gate facts for an intent — computed in ONE place so `run_cli`, the
 * policy and the consent picture cannot each derive them differently.
 */
export interface CliIntentGateFacts {
  /** The declaration, when the intent has one. */
  effect?: CliIntentEffect;
  /** A local-state change the envelope may cover and a `terminal` grant may cover. */
  recoverable: boolean;
  /** An off-machine effect, coverable only by the `external` grant. */
  external: boolean;
  /** The grant category that may cover it, when one can. */
  grantCategory?: GrantCategory;
}

export function cliIntentGateFacts(intent: string): CliIntentGateFacts {
  const effect = BY_INTENT.get(intent);
  const external = effect?.grantCategory === 'external';
  // NOTE the order: an external intent is NEVER "recoverable", even though
  // `publish` is the one declaration that is both irreversible and off-machine.
  // That is what keeps a blanket request from ever reaching it.
  const recoverable = effect?.reversible === true && !external;
  return {
    ...(effect ? { effect } : {}),
    recoverable,
    external,
    ...(effect?.grantCategory ? { grantCategory: effect.grantCategory } : {}),
  };
}

/** The declared intents, for the manifest parity guard and the consent picture. */
export function declaredCliIntents(): string[] {
  return CLI_INTENT_EFFECTS.map((e) => e.intent);
}
