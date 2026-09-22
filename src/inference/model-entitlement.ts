/**
 * Model Entitlement — what a model would COST, labelled honestly.
 *
 * WHY THIS EXISTS. The Models page's headline was a LISTING count sold as a
 * capability count ("509 available" while the router could reach 12). The
 * mirror-image mistake is equally easy to make the other way: filtering the page
 * to "free models only" would hide exactly the models a user just paid for. A
 * user who buys $20 of OpenRouter credits and sees nothing appear concludes the
 * purchase failed — the same class of lie, pointing the other direction.
 *
 * So this module only LABELS. It never filters, never hides, and never claims
 * more than the evidence supports:
 *
 *   free     — provably no per-call cost: a keyless runtime on this machine, or
 *              an id the PROVIDER ITSELF declares free (`:free` suffix).
 *   metered  — the provider lists a non-zero per-token price. A call bills at
 *              that rate unless the account's free tier/credits cover it — which
 *              is a property of the KEY, not the model.
 *   unknown  — the catalog carries no price for this provider, so there is
 *              nothing to say.
 *
 * THE RULE THAT MATTERS MOST: a zero price in the catalog is NOT "free". The
 * catalog carries `0/0` for Gemini, and the codebase's own auto-router notes
 * that *"Gemini paid models 403 without billing"* — so treating 0 as free would
 * reproduce, in a new place, the exact over-claim the Models-page audit removed.
 * Only a provider-declared free id or a local runtime earns `free`.
 */

import { getCatalogProvider, isCatalogKeyless } from './provider-catalog.js';

/** What a model is expected to cost a caller. */
export type EntitlementTier = 'free' | 'metered' | 'unknown';

export interface ModelEntitlement {
  tier: EntitlementTier;
  /**
   * Why we say so, in one phrase. Shown as the cell's tooltip so the label is
   * auditable rather than an unsourced badge.
   */
  basis: string;
}

/**
 * Keyless providers that are genuine LOCAL RUNNERS — inference happens on this
 * machine, so a call cannot bill anyone.
 *
 * `nuvira` is deliberately NOT here even though it is also keyless and also
 * localhost: it is the GATEWAY, whose whole job is forwarding to other
 * providers. A call through it costs whatever the provider behind it costs, so
 * labelling it free would be wrong in the most expensive direction.
 */
const LOCAL_RUNTIME_IDS = ['local', 'lmstudio', 'vllm', 'ollama'] as const;

/** The suffix OpenRouter uses for ids the provider declares free to serve. */
const PROVIDER_FREE_SUFFIX = ':free';

/** Format a per-1K-token price for a tooltip (4 significant decimals, trimmed). */
function fmtPrice(n: number): string {
  return `$${Number(n.toFixed(5))}`;
}

/**
 * Classify one provider × model pair. Pure and total — always returns a tier,
 * never throws, never returns undefined (an unlabelled cell is what made the
 * old page ambiguous).
 */
export function classifyModelEntitlement(provider: string, modelId?: string): ModelEntitlement {
  const id = (modelId ?? '').trim();

  // 1. A provider-declared free id wins over everything else — this is the
  //    provider telling us, which is the strongest evidence available.
  if (id.endsWith(PROVIDER_FREE_SUFFIX)) {
    return {
      tier: 'free',
      basis: `Provider declares this id free ("${PROVIDER_FREE_SUFFIX}" suffix)`,
    };
  }

  // 2. A local runtime cannot bill anyone, keyless by construction.
  if (LOCAL_RUNTIME_IDS.includes(provider as (typeof LOCAL_RUNTIME_IDS)[number])) {
    return { tier: 'free', basis: 'Runs on this machine — no per-call cost' };
  }

  const entry = getCatalogProvider(provider);

  // 3. Unknown provider (a runtime the catalog does not describe) — say so
  //    rather than guess.
  if (!entry) {
    return { tier: 'unknown', basis: 'Provider not described by the catalog — cost unknown' };
  }

  const { inputPer1K, outputPer1K } = entry.pricing;

  // 4. Non-zero list price → metered. NOTE the deliberate asymmetry: zero falls
  //    through to `unknown` below, never to `free`.
  if (inputPer1K > 0 || outputPer1K > 0) {
    return {
      tier: 'metered',
      basis: `List price ${fmtPrice(inputPer1K)}/${fmtPrice(outputPer1K)} per 1K in/out — your key's free tier or credits decide what you actually pay`,
    };
  }

  // 5. Zero list price on a keyed provider: not proof of free (see the Gemini
  //    note in the module header), so report the evidence, not a conclusion.
  if (isCatalogKeyless(provider)) {
    return {
      tier: 'unknown',
      basis: 'Keyless provider with no list price — cost depends on what it forwards to',
    };
  }

  return {
    tier: 'unknown',
    basis: 'Catalog lists no per-token price for this provider — cost depends on your key/plan',
  };
}

/** Compact chip label for a tier (dashboard / CLI). */
export const ENTITLEMENT_CHIP: Record<EntitlementTier, string> = {
  free: '🎁 free',
  metered: '💸 metered',
  unknown: '❓ cost unknown',
};
