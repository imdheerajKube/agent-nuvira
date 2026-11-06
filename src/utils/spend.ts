/**
 * WHAT a window of model calls cost, and the ONE set of rules for saying it.
 *
 * WHY THIS IS ITS OWN, PURE MODULE. Five surfaces describe the same money: the CLI
 * turn report, the console turn block, the unattended-run batch table (CLI and
 * dashboard), and the dashboard's turn card. Each used to hold its own `usd`
 * number and print it with a `$` — and because the evidence-backed bill is 0 for
 * every list-priced call whose account has no declared `billingTier` (the DEFAULT
 * for a fresh install), the common case printed `$0.000000` on a turn that was
 * never priced. A per-surface formatter is how that happens; this module exists so
 * there is only one, and so a dollar cannot be printed without its evidence.
 *
 * PURE ON PURPOSE — no fs, no config, no ledger. That is what lets the browser
 * bundle import the SAME rules the CLI prints with (`web-dashboard/src/format.ts`
 * re-exports them), instead of the dashboard re-implementing the labels and
 * drifting from the terminal.
 *
 * THE BUCKETS (defined by `learning/cost-classification.ts`, carried here):
 *
 *   reported    the provider stated this call's charge — EXACT.
 *   listed      list price on an account DECLARED `paid` — an estimate of money owed.
 *   unverified  list price on an account with NO declared tier — not known to be
 *               spend at all (a free tier bills nothing), so it must never be added
 *               to a bill and printed as one.
 *   free        provably no per-call charge: a local runtime, a `:free` model, or a
 *               declared free/subscription account. `$0` here is TRUE.
 *   unpriced    no price evidence whatsoever. No dollar may be printed.
 *
 * `tokens` and `calls` are the only units that hold for every provider (including
 * local and keyless gateways), so they are always present and always printable;
 * money is optional and every clause that shows it names its evidence.
 */

/** One window's spend, split by the evidence behind each figure. */
export interface SpendBreakdown {
  tokens: number;
  calls: number;
  /** Calls whose charge the provider itself stated. */
  reportedCalls: number;
  exactUsd: number;
  /** Calls list-priced on an account declared `paid`. */
  listedCalls: number;
  estimatedUsd: number;
  /** Calls list-priced on an account whose billing tier is UNDECLARED. */
  unverifiedCalls: number;
  unverifiedUsd: number;
  /** Providers with no declared tier, named so the remedy is one command. */
  unverifiedProviders: string[];
  /** Calls a free/subscription tier (or a local runtime) absorbed. */
  freeCalls: number;
  freeValueUsd: number;
  /** Calls with no price evidence at all. */
  unpricedCalls: number;
}

/** Nothing recorded yet — a starting point for accumulation, never a printed claim. */
export function zeroSpend(): SpendBreakdown {
  return {
    tokens: 0,
    calls: 0,
    reportedCalls: 0,
    exactUsd: 0,
    listedCalls: 0,
    estimatedUsd: 0,
    unverifiedCalls: 0,
    unverifiedUsd: 0,
    unverifiedProviders: [],
    freeCalls: 0,
    freeValueUsd: 0,
    unpricedCalls: 0,
  };
}

/**
 * Add two breakdowns — for a batch summed across windows.
 *
 * Provider ids are UNIONED, not concatenated: the same provider left undeclared
 * across ten batches must produce one `declare providers.<id>.billingTier`
 * remedy, not ten.
 */
export function addSpend(a: SpendBreakdown, b: SpendBreakdown): SpendBreakdown {
  return {
    tokens: a.tokens + b.tokens,
    calls: a.calls + b.calls,
    reportedCalls: a.reportedCalls + b.reportedCalls,
    exactUsd: a.exactUsd + b.exactUsd,
    listedCalls: a.listedCalls + b.listedCalls,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    unverifiedCalls: a.unverifiedCalls + b.unverifiedCalls,
    unverifiedUsd: a.unverifiedUsd + b.unverifiedUsd,
    unverifiedProviders: [...new Set([...a.unverifiedProviders, ...b.unverifiedProviders])].sort(),
    freeCalls: a.freeCalls + b.freeCalls,
    freeValueUsd: a.freeValueUsd + b.freeValueUsd,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  };
}

/**
 * The most a window could plausibly have cost — used ONLY for "is this worth
 * saying out loud" thresholds, never printed. The unverified bucket counts here
 * because it might be real money; excluding it is how a turn that may have cost
 * money would stay silent.
 */
export function spendCeilingUsd(spend: SpendBreakdown): number {
  return spend.exactUsd + spend.estimatedUsd + spend.unverifiedUsd;
}

/** `$0.0044` / `$0.000400` — money at the precision the amount actually has. */
function usd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(6)}`;
}

/** `1.19M tok` / `12.3K tok` / `420 tok` — digits people can scan. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tok`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K tok`;
  return `${tokens} tok`;
}

/** `providers.deepseek.billingTier` (or a short list) — the command that fixes it. */
export function tierDeclaration(providers: readonly string[]): string {
  const ids = [...new Set(providers.filter((p) => p.length > 0))];
  if (ids.length === 0) return 'providers.<id>.billingTier';
  const named = ids.slice(0, 3).map((id) => `providers.${id}.billingTier`).join(', ');
  return ids.length > 3 ? `${named} (+${ids.length - 3} more)` : named;
}

/**
 * `~$0.004400 unverified · 12.3K tok · 1 call — declare providers.deepseek.billingTier`
 *
 * THE RULE: a dollar figure may not be printed without the word that says what it
 * is. `free` and `unknown` are opposite claims and must never render alike — that
 * is exactly what the old single-`usd` shape did, printing `$0.000000` for both.
 */
export function formatSpendFull(spend: SpendBreakdown): string {
  const money: string[] = [];
  // Each clause names its evidence. A provider-stated $0 is exact and true, so it
  // prints as `$0 exact` rather than being dropped as "nothing to say".
  if (spend.reportedCalls > 0) {
    money.push(spend.exactUsd > 0 ? `${usd(spend.exactUsd)} exact` : '$0 exact');
  }
  if (spend.listedCalls > 0) money.push(`~${usd(spend.estimatedUsd)} est.`);
  if (spend.unverifiedCalls > 0) money.push(`~${usd(spend.unverifiedUsd)} unverified`);
  // Only when no priced bucket exists: `free` and `unknown` are opposite claims.
  if (money.length === 0) {
    if (spend.freeCalls > 0) money.push('$0 free');
    if (spend.unpricedCalls > 0) money.push('price unknown');
  } else if (spend.unpricedCalls > 0) {
    money.push(`${spend.unpricedCalls} unpriced`);
  }

  const parts = [
    ...(money.length > 0 ? [money.join(' + ')] : []),
    formatTokenCount(spend.tokens),
    `${spend.calls} call${spend.calls === 1 ? '' : 's'}`,
  ].filter((p) => p.length > 0);

  const hint =
    spend.unverifiedCalls > 0 ? ` — declare ${tierDeclaration(spend.unverifiedProviders)}` : '';
  return `${parts.join(' · ')}${hint}`;
}

/**
 * A TABLE CELL for the same spend: short enough for a column, and still unable to
 * pass off an unknown as money.
 *
 *   `$0.00123`   paid at a list price on a declared-`paid` account (or reported)
 *   `~$0.00123`  some of it is a LIST PRICE — an estimate of money owed
 *   `$0.00123?`  priced, but the batch also made calls that could NOT be priced
 *   `?`          nothing in the batch could be priced at all
 *   `free`       provably no per-call charge (local / :free / declared free)
 *   `—`          no call was metered in this window
 *
 * `marks` lists the marks actually used, so a caller can print the legend only
 * when it applies (`SPEND_MARKS_LEGEND`).
 */
export function formatSpendCell(spend: SpendBreakdown | undefined): { text: string; marks: string[] } {
  if (!spend) return { text: '—', marks: [] };

  const marks: string[] = [];
  const priced = spend.exactUsd + spend.estimatedUsd;
  const unpriceable = spend.unverifiedCalls > 0 || spend.unpricedCalls > 0;

  if (priced > 0) {
    if (spend.estimatedUsd > 0) marks.push('~');
    if (unpriceable) marks.push('?');
    return {
      text: `${spend.estimatedUsd > 0 ? '~' : ''}${usd(priced)}${unpriceable ? '?' : ''}`,
      marks,
    };
  }
  // Nothing evidence-billed, but a list price exists for an UNDECLARED tier: the
  // money is real enough to show and not real enough to claim, so it carries both
  // marks.
  if (spend.unverifiedUsd > 0) return { text: `~${usd(spend.unverifiedUsd)}?`, marks: ['~', '?'] };

  if (spend.unpricedCalls > 0) return { text: '?', marks: ['?'] };
  if (spend.freeCalls > 0) return { text: 'free', marks: [] };
  return { text: '—', marks: [] };
}

/** The legend for the marks `formatSpendCell` emits — printed only when used. */
export const SPEND_MARKS_LEGEND =
  '~ = list price, an estimate of money owed · ? = calls that could not be priced (declare providers.<id>.billingTier)';
