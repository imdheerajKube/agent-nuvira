/**
 * Model pricing — the ONE price source of truth for what a call cost.
 *
 * THE DEFECT THIS REPLACES (measured on a real profile, 2026-10-15: a ledger of
 * 9,405 calls reporting `Total Spent $7.21`). There were TWO price tables and
 * neither knew what the account was actually billed:
 *
 *   1. `cost-tracker.ts` held a hardcoded five-entry `DEFAULT_PRICING` (groq,
 *      nim, gemini, openrouter, local) with a `$0.00010/1K` fallback for every
 *      OTHER provider, plus a three-entry `expensiveModels` hack. The ledger
 *      priced from it and the dashboard printed the sum as **"Total Spent"**.
 *   2. `provider-catalog.ts` held the real per-provider list prices (with 21
 *      providers, not 5) and the ROUTER scored cost from THAT.
 *
 * The two disagreed in both directions, and every disagreement was invisible:
 *
 *   - `deepseek` was absent from the ledger table → priced at the generic
 *     `$0.00010/1K` while the catalog declared `$0.00027/$0.00110`. The one
 *     provider the user actually pays for was the one most mis-priced (≈$5.94
 *     recorded where the catalog's own numbers give ≈$17.36).
 *   - `omniroute` was absent too → invented $0.3995 of spend on a localhost
 *     gateway the catalog itself declares `{0, 0}`.
 *   - `openrouter` was 25×/100× lower in the ledger than in the catalog.
 *   - a 7B toy (`allam-2-7b`) and a prompt-guard classifier were billed at the
 *     provider's Llama-3.3-70B-class rate, because price was per PROVIDER.
 *   - and "my Groq is a free tier" had nowhere to live, so free usage was
 *     charged a stranger's list rate (the billing fact belongs to the KEY —
 *     this is the same doctrine `inference/model-entitlement.ts` states: the
 *     module may LABEL, never bill).
 *
 * ─── DOCTRINE (read before changing the order below) ────────────────────────
 *
 * 1. **Two numbers, never conflated.** `billedUsd` is money we have EVIDENCE
 *    was charged. `listUsd` is what the same tokens would cost at the resolved
 *    LIST price — the VALUE of a free call, never a charge. A single number
 *    cannot express both, and calling the second "spend" is the whole bug.
 * 2. **Evidence outranks inference, in this order.** Provider-reported cost for
 *    THIS call > the account's own declared billing tier (a key fact) > a price
 *    we can name a source for (config override, declared model price, catalog).
 *    Nothing here guesses.
 * 3. **No generic fallback. Ever.** An unknown provider has NO price: it is
 *    `unpriced`, which is a first-class answer. The old `$0.00010/1K` default is
 *    exactly how $0.40 of spend appeared on a free local gateway. (Unknown is
 *    not zero either — that is the mirror-image lie, and `gemini`'s declared
 *    `0/0` is why a zero price is deliberately NOT read as "free".)
 * 4. **A zero catalog price is not free, and a keyless gateway is not free.**
 *    A keyed provider with no listed price is `unpriced` (Gemini's paid models
 *    403 without billing). A keyless pass-through gateway (`omniroute`,
 *    `nuvira` sidecar) bills whatever its UPSTREAM charged, which this machine
 *    cannot see — so it is `passthrough`: zero we can attribute, and explicitly
 *    NOT claimed as either spend or saving.
 * 5. **Per-model before per-provider, and say which one you used.**
 *    `pricingBasis` names the evidence ("config override", "declared model
 *    price", "catalog deepseek", "groq provider-level default (Llama-3.3-70B
 *    class) — no per-model price for this id"). "Provider-level default" is
 *    marked as such because that is precisely the number that used to bill a
 *    7B toy at 70B rates.
 * 6. **The router still gets a number.** `estimatedListCostUsd()` is the
 *    scoring primitive (`calculateCost` keeps its signature for that reason); it
 *    answers "what should this cost on the open market", which is the right
 *    question for ranking and the WRONG question for accounting. Accounting uses
 *    `resolveCallCost()`.
 */

import { catalogPricing, isCatalogKeyless, getCatalogProvider } from '../inference/provider-catalog.js';
import { LOCAL_RUNTIME_IDS } from '../inference/model-entitlement.js';

// ─── Billing tiers (the account fact) ───────────────────────────────────────

/**
 * What the user's ACCOUNT (key) is billed by this provider — the fact the
 * ledger had no way to express. Declared per provider in config
 * (`providers.<id>.billingTier`), because it is a property of the key, not of
 * the model.
 *
 *   paid          — calls bill at list price. List-priced calls count as billed
 *                   (still an estimate; only a provider-reported figure is exact).
 *   free          — a free tier / free credits are absorbing the cost. Calls are
 *                   $0 billed BY EVIDENCE, and their list price is reported as
 *                   value (what the free tier saved).
 *   subscription  — a flat-rate plan covers the calls. Same accounting as `free`
 *                   (nothing is charged per call), different reason in the basis.
 *   unknown       — nothing declared. NOT an assumption of paid: list-priced
 *                   calls land in a separate `unverified` bucket that is never
 *                   presented as spend, and the surfaces say how to declare it.
 */
export type BillingTier = 'paid' | 'free' | 'subscription' | 'unknown';

export const BILLING_TIERS: readonly BillingTier[] = ['paid', 'free', 'subscription', 'unknown'];

/** True when the tier means "nothing is charged per call". */
export function tierIsUnbilled(tier: BillingTier): boolean {
  return tier === 'free' || tier === 'subscription';
}

/** Narrow an arbitrary config value to a tier. Anything unrecognised is `unknown`. */
export function asBillingTier(value: unknown): BillingTier {
  return typeof value === 'string' && (BILLING_TIERS as readonly string[]).includes(value)
    ? (value as BillingTier)
    : 'unknown';
}

// ─── How the number was obtained ────────────────────────────────────────────

/**
 * The provenance of a call's cost. Six values, because they need different
 * handling and a boolean would flatten them:
 *
 *   reported     the provider/gateway stated this call's exact charge.
 *   catalog      list-priced from a named source (config override, declared
 *                model price, or the provider catalog).
 *   free         provably $0 per call: a local runtime, a provider-declared
 *                `:free` id, or an account declared free/subscription.
 *   passthrough  a keyless gateway to somewhere else — its upstream bill is not
 *                visible here (see doctrine 4).
 *   unknown      no price evidence at all — unpriced, never zero, never guessed.
 */
export type CostSource = 'reported' | 'catalog' | 'free' | 'passthrough' | 'unknown';

/**
 * Which accounting bucket an entry belongs to. Derived, so every surface
 * (CLI, dashboard, reconciliation) buckets a call the same way.
 *
 *   billed-reported    exact, provider-stated money.
 *   billed-listed      list-priced and the account is declared `paid` — a
 *                      best estimate of money owed, labelled as an estimate.
 *   unverified-listed  list-priced, account tier undeclared: shown, never as spend.
 *   not-billed-value   free/subscription: $0 billed, list price is the value saved.
 *   unpriced           unknown price, or a pass-through gateway: no dollars at all.
 */
export type CostBucket =
  | 'billed-reported'
  | 'billed-listed'
  | 'unverified-listed'
  | 'not-billed-value'
  | 'unpriced';

/** The bucket for one classified call. Pure. */
export function bucketFor(source: CostSource, tier: BillingTier): CostBucket {
  switch (source) {
    case 'reported':
      return 'billed-reported';
    case 'free':
      return 'not-billed-value';
    case 'passthrough':
    case 'unknown':
      return 'unpriced';
    case 'catalog':
      return tier === 'paid' ? 'billed-listed' : 'unverified-listed';
  }
}

// ─── Model-level facts ──────────────────────────────────────────────────────

const PROVIDER_FREE_SUFFIX = ':free';

/** A price we can name a source for. USD per 1K tokens. */
export interface PriceQuote {
  inputPer1K: number;
  outputPer1K: number;
  /** The evidence, one line — printed beside the number, never omitted. */
  basis: string;
}

/**
 * DECLARED per-model list prices, keyed `provider/model` OR a bare model id.
 *
 * These are the models whose real price differs materially from their
 * provider's declared default — the entries that used to live as an ad-hoc
 * `expensiveModels` map inside `cost-tracker.ts` (kept, so no accounting
 * behaviour regresses silently, but now first-class and self-describing: each
 * carries the id it applies to AND a basis string the surfaces print).
 *
 * A key with a `/` is matched against `${provider}/${model}` first, so the same
 * model id can price differently on two providers. Nothing is inferred from a
 * model's NAME here — a price is a fact about an offering, not a word.
 */
export const DECLARED_MODEL_PRICES: Record<string, PriceQuote> = {
  'openai/gpt-oss-120b': {
    inputPer1K: 0.00015,
    outputPer1K: 0.0006,
    basis: 'declared model price (gpt-oss-120b)',
  },
  'openai/gpt-oss-20b': {
    inputPer1K: 0.000075,
    outputPer1K: 0.0003,
    basis: 'declared model price (gpt-oss-20b)',
  },
  'qwen/qwen3.6-27b': {
    inputPer1K: 0.0006,
    outputPer1K: 0.003,
    basis: 'declared model price (qwen3.6-27b)',
  },
};

/** True when a provider×model is provably $0 per call at the MODEL level. */
export function isModelLevelFree(provider: string, model: string): boolean {
  const id = (model ?? '').trim();
  if (id.endsWith(PROVIDER_FREE_SUFFIX)) return true;
  return (LOCAL_RUNTIME_IDS as readonly string[]).includes(provider);
}

/**
 * A keyless provider that is NOT a local runtime: a gateway whose cost depends
 * on whatever it forwards to. Its own price table says 0, and that zero means
 * "not priced here", not "free here" (doctrine 4).
 */
export function isPassthroughGateway(provider: string): boolean {
  if ((LOCAL_RUNTIME_IDS as readonly string[]).includes(provider)) return false;
  return isCatalogKeyless(provider);
}

/**
 * Resolve the LIST price for a call, or `undefined` when this machine has no
 * price for the pair. Precedence, highest first:
 *
 *   1. the caller's config override (`pricing.<provider>` — the user's own number),
 *   2. a declared per-model price (`DECLARED_MODEL_PRICES`),
 *   3. the caller's per-model catalogue row (the live feed, when a host wires it),
 *   4. the provider catalog's default, MARKED as provider-level.
 *
 * Step 4 is deliberately last and deliberately labelled: applying a provider
 * average to every model is exactly how a 7B toy was billed at 70B rates.
 */
export function resolveListPrice(
  provider: string,
  model: string,
  opts: {
    configPricing?: { inputPer1K?: number; outputPer1K?: number };
    /** A per-model price from a live catalogue (e.g. OpenRouter's own rows). */
    catalogRow?: { inputPer1K?: number; outputPer1K?: number; basis?: string };
  } = {},
): PriceQuote | undefined {
  const usable = (q: { inputPer1K?: number; outputPer1K?: number } | undefined) =>
    !!q &&
    typeof q.inputPer1K === 'number' &&
    typeof q.outputPer1K === 'number' &&
    Number.isFinite(q.inputPer1K) &&
    Number.isFinite(q.outputPer1K) &&
    q.inputPer1K >= 0 &&
    q.outputPer1K >= 0;

  // 1. The user's own declared price for this provider wins over every builtin.
  if (usable(opts.configPricing)) {
    return {
      inputPer1K: opts.configPricing!.inputPer1K!,
      outputPer1K: opts.configPricing!.outputPer1K!,
      basis: `your config override (pricing.${provider})`,
    };
  }

  // 2. A declared per-model price, matched `provider/model` then bare id.
  const declared = DECLARED_MODEL_PRICES[`${provider}/${model}`] ?? DECLARED_MODEL_PRICES[model];
  if (declared) return { ...declared };

  // 3. A live catalogue row for this exact model, when the host supplied one.
  if (usable(opts.catalogRow)) {
    return {
      inputPer1K: opts.catalogRow!.inputPer1K!,
      outputPer1K: opts.catalogRow!.outputPer1K!,
      basis: opts.catalogRow!.basis ?? `catalogue price for ${model}`,
    };
  }

  // 4. The provider catalog's default — only when it is a real (>0) price.
  const entry = getCatalogProvider(provider);
  const catalog = catalogPricing(provider);
  if (catalog && (catalog.inputPer1K > 0 || catalog.outputPer1K > 0)) {
    return {
      inputPer1K: catalog.inputPer1K,
      outputPer1K: catalog.outputPer1K,
      basis: `${provider} provider-level default (${entry?.defaultModel ?? 'unknown default'} class) — no per-model price for this id`,
    };
  }

  // A keyed provider with no positive price has NO price we can name (doctrine 4).
  return undefined;
}

// ─── Cost resolution ────────────────────────────────────────────────────────

/** The classified cost of ONE call. */
export interface ResolvedCallCost {
  /** Money we have evidence was charged, USD. 0 for free/unpriced/passthrough. */
  billedUsd: number;
  /** List-price value of the same tokens, when a price exists. Never "spend". */
  listUsd?: number;
  costSource: CostSource;
  bucket: CostBucket;
  billingTier: BillingTier;
  /** One line naming the evidence behind both numbers. */
  basis: string;
  /** The resolved prices, when there is a quote (for display/aggregation). */
  quote?: PriceQuote;
}

function round6(usd: number): number {
  return Math.round(usd * 100000) / 100000;
}

function costOf(quote: PriceQuote, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * quote.inputPer1K + (outputTokens / 1000) * quote.outputPer1K;
}

/**
 * Classify one call's cost from the best available evidence.
 *
 * Total, never throws. `billedUsd` is 0 whenever we do not have evidence of a
 * charge — which is the honest default, and the reason the headline can no
 * longer be inflated by a provider average (doctrine 1, 3).
 */
export function resolveCallCost(input: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The provider's exact figure for this call, when it gave one. */
  reportedCostUsd?: number;
  /** The account's declared billing tier for this provider. */
  billingTier?: BillingTier;
  configPricing?: { inputPer1K?: number; outputPer1K?: number };
  catalogRow?: { inputPer1K?: number; outputPer1K?: number; basis?: string };
}): ResolvedCallCost {
  const tier = input.billingTier ?? 'unknown';
  const quote = resolveListPrice(input.provider, input.model, {
    configPricing: input.configPricing,
    catalogRow: input.catalogRow,
  });
  const listUsd = quote ? round6(costOf(quote, input.inputTokens, input.outputTokens)) : undefined;

  // 1. The provider's own accounting is exact, and it is exact about ZERO too.
  if (typeof input.reportedCostUsd === 'number' && Number.isFinite(input.reportedCostUsd)) {
    return {
      billedUsd: round6(Math.max(0, input.reportedCostUsd)),
      ...(listUsd !== undefined ? { listUsd } : {}),
      costSource: 'reported',
      bucket: 'billed-reported',
      billingTier: tier,
      basis: 'provider-reported cost for this call (exact)',
      ...(quote ? { quote } : {}),
    };
  }

  // 2. Provably nothing per call — a local runtime, a provider-declared free id,
  //    or an account the user has declared free/subscription. The list price
  //    becomes VALUE (what the tier saved), never spend.
  if (isModelLevelFree(input.provider, input.model)) {
    return {
      billedUsd: 0,
      ...(listUsd !== undefined ? { listUsd } : {}),
      costSource: 'free',
      bucket: 'not-billed-value',
      billingTier: tier,
      basis:
        (LOCAL_RUNTIME_IDS as readonly string[]).includes(input.provider)
          ? 'runs on this machine — no per-call charge'
          : `provider declares this id free ("${PROVIDER_FREE_SUFFIX}")`,
      ...(quote ? { quote } : {}),
    };
  }
  if (tierIsUnbilled(tier)) {
    return {
      billedUsd: 0,
      ...(listUsd !== undefined ? { listUsd } : {}),
      costSource: 'free',
      bucket: 'not-billed-value',
      billingTier: tier,
      basis:
        tier === 'subscription'
          ? 'your account is on a flat-rate plan — nothing is charged per call'
          : 'your account is declared a free tier — nothing is charged per call',
      ...(quote ? { quote } : {}),
    };
  }

  // 3. A pass-through gateway: the upstream bill is not visible from here.
  if (isPassthroughGateway(input.provider)) {
    return {
      billedUsd: 0,
      costSource: 'passthrough',
      bucket: 'unpriced',
      billingTier: tier,
      basis: `${input.provider} is a keyless pass-through gateway — its upstream charge is not visible here`,
    };
  }

  // 4. No price we can name: UNPRICED. Not zero, not an invented rate.
  if (!quote || listUsd === undefined) {
    return {
      billedUsd: 0,
      costSource: 'unknown',
      bucket: 'unpriced',
      billingTier: tier,
      basis: `no price evidence for ${input.provider}/${input.model} — set pricing.${input.provider}.inputPer1K/outputPer1K or declare providers.${input.provider}.billingTier`,
    };
  }

  // 5. A real list price. Whether it counts as BILLED depends on the one fact
  //    only the user has: what their key is billed.
  return {
    billedUsd: tier === 'paid' ? listUsd : 0,
    listUsd,
    costSource: 'catalog',
    bucket: tier === 'paid' ? 'billed-listed' : 'unverified-listed',
    billingTier: tier,
    basis:
      tier === 'paid'
        ? `${quote.basis} — account declared paid, so this is an estimated bill`
        : `${quote.basis} — account tier undeclared, so this is NOT counted as spend (set providers.${input.provider}.billingTier)`,
    quote,
  };
}

/**
 * The LIST-priced estimate, for callers that need a number to RANK with
 * (`auto-router`'s cost score, the fallback ladder, hybrid cost estimates).
 *
 * Deliberately returns the market price rather than the billed figure: ranking
 * wants "what would this cost on the open market", while accounting wants "what
 * did it cost ME". Conflating them is how the dashboard came to print an
 * estimate under the word "spent".
 */
export function estimatedListCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  opts: {
    configPricing?: { inputPer1K?: number; outputPer1K?: number };
    catalogRow?: { inputPer1K?: number; outputPer1K?: number; basis?: string };
  } = {},
): number {
  if (isModelLevelFree(provider, model)) return 0;
  const quote = resolveListPrice(provider, model, opts);
  if (!quote) return 0;
  return round6(costOf(quote, inputTokens, outputTokens));
}

/** Convenience for display surfaces: the price quote alone, or undefined. */
export function priceQuoteFor(
  provider: string,
  model: string,
  opts: {
    configPricing?: { inputPer1K?: number; outputPer1K?: number };
    catalogRow?: { inputPer1K?: number; outputPer1K?: number; basis?: string };
  } = {},
): PriceQuote | undefined {
  return resolveListPrice(provider, model, opts);
}
