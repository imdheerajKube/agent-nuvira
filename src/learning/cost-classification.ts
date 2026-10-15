/**
 * Cost classification — the ONE place that decides which bucket a ledger row
 * belongs to, and what "billed" means for it.
 *
 * WHY IT IS ITS OWN MODULE. Three surfaces judge the same rows — `cost-tracker`
 * (the CLI summary), `web-dashboard/server` (the Cost page + `/api/cost`) and the
 * reconciliation check — and the defect being fixed is precisely that two places
 * priced the same call differently (a hardcoded ledger table vs the provider
 * catalog, disagreeing 25×–100×). So the rule lives here, once, and every surface
 * asks this module instead of deriving its own answer.
 *
 * THE ONE THING TO UNDERSTAND. A ledger row carries two different dollar amounts,
 * and the bug was conflating them:
 *
 *   billedUsd     money we have EVIDENCE was charged.
 *                 - exact when the provider reported the call's cost,
 *                 - an estimate when the account is declared `paid` and a list
 *                   price is known,
 *                 - otherwise 0 (free tier, unknown price, pass-through gateway).
 *   listValueUsd  what the same tokens would cost at the resolved list price —
 *                 the VALUE a free/subscription tier absorbed, and the figure an
 *                 undeclared account's rows sit at until the tier is declared.
 *
 * Neither is ever presented as the other, and "unpriced" is a first-class answer
 * rather than a fabricated rate (see `model-pricing.ts` for why: a generic
 * `$0.00010/1K` fallback invented $0.40 of spend on a localhost gateway and
 * under-reported the one provider the user actually pays for).
 *
 * ─── LEGACY ROWS (read before changing classifyEntry) ───────────────────────
 *
 * Rows written before this module existed have no `costSource`: their `costUsd`
 * came from the old hardcoded table. They are NOT trusted for classification and
 * NOT silently relabelled. They are re-derived HERE, at read time, from the fields
 * they do carry (provider, model, tokens, `costReported`) using TODAY's rules —
 * and counted in `recomputedCalls` so a reader can tell re-derived rows from
 * recorded ones. The file is never rewritten by a read: mutating a profile's
 * history to make a dashboard look right is the failure this whole change exists
 * to remove. `scripts/prune-cost-ledger-rows.mjs` is the explicit, dry-run-default
 * way to rewrite them.
 */

import { ConfigManager } from '../config/manager.js';
import {
  asBillingTier,
  resolveCallCost,
  type BillingTier,
  type CostBucket,
  type CostSource,
} from './model-pricing.js';

// ─── The pricing context (one config read per process) ──────────────────────

/**
 * Where the classification gets its account facts and price overrides. A seam,
 * because `cost-tracker` records calls from deep inside adapters that hold no
 * config, while tests need a deterministic account tier with no config file.
 */
export interface PricingContext {
  /** The account's declared billing tier for a provider (default `unknown`). */
  billingTierFor(provider: string): BillingTier;
  /** `pricing.<provider>` override from config, when the user set one. */
  configPricingFor(provider: string): { inputPer1K?: number; outputPer1K?: number } | undefined;
  /**
   * A per-model price from a live catalogue, when a host has one wired in.
   *
   * Left unset by default on purpose: the live catalogue feed
   * (`learning/catalog-feed.ts`, opt-in and OFF by default) imports the router,
   * which imports `cost-tracker`, so importing it here would close a module
   * cycle for a source of data that is usually absent anyway. A host that has
   * both (the CLI's model surfaces do) can hand it over; a test can inject one to
   * prove a per-model price outranks the provider default.
   */
  catalogRowFor?(
    provider: string,
    model: string,
  ): { inputPer1K?: number; outputPer1K?: number; basis?: string } | undefined;
}

/** Everything is `unknown`/unset — the honest floor when config cannot be read. */
export const UNKNOWN_PRICING_CONTEXT: PricingContext = {
  billingTierFor: () => 'unknown',
  configPricingFor: () => undefined,
};

/** Build a context from a loaded config (the production path). */
export function configPricingContext(cm: ConfigManager): PricingContext {
  return {
    billingTierFor(provider: string): BillingTier {
      try {
        const p = (cm.getAll().providers || {})[provider] as { billingTier?: unknown } | undefined;
        return asBillingTier(p?.billingTier);
      } catch {
        return 'unknown';
      }
    },
    configPricingFor(provider: string) {
      try {
        const p = (cm.getAll().pricing || {})[provider] as
          | { inputPer1K?: number; outputPer1K?: number }
          | undefined;
        if (!p) return undefined;
        const input = typeof p.inputPer1K === 'number' ? p.inputPer1K : undefined;
        const output = typeof p.outputPer1K === 'number' ? p.outputPer1K : undefined;
        if (input === undefined && output === undefined) return undefined;
        // A half-declared override is not a price: filling the missing side with
        // the other one would invent a rate the user never wrote.
        if (input === undefined || output === undefined) return undefined;
        return { inputPer1K: input, outputPer1K: output };
      } catch {
        return undefined;
      }
    },
  };
}

/** A process-wide override for hosts and tests. `null` restores the config path. */
let overrideContext: PricingContext | null = null;
let cachedConfigContext: PricingContext | null = null;

export function setPricingContext(ctx: PricingContext | null): void {
  overrideContext = ctx;
}

/** Drop the cached config-backed context (tests that switch profiles mid-file). */
export function resetPricingContextCache(): void {
  cachedConfigContext = null;
  overrideContext = null;
}

/**
 * The context to classify with. Config is read LAZILY and cached, and a failure
 * to read it degrades to `unknown` rather than to an assumption — an accounting
 * layer must never invent a tier.
 */
export function getPricingContext(): PricingContext {
  if (overrideContext) return overrideContext;
  if (!cachedConfigContext) {
    try {
      cachedConfigContext = configPricingContext(new ConfigManager());
    } catch {
      cachedConfigContext = UNKNOWN_PRICING_CONTEXT;
    }
  }
  return cachedConfigContext;
}

// ─── Entry shape (structural, so callers need no import cycle) ──────────────

/**
 * The fields classification reads. Deliberately minimal and structural: the
 * ledger's own `CostEntry` satisfies it, and so does a plain object in a test —
 * so this module never has to import the ledger it classifies.
 */
export interface ClassifiableEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  costUsd: number;
  measured?: boolean;
  /** The provider stated this call's exact charge. */
  costReported?: boolean;
  /** Written by this module's rules (absent on legacy rows). */
  costSource?: CostSource;
  /** List-price VALUE of the call, when a price exists (absent on legacy rows). */
  listPriceUsd?: number;
  /** The tier in force when the row was recorded. */
  billingTier?: BillingTier;
  /** One line naming the evidence. */
  pricingBasis?: string;
  /** `live` or `test` (see `telemetryOrigin`). Absent on legacy rows. */
  origin?: 'live' | 'test';
  timestamp?: number;
}

/** One classified row. */
export interface ClassifiedEntry {
  billedUsd: number;
  listValueUsd?: number;
  costSource: CostSource;
  bucket: CostBucket;
  billingTier: BillingTier;
  basis: string;
  /** True when a legacy row was re-derived here instead of read as recorded. */
  recomputed: boolean;
}

const round6 = (usd: number): number => Math.round(usd * 100000) / 100000;

/**
 * Classify ONE ledger row.
 *
 * A row that already carries `costSource` is taken at its word — it was written
 * by these rules, and re-deriving it with a config that may have changed since
 * would rewrite history. A legacy row (no `costSource`) is re-derived from the
 * fields it has; `costReported` is the one thing a legacy row can be exact about.
 */
export function classifyEntry(
  entry: ClassifiableEntry,
  ctx: PricingContext = getPricingContext(),
): ClassifiedEntry {
  if (entry.costReported === true) {
    // The provider's own figure, exact — for a legacy row too (the flag was
    // written by the old code and means the same thing).
    return {
      billedUsd: round6(entry.costUsd ?? 0),
      ...(typeof entry.listPriceUsd === 'number' ? { listValueUsd: entry.listPriceUsd } : {}),
      costSource: 'reported',
      bucket: 'billed-reported',
      billingTier: entry.billingTier ?? ctx.billingTierFor(entry.provider),
      basis: entry.pricingBasis ?? 'provider-reported cost for this call (exact)',
      recomputed: entry.costSource === undefined,
    };
  }

  if (entry.costSource !== undefined) {
    // Recorded by the current rules: its numbers stand, its bucket is derived.
    const tier = entry.billingTier ?? ctx.billingTierFor(entry.provider);
    return {
      billedUsd: round6(entry.costUsd ?? 0),
      ...(typeof entry.listPriceUsd === 'number' ? { listValueUsd: entry.listPriceUsd } : {}),
      costSource: entry.costSource,
      bucket: bucketOf(entry.costSource, tier),
      billingTier: tier,
      basis: entry.pricingBasis ?? 'recorded by the pricing rules',
      recomputed: false,
    };
  }

  // Legacy row: re-derive with today's rules. `reportedCostUsd` is deliberately
  // NOT passed — the stored `costUsd` is the OLD table's number, and feeding it
  // in as though the provider had said it would launder an estimate into an exact
  // figure, which is the single worst mistake this module could make.
  const resolved = resolveCallCost({
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    billingTier: ctx.billingTierFor(entry.provider),
    configPricing: ctx.configPricingFor(entry.provider),
    catalogRow: ctx.catalogRowFor?.(entry.provider, entry.model),
  });
  return {
    billedUsd: resolved.billedUsd,
    ...(resolved.listUsd !== undefined ? { listValueUsd: resolved.listUsd } : {}),
    costSource: resolved.costSource,
    bucket: resolved.bucket,
    billingTier: resolved.billingTier,
    basis: resolved.basis,
    recomputed: true,
  };
}

/** The bucket for a recorded row — mirrors `model-pricing.bucketFor` for stored data. */
function bucketOf(source: CostSource, tier: BillingTier): CostBucket {
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

// ─── Totals ─────────────────────────────────────────────────────────────────

/** Per-provider / per-model roll-up of one bucket set. */
export interface CostBucketTotals {
  billedUsd: number;
  unverifiedListedUsd: number;
  notBilledValueUsd: number;
  unpricedCalls: number;
  /** Calls whose list price is known but whose billing tier is undeclared. */
  unverifiedCalls: number;
  /** Calls a free/subscription tier absorbed. */
  valueCalls: number;
  requests: number;
}

export interface CostTotals {
  /** Exact, provider-stated. */
  billedReportedUsd: number;
  billedReportedCalls: number;
  /** List-priced with the account declared paid — an estimate of money owed. */
  billedListedUsd: number;
  billedListedCalls: number;
  /** The two above together: the evidence-backed bill. */
  billedUsd: number;
  /** List-priced with the tier undeclared: shown, never presented as spend. */
  unverifiedListedUsd: number;
  unverifiedListedCalls: number;
  /** Value a free/subscription tier absorbed — never spend. */
  notBilledValueUsd: number;
  notBilledValueCalls: number;
  /** Calls with no dollars at all (unknown price, or a pass-through gateway). */
  unpricedCalls: number;
  unpricedTokens: number;
  /** Rows re-derived at read time because they predate `costSource`. */
  recomputedCalls: number;
  /** Rows tagged test-origin (a display surface may exclude these). */
  testOriginCalls: number;
  /** Sum of the STORED `costUsd` — the ledger total as recorded. */
  recordedTotalUsd: number;
  tokens: number;
  requests: number;
  byProvider: Record<string, CostBucketTotals>;
  byModel: Record<string, CostBucketTotals>;
}

function emptyProviderTotals(): CostBucketTotals {
  return {
    billedUsd: 0,
    unverifiedListedUsd: 0,
    notBilledValueUsd: 0,
    unpricedCalls: 0,
    unverifiedCalls: 0,
    valueCalls: 0,
    requests: 0,
  };
}

/**
 * Classify a list of rows and sum them.
 *
 * `excludeTestOrigin` defaults to FALSE, deliberately: this function is also how
 * a TEST measures its own writes (`costSince` reads back rows that are, by
 * definition, test-origin in a test process), so dropping them here would make
 * the ledger read as empty the moment a test runner was involved. The exclusion
 * belongs to the DISPLAY surfaces — the dashboard's cost endpoint and the CLI
 * summary opt in — because that is the claim being made: "this is YOUR usage".
 * `testOriginCalls` is always reported, so a surface can say how many it hid.
 */
export function classifyEntries(
  entries: readonly ClassifiableEntry[],
  opts: { ctx?: PricingContext; excludeTestOrigin?: boolean } = {},
): CostTotals {
  const ctx = opts.ctx ?? getPricingContext();
  const totals: CostTotals = {
    billedReportedUsd: 0,
    billedReportedCalls: 0,
    billedListedUsd: 0,
    billedListedCalls: 0,
    billedUsd: 0,
    unverifiedListedUsd: 0,
    unverifiedListedCalls: 0,
    notBilledValueUsd: 0,
    notBilledValueCalls: 0,
    unpricedCalls: 0,
    unpricedTokens: 0,
    recomputedCalls: 0,
    testOriginCalls: 0,
    recordedTotalUsd: 0,
    tokens: 0,
    requests: 0,
    byProvider: {},
    byModel: {},
  };

  for (const entry of entries) {
    if (entry.origin === 'test') {
      totals.testOriginCalls += 1;
      if (opts.excludeTestOrigin) continue;
    }
    const c = classifyEntry(entry, ctx);
    const tokens = entry.totalTokens ?? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);

    totals.requests += 1;
    totals.tokens += tokens;
    totals.recordedTotalUsd += entry.costUsd ?? 0;
    if (c.recomputed) totals.recomputedCalls += 1;

    if (c.bucket === 'billed-reported') {
      totals.billedReportedUsd += c.billedUsd;
      totals.billedReportedCalls += 1;
    } else if (c.bucket === 'billed-listed') {
      totals.billedListedUsd += c.billedUsd;
      totals.billedListedCalls += 1;
    } else if (c.bucket === 'unverified-listed') {
      totals.unverifiedListedUsd += c.listValueUsd ?? 0;
      totals.unverifiedListedCalls += 1;
    } else if (c.bucket === 'not-billed-value') {
      totals.notBilledValueUsd += c.listValueUsd ?? 0;
      totals.notBilledValueCalls += 1;
    } else {
      totals.unpricedCalls += 1;
      totals.unpricedTokens += tokens;
    }

    const provider = entry.provider || 'unknown';
    const p = (totals.byProvider[provider] ??= emptyProviderTotals());
    const m = (totals.byModel[entry.model || 'unknown'] ??= emptyProviderTotals());
    p.requests += 1;
    m.requests += 1;
    if (c.bucket === 'billed-reported' || c.bucket === 'billed-listed') {
      p.billedUsd += c.billedUsd;
      m.billedUsd += c.billedUsd;
    } else if (c.bucket === 'unverified-listed') {
      p.unverifiedListedUsd += c.listValueUsd ?? 0;
      p.unverifiedCalls += 1;
      m.unverifiedListedUsd += c.listValueUsd ?? 0;
      m.unverifiedCalls += 1;
    } else if (c.bucket === 'not-billed-value') {
      p.notBilledValueUsd += c.listValueUsd ?? 0;
      p.valueCalls += 1;
      m.notBilledValueUsd += c.listValueUsd ?? 0;
      m.valueCalls += 1;
    } else {
      p.unpricedCalls += 1;
      m.unpricedCalls += 1;
    }
  }

  totals.billedUsd = round6(totals.billedReportedUsd + totals.billedListedUsd);
  totals.billedReportedUsd = round6(totals.billedReportedUsd);
  totals.billedListedUsd = round6(totals.billedListedUsd);
  totals.unverifiedListedUsd = round6(totals.unverifiedListedUsd);
  totals.notBilledValueUsd = round6(totals.notBilledValueUsd);
  totals.recordedTotalUsd = round6(totals.recordedTotalUsd);
  return totals;
}
