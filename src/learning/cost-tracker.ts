/**
 * CostTracker — the append-only ledger of what each model call cost, stored at
 * ~/.nuvira/memory/cost-tracker.json.
 *
 * TWO NUMBERS, NEVER ONE. Every row carries `costUsd` (money we have EVIDENCE was
 * charged) and, when a price exists, `listPriceUsd` (what the same tokens would
 * cost at list price — the VALUE a free tier absorbed). A single figure cannot
 * express both, and conflating them is the defect this file was rewritten to
 * remove: the ledger used to price every call from its OWN hardcoded table —
 * five providers plus a `$0.00010/1K` generic fallback — while the router priced
 * from `provider-catalog.ts`. On a real profile that printed
 * `Total Spent $7.21` where the same ledger recorded $5.94 for the ONLY provider
 * the user pays (the catalog's own DeepSeek numbers give ≈$17.36), invented
 * $0.40 of spend on a localhost gateway the catalog declares free, and billed a
 * free Groq tier at a 70B-class list rate.
 *
 * There is now ONE price source of truth (`learning/model-pricing.ts`, reading
 * `provider-catalog.ts`) and NO generic fallback: an unknown provider is
 * `unpriced`, which is a first-class answer rather than an invented rate.
 *
 * WHAT DECIDES THE DOLLARS (in order):
 *   1. the provider's own reported cost for the call — exact, including $0;
 *   2. a provably-free pair: a local runtime, a provider-declared `:free` id, or an
 *      account the user declared `free`/`subscription` (`providers.<id>.billingTier`);
 *   3. a keyless pass-through gateway → `passthrough` (its upstream bill is not
 *      visible here) and an unknown price → `unpriced` — neither is $0 "spend";
 *   4. a list price we can NAME a source for → billed only when the account is
 *      declared `paid`, otherwise a labelled `unverified` figure.
 *
 * Rows written before this existed are re-derived at READ time (never rewritten)
 * and counted in `recomputedCalls`; see `learning/cost-classification.ts`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths';
import { formatCount } from '../utils/format.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getQuotaLedger } from './quota-ledger.js';
import { getModelRegistry } from './model-registry.js';
import { telemetryOrigin } from './model-registry.js';
import {
  estimatedListCostUsd,
  isModelLevelFree,
  resolveCallCost,
  type BillingTier,
  type CostSource,
} from './model-pricing.js';
import {
  classifyEntries,
  getPricingContext,
  setPricingContext,
  resetPricingContextCache,
  type CostTotals,
  type PricingContext,
} from './cost-classification.js';

export { setPricingContext, resetPricingContextCache, type PricingContext };
export { BILLING_TIERS, asBillingTier, type BillingTier, type CostSource, type CostBucket } from './model-pricing.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CostEntry {
  /** Provider name (e.g., 'groq', 'gemini', 'openrouter', 'nim', 'local') */
  provider: string;
  /** Model name used */
  model: string;
  /** Timestamp of the request */
  timestamp: number;
  /** Input tokens used */
  inputTokens: number;
  /**
   * The part of `inputTokens` the provider served from its PROMPT CACHE.
   * Optional and absent when the endpoint reports no cache figure at all — so
   * "no cache data" never reads as "nothing was cached". A subset of
   * `inputTokens`, never additional tokens.
   */
  cachedInputTokens?: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Estimated cost in USD (micro-cents precision) */
  costUsd: number;
  /** The task/goal that triggered this request */
  task?: string;
  /**
   * M2.2: true when inputTokens/outputTokens are MEASURED from the provider's
   * reported usage (wire-token metering), false/undefined when length-based
   * estimates were used. The dashboard splits measured vs estimated spend.
   */
  measured?: boolean;
  /**
   * True when `costUsd` was reported BY THE PROVIDER for this call rather than
   * computed from the local price table. A provider-reported cost is the most
   * accurate value available (it reflects credits, free tier, discounts), so it
   * wins over any estimate — see calculateCost's `reportedCostUsd` parameter.
   */
  costReported?: boolean;
  /**
   * How `costUsd` was obtained (see `model-pricing.ts`). Absent on rows written
   * before this existed — those are re-derived at read time, never rewritten.
   */
  costSource?: CostSource;
  /**
   * What the same tokens would cost at the resolved LIST price — the value a
   * free tier absorbed, and the figure an undeclared account sits at. Never spend.
   */
  listPriceUsd?: number;
  /** The account billing tier in force when the row was recorded. */
  billingTier?: BillingTier;
  /** One line naming the evidence behind the two numbers above. */
  pricingBasis?: string;
  /**
   * `live` or `test` (`model-registry.telemetryOrigin`). A row written by a test
   * run is not the user's usage — display surfaces exclude these, exactly as the
   * model registry excludes test-origin telemetry from its views.
   */
  origin?: 'live' | 'test';
}

export interface CostSummary {
  /**
   * The ledger total AS RECORDED — the sum of the stored `costUsd`. Kept in this
   * spelling for compatibility, and deliberately NOT the headline: it includes
   * rows priced by the retired hardcoded table. `billedUsd` below is the
   * evidence-backed figure; a reader can reconcile the two rather than have
   * history silently rewritten under them.
   */
  totalCost: number;
  /** Evidence-backed bill: provider-reported + list-priced with a declared paid account. */
  billedUsd: number;
  /** The exact, provider-stated part of `billedUsd`. */
  billedReportedUsd: number;
  /** The list-priced part of `billedUsd` — an ESTIMATE of money owed. */
  billedListedUsd: number;
  /** List-priced with the tier undeclared: shown, never presented as spend. */
  unverifiedListedUsd: number;
  /** Value a free/subscription tier absorbed — never spend. */
  notBilledValueUsd: number;
  /** Calls with no dollars at all (unknown price, or a pass-through gateway). */
  unpricedCalls: number;
  unpricedTokens: number;
  /** Rows re-derived at read time because they predate `costSource`. */
  recomputedCalls: number;
  /** Rows tagged test-origin (excluded from the totals above; counted here). */
  testOriginCalls: number;
  /** Calls whose figure is exact (provider-reported). */
  billedReportedCalls: number;
  /** Calls list-priced with the account declared paid. */
  billedListedCalls: number;
  /** Calls list-priced with the tier undeclared. */
  unverifiedListedCalls: number;
  /** Calls a free/subscription tier absorbed. */
  notBilledValueCalls: number;
  /**
   * The full classified roll-up (per provider and per model) — the ONE object
   * every surface should read its buckets from, rather than re-deriving them.
   */
  totals: CostTotals;
  /** Total cost by provider */
  byProvider: Record<string, number>;
  /** Total cost by model */
  byModel: Record<string, number>;
  /** Total tokens consumed */
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache (subset of input). */
  cachedInputTokens: number;
  /** Total input tokens across the ledger — the denominator of `cacheHitRate`. */
  inputTokens: number;
  /**
   * `cachedInputTokens / inputTokens`, 0 when the ledger has no input at all.
   * The figure a Cline run reports as "99.3% cache read": without it, a long
   * audit looks like fresh compute it never paid for.
   */
  cacheHitRate: number;
  /** Total requests made */
  totalRequests: number;
  /** Number of entries in the current session */
  sessionRequests: number;
  /** Session cost in USD */
  sessionCost: number;
  /** Session start timestamp */
  sessionStart: number;
}

interface CostData {
  entries: CostEntry[];
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

/**
 * Cost-ledger location — resolved LAZILY through the standard
 * `NUVIRA_MEMORY_DIR` override, like every other persisted store. Captured at
 * module load it ignored the override, so spend recorded by a hermetic run
 * (test, sandbox, isolated profile) was written into the real profile.
 */
function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

function costPath(): string {
  return join(memoryDir(), 'cost-tracker.json');
}

/**
 * The ledger file's location, exported so maintenance (`cost-ledger-maintenance`,
 * the CLI's `stats cost reprice`, `scripts/prune-cost-ledger-rows.mjs`) acts on
 * THIS file and the `NUVIRA_MEMORY_DIR` override keeps applying to it — a repair
 * pass that resolved its own path could rewrite the wrong profile.
 */
export function costLedgerPath(): string {
  return costPath();
}

/**
 * Default pricing per 1K tokens (input/output) in USD.
 * Users can override these via config file.
 * Source: provider pricing pages (approximate, may change).
 */
// There is deliberately NO price table in this file any more. Prices come from
// ONE place — `learning/model-pricing.ts`, which reads the provider catalog — so
// the ledger and the router can no longer disagree about what a call costs. The
// deleted table here was the five-entry `DEFAULT_PRICING` plus a
// `$0.00010/1K` generic fallback; the fallback is what invented $0.40 of spend
// on a free local gateway, and its absence is what made the ledger price
// DeepSeek at a rate no provider ever quoted.

/** Maximum number of cost entries to keep */
const MAX_ENTRIES = 10000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readCosts(): CostData {
  try {
    ensureDir();
    const path = costPath();
    if (!existsSync(path)) {
      return { entries: [], version: CURRENT_VERSION };
    }
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as CostData;
  } catch {
    return { entries: [], version: CURRENT_VERSION };
  }
}

function writeCosts(data: CostData): void {
  ensureDir();
  writeFileSync(costPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Estimate the number of tokens from text length.
 * Rough heuristic: ~4 characters per token for code, ~5 for prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4.5);
}

/**
 * True when the provider/model pair provably costs nothing per call — a
 * provider-declared free id (`:free` suffix) or a keyless local runtime.
 *
 * Delegates to the ONE authority for this question (classifyModelEntitlement),
 * so the dashboard badge and the cost ledger can never disagree about what is
 * free. A zero price in the catalog is deliberately NOT free — see the module
 * header on model-entitlement.ts (Gemini paid models 403 without billing).
 */
export function isFreeModel(provider: string, model: string): boolean {
  try {
    return isModelLevelFree(provider, model);
  } catch {
    return false;
  }
}

/**
 * Calculate the cost for a given provider, model, and token counts.
 *
 * @param reportedCostUsd When the PROVIDER told us the exact cost of this call
 *   (e.g. OpenRouter's `usage.cost`), that figure is authoritative and is
 *   returned verbatim (rounded to the ledger's micro-cent precision). This is
 *   what lets a free/subscription call report a TRUE $0 instead of a generic
 *   rate, and a discounted call report what was actually charged.
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  reportedCostUsd?: number,
  opts?: {
    configPricing?: { inputPer1K?: number; outputPer1K?: number };
    catalogRow?: { inputPer1K?: number; outputPer1K?: number; basis?: string };
  },
): number {
  // Provider-reported cost wins over everything — it is the provider's own
  // accounting, not our estimate.
  if (typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd)) {
    return Math.round(reportedCostUsd * 100000) / 100000;
  }

  // A free model bills $0 regardless of token count — a provider-declared
  // free id or a local runtime. Without this, a `:free` OpenRouter id was
  // charged the generic OpenRouter rate, inventing spend the user never paid.
  if (isFreeModel(provider, model)) {
    return 0;
  }

  // ONE price source (config override → declared model price → provider catalog),
  // and no invented default: an unknown price is 0 here because this function
  // answers "what should this cost on the open market" for RANKING purposes.
  // Accounting uses `resolveCallCost` (see recordCall below), which never lets an
  // unknown price become a dollar figure at all.
  return estimatedListCostUsd(provider, model, inputTokens, outputTokens, {
    configPricing: opts?.configPricing ?? getPricingContext().configPricingFor(provider),
    catalogRow: opts?.catalogRow,
  });
}

// ─── CostTracker ────────────────────────────────────────────────────────────

/**
 * Tracks API usage costs per provider.
 */
export class CostTracker {
  private sessionStart: number;
  private sessionEntries: CostEntry[] = [];

  constructor() {
    this.sessionStart = Date.now();
  }

  /**
   * Record a single API call's cost.
   *
   * @param provider  Provider name
   * @param model     Model name
   * @param inputTokens  Input tokens used (or estimated)
   * @param outputTokens Output tokens generated (or estimated)
   * @param task      Optional task description
   */
  recordCall(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    task?: string,
    measured?: boolean,
    reportedCostUsd?: number,
    cachedInputTokens?: number,
  ): CostEntry {
    const costReported =
      typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd);

    // Classify with the ONE resolver: billed evidence in `costUsd`, the list-price
    // VALUE (what a free tier absorbed) in `listPriceUsd`, and the evidence named
    // in `pricingBasis`. Never `calculateCost` here — that answers the market
    // price used for RANKING, and recording it as spend is the original bug.
    const ctx = getPricingContext();
    const resolved = resolveCallCost({
      provider,
      model,
      inputTokens,
      outputTokens,
      reportedCostUsd,
      billingTier: ctx.billingTierFor(provider),
      configPricing: ctx.configPricingFor(provider),
      catalogRow: ctx.catalogRowFor?.(provider, model),
    });

    const entry: CostEntry = {
      provider,
      model,
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      // A cache figure is a SUBSET of the input tokens; clamped so a provider
      // that reports nonsense cannot make the ledger claim more cached tokens
      // than it sent.
      ...(typeof cachedInputTokens === 'number' && Number.isFinite(cachedInputTokens) && cachedInputTokens > 0
        ? { cachedInputTokens: Math.min(cachedInputTokens, inputTokens) }
        : {}),
      costUsd: resolved.billedUsd,
      task,
      // M2.2: must be set BEFORE persist below — the entry is serialized in
      // writeCosts and any post-hoc mutation never reaches disk (which would
      // silently zero the dashboard's measured-vs-estimated split).
      measured,
      // Set (only when true) so the dashboard can show provider-billed spend
      // apart from locally-priced estimates.
      ...(costReported ? { costReported: true } : {}),
      costSource: resolved.costSource,
      ...(resolved.listUsd !== undefined ? { listPriceUsd: resolved.listUsd } : {}),
      billingTier: resolved.billingTier,
      pricingBasis: resolved.basis,
      // `live` or `test`, by the registry's own rule — a row written by a test run
      // must be excludable from a live profile's view, and before this the ledger
      // had no way to tell (747 mock-endpoint rows were counted as real spend).
      origin: telemetryOrigin(),
    };

    // Store in session
    this.sessionEntries.push(entry);

    // Persist to disk
    const data = readCosts();
    data.entries.push(entry);

    // Prune old entries if over limit
    if (data.entries.length > MAX_ENTRIES) {
      data.entries = data.entries.slice(-MAX_ENTRIES);
    }

    writeCosts(data);

    // ── Write-through to the central quota ledger ────────────────────────
    // Every LLM call (via the adapters' recordCallEstimated) also records
    // usage in the quota ledger so Auto routing can park exhausted providers
    // until their reset window rolls. Best-effort — never break the call.
    try {
      getQuotaLedger().recordUsage(provider, model, inputTokens, outputTokens);
    } catch {
      // Ledger is best-effort; cost recording must never crash on it.
    }

    // ── Write-through to the Model Availability Registry ─────────────────
    // A successful real call is the strongest signal a model works — upgrade
    // it to `verified` (source: telemetry) so future routing trusts it without
    // a network probe. Best-effort — never break the call.
    try {
      getModelRegistry().recordCall(provider, model, true);
    } catch {
      // Registry is best-effort.
    }

    return entry;
  }

  /**
   * Record a call with EXACT tokens reported by the provider/gateway usage
   * (M2.2 wire-token metering). Cost is computed from real token counts × the
   * same per-1K pricing, the entry is flagged `measured: true`, and the exact
   * tokens also flow to the Model Availability Registry so Auto routing's cost
   * scoring can prefer measured cost over TYPICAL-token estimates.
   */
  recordCallMeasured(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    task?: string,
    reportedCostUsd?: number,
    cachedInputTokens?: number,
  ): CostEntry {
    // measured: true is set inside recordCall BEFORE the entry is persisted,
    // so the dashboard's measured-vs-estimated split reads correctly from disk.
    const entry = this.recordCall(
      provider,
      model,
      inputTokens,
      outputTokens,
      task,
      true,
      reportedCostUsd,
      cachedInputTokens,
    );
    // Write the exact measured tokens through to the registry (best-effort) so
    // getMeasuredUsage() feeds measured-cost routing scoring.
    try {
      getModelRegistry().recordMeasuredUsage(provider, model, inputTokens, outputTokens);
    } catch {
      // Registry is best-effort.
    }
    return entry;
  }

  /**
   * Record a call with estimated tokens from prompt/response lengths.
   * Useful when the API doesn't return exact token counts.
   */
  recordCallEstimated(
    provider: string,
    model: string,
    promptText: string,
    responseText: string,
    task?: string,
  ): CostEntry {
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(responseText);
    return this.recordCall(provider, model, inputTokens, outputTokens, task);
  }

  /**
   * Get cost summary across all time and current session.
   *
   * The classified figures come from ONE pass (`cost-classification.ts`), so the
   * CLI, the dashboard and the reconciliation check cannot disagree about which
   * bucket a call belongs to — which is exactly how the cost picture drifted
   * before. Test-origin rows are excluded from the buckets and counted instead.
   */
  getSummary(): CostSummary {
    const data = readCosts();
    const allEntries = data.entries;
    // A DISPLAY surface: a row written by a test run is not the user's usage, so
    // it is excluded from these buckets and counted in `testOriginCalls` instead
    // (the same posture the model registry takes with test-origin telemetry).
    const totals = classifyEntries(allEntries, { excludeTestOrigin: true });
    const r6 = (n: number) => Math.round(n * 100000) / 100000;

    // Kept for compatibility with callers that read raw per-provider/model totals.
    // These are the RECORDED sums (old-table rows included), not the buckets above.
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCost = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;

    for (const entry of allEntries) {
      totalCost += entry.costUsd || 0;
      totalTokens += entry.totalTokens || 0;
      inputTokens += entry.inputTokens || 0;
      cachedInputTokens += entry.cachedInputTokens || 0;
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + (entry.costUsd || 0);
      byModel[entry.model] = (byModel[entry.model] || 0) + (entry.costUsd || 0);
    }

    const sessionCost = this.sessionEntries.reduce((sum, e) => sum + e.costUsd, 0);

    return {
      totalCost: r6(totalCost),
      billedUsd: totals.billedUsd,
      billedReportedUsd: totals.billedReportedUsd,
      billedListedUsd: totals.billedListedUsd,
      unverifiedListedUsd: totals.unverifiedListedUsd,
      notBilledValueUsd: totals.notBilledValueUsd,
      unpricedCalls: totals.unpricedCalls,
      unpricedTokens: totals.unpricedTokens,
      recomputedCalls: totals.recomputedCalls,
      testOriginCalls: totals.testOriginCalls,
      billedReportedCalls: totals.billedReportedCalls,
      billedListedCalls: totals.billedListedCalls,
      unverifiedListedCalls: totals.unverifiedListedCalls,
      notBilledValueCalls: totals.notBilledValueCalls,
      totals,
      byProvider,
      byModel,
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheHitRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      totalRequests: allEntries.length,
      sessionRequests: this.sessionEntries.length,
      sessionCost: r6(sessionCost),
      sessionStart: this.sessionStart,
    };
  }

  /**
   * Format the ledger HONESTLY: what is billed (and on what evidence), what a free
   * tier absorbed as value, what is list-priced but unverified, and what has no
   * price at all.
   *
   * "Total spent" is deliberately not a line. The ledger cannot see a provider's
   * invoice, so it reports what it can evidence, separates the value a free tier
   * saved from money owed, and says what it does not know — instead of printing
   * one sum that is part spend, part list-price fiction.
   */
  formatSummary(): string {
    const s = this.getSummary();
    const usd = (n: number) => `$${n.toFixed(6)}`;

    const lines: string[] = [
      '💰 Cost Ledger',
      '',
      '── Session ──',
      `   Started: ${new Date(s.sessionStart).toLocaleString()}`,
      `   Requests: ${s.sessionRequests}`,
      `   Attributed cost: ${usd(s.sessionCost)}`,
      '',
      '── All Time ──',
      `   Requests: ${s.totalRequests}`,
      `   Tokens:   ${formatCount(s.totalTokens)}`,
      // The cache figure is reported as its own line, next to the token count it
      // qualifies: a 58M-input session that was 99% cache read is a very
      // different bill from 58M fresh tokens, and only the provider can say which
      // it was. Omitted entirely when no endpoint ever reported one.
      ...(s.cachedInputTokens > 0
        ? [
            `   Cache read: ${formatCount(s.cachedInputTokens)} of ${formatCount(s.inputTokens)} input tokens ` +
              `(${(s.cacheHitRate * 100).toFixed(1)}%)`,
          ]
        : []),
      '',
      '── Billed — what you owe, by evidence ──',
      `   🧾 provider-reported (exact):            ${usd(s.billedReportedUsd)}  (${s.billedReportedCalls} calls)`,
      `   📋 list-priced, account declared paid:   ${usd(s.billedListedUsd)}  (${s.billedListedCalls} calls)`,
      `   = billed total:                         ${usd(s.billedUsd)}`,
      '',
      '── Not billed ──',
      `   🎁 free/subscription value at list price: ${usd(s.notBilledValueUsd)}  (${s.notBilledValueCalls} calls)`,
      `   ❓ list-priced, billing tier UNDECLARED:  ${usd(s.unverifiedListedUsd)}  (${s.unverifiedListedCalls} calls)`,
      '      not counted as spend — declare it: nuvira config set providers.<id>.billingTier paid|free|subscription',
      `   ⚪ unpriced (no price evidence / gateway): ${s.unpricedCalls} calls, ${formatCount(s.unpricedTokens)} tokens`,
      '',
    ];

    const providers = Object.entries(s.totals.byProvider);
    if (providers.length > 0) {
      lines.push('── By Provider ──');
      lines.push('   provider          billed      unverified    value      unpriced');
      const sorted = providers.sort(([, a], [, b]) => b.billedUsd - a.billedUsd);
      for (const [provider, t] of sorted) {
        lines.push(
          `   ${provider.padEnd(17)} ${usd(t.billedUsd).padEnd(11)} ${usd(t.unverifiedListedUsd).padEnd(13)} ${usd(t.notBilledValueUsd).padEnd(10)} ${t.unpricedCalls} calls`,
        );
      }
      lines.push('');
    }

    const models = Object.entries(s.totals.byModel);
    if (models.length > 0) {
      lines.push('── By Model (top 10 by billed) ──');
      const sorted = models.sort(([, a], [, b]) => b.billedUsd - a.billedUsd).slice(0, 10);
      for (const [model, t] of sorted) {
        lines.push(
          `   ${model.slice(0, 40).padEnd(42)} billed ${usd(t.billedUsd)}  value ${usd(t.notBilledValueUsd)}`,
        );
      }
      lines.push('');
    }

    const notes: string[] = [];
    if (s.recomputedCalls > 0) {
      notes.push(
        `   • ${s.recomputedCalls} row(s) predate cost classification and were re-derived at read time (the file was not rewritten).`,
      );
    }
    if (s.testOriginCalls > 0) {
      notes.push(
        `   • ${s.testOriginCalls} test-origin row(s) excluded from these totals — a test run is not your usage.`,
      );
    }
    if (s.totalCost > 0 && s.recomputedCalls > 0) {
      notes.push(
        `   • Ledger total as recorded (legacy figure): ${usd(s.totalCost)} — re-price the history with \`nuvira stats cost reprice\`.`,
      );
    }
    notes.push(
      '   • Reconcile against the provider\'s own invoice: `nuvira stats cost reconcile --provider <id> --amount <usd>`',
    );
    lines.push('── Notes ──', ...notes, '');

    return lines.join('\n');
  }

  /**
   * Clear all cost tracking data.
   */
  clear(): void {
    this.sessionEntries = [];
    this.sessionStart = Date.now();
    writeCosts({ entries: [], version: CURRENT_VERSION });
  }

  /**
   * Get all cost entries (for export).
   */
  getAllEntries(): CostEntry[] {
    const data = readCosts();
    return [...data.entries];
  }
}

// Singleton instance
let trackerInstance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!trackerInstance) {
    trackerInstance = new CostTracker();
  }
  return trackerInstance;
}

/**
 * Spend and tokens recorded at or after `since` (epoch ms) — the per-batch
 * economy window for unattended runs (G27).
 *
 * Read from the PERSISTED ledger rather than a session counter on purpose: a
 * continuation batch runs through a fresh orchestrator (and after a resume, a
 * fresh process), so an instance counter would report zero for every batch but
 * the first. A timestamp window is the only measure that survives that.
 */
export function costSince(since: number): { costUsd: number; tokens: number; requests: number } {
  return costSinceSplit(since).attributed;
}

/**
 * The full, provenance-carrying view of a window — for callers that must not
 * conflate an estimate with a bill. `attributed` is what `costSince` returns.
 */
export function costSinceSplit(since: number): {
  attributed: { costUsd: number; tokens: number; requests: number };
  billedUsd: number;
  unverifiedListedUsd: number;
  notBilledValueUsd: number;
  unpricedCalls: number;
} {
  const totals = classifyEntries(readCosts().entries.filter((e) => e.timestamp >= since));
  return {
    // The window's BILLED figure, and nothing else — so the invariant a reader
    // relies on holds: the window equals the sum of its rows' `costUsd`. A row
    // whose tier is undeclared contributes 0 here and appears in
    // `unverifiedListedUsd` below; a free tier's list value appears in
    // `notBilledValueUsd`. Neither is ever reported as this window's cost.
    attributed: {
      costUsd: totals.billedUsd,
      tokens: totals.tokens,
      requests: totals.requests,
    },
    billedUsd: totals.billedUsd,
    unverifiedListedUsd: totals.unverifiedListedUsd,
    notBilledValueUsd: totals.notBilledValueUsd,
    unpricedCalls: totals.unpricedCalls,
  };
}

/**
 * M2.2: record a call preferring MEASURED wire tokens when the provider
 * reported usage; otherwise fall back to the length-based estimate. Shared by
 * the OpenAI-compatible adapters so the measured-vs-estimated logic lives in
 * one place. Best-effort — never throws.
 */
export function recordCallWithUsage(
  costTracker: CostTracker,
  provider: string,
  model: string,
  prompt: string,
  content: string,
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    cachedPromptTokens?: number;
  },
  reportedCostUsd?: number,
): void {
  // Prefer the explicit reported-cost argument, else the cost carried on the
  // usage object (sse/tools attach it from the endpoint's `usage.cost`).
  const cost =
    typeof reportedCostUsd === 'number'
      ? reportedCostUsd
      : typeof usage?.costUsd === 'number'
        ? usage.costUsd
        : undefined;
  if (usage && typeof usage.promptTokens === 'number' && typeof usage.completionTokens === 'number') {
    costTracker.recordCallMeasured(
      provider,
      model,
      usage.promptTokens,
      usage.completionTokens,
      undefined,
      cost,
      usage.cachedPromptTokens,
    );
  } else {
    // No measured tokens: estimate token counts, but still honor a
    // provider-reported cost when the endpoint gave us one.
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(content);
    costTracker.recordCall(provider, model, inputTokens, outputTokens, undefined, undefined, cost);
  }
}
