/**
 * Stats command — View usage statistics and cost tracking.
 *
 * Usage:
 *   nuvira stats                          — Show all stats summary
 *   nuvira stats cost                     — Show cost tracking details
 *   nuvira stats cost --clear             — Reset cost tracking data
 *   nuvira stats cost reconcile ...       — compare the ledger to a provider invoice
 *   nuvira stats cost bill ...            — ask the providers for their OWN figures (live)
 *   nuvira stats cost reprice             — re-price legacy rows (dry run; --apply writes)
 *   nuvira stats history                  — Show conversation history stats
 *
 * ─── WHY reconcile / reprice EXIST (read before editing their defaults) ─────
 *
 * `stats cost` prints what the ledger can EVIDENCE, and the ledger cannot see a
 * provider's invoice. That is not a defect to paper over with a nicer estimate:
 * the fix is to let the operator supply the one number that is actual — the
 * provider's own charge for a stated window — and to say honestly how far the
 * ledger is from it, and what the gap consists of. `reconcile` is therefore the
 * only command in this file that reports a figure no local computation could
 * produce, and it never adjusts the ledger to agree.
 *
 * `reprice` is the explicit, dry-run-default repair of the rows already on disk
 * (legacy prices from the retired hardcoded table, test-origin rows). Both are
 * documented in `learning/cost-reconcile.ts` and `learning/cost-ledger-maintenance.ts`.
 *
 * `bill` is the missing third leg: instead of asking the operator to type a
 * number, it asks the PROVIDER for its own (DeepSeek balance, OpenRouter key
 * usage, OpenAI/Anthropic organization cost reports). It is deliberately separate
 * from `reconcile`: a balance is not a bill, and an organization-wide report is
 * not this key's spend, so neither is auto-fed into a comparison that would then
 * look authoritative. See `learning/provider-billing.ts`.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import {
  getCostTracker,
  resetPricingContextCache,
  type BillingTier,
} from '../learning/cost-tracker.js';
import { asBillingTier, BILLING_TIERS } from '../learning/model-pricing.js';
import {
  formatReconciliation,
  reconcileEntries,
  recordReconciliation,
  reconciliationLedgerPath,
} from '../learning/cost-reconcile.js';
import { formatMaintenanceReport, maintainCostLedger } from '../learning/cost-ledger-maintenance.js';
import {
  fetchProviderStatement,
  formatStatements,
  hasBillingSource,
  providerLabel,
  BILLING_SOURCES,
  DEFAULT_BILLING_WINDOW_DAYS,
  type ProviderStatement,
} from '../learning/provider-billing.js';
import { CATALOG_PROVIDER_IDS } from '../inference/provider-catalog.js';
import { getChatHistory } from '../context/history.js';
import { logger } from '../utils/logger.js';

/** One day in ms — the unit the CLI's window flags speak in. */
const DAY_MS = 24 * 60 * 60 * 1000;

interface ReconcileOptions {
  provider: string;
  amount: string;
  days?: string;
  since?: string;
  until?: string;
  note?: string;
  declareTier?: string | boolean;
  json?: boolean;
}

interface RepriceOptions {
  apply?: boolean;
  keepTestRows?: boolean;
  file?: string;
  json?: boolean;
}

interface BillOptions {
  provider?: string;
  days?: string;
  json?: boolean;
}

export class StatsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('stats')
      .description('View usage statistics and cost tracking');

    // ── cost ─────────────────────────────────────────────────────────────
    const costCmd = new Command('cost')
      .description('Show API cost tracking details')
      .option('--clear', 'Reset all cost tracking data')
      .action(async (options?: { clear?: boolean }) => {
        await this.showCost(options);
      });

    // ── cost reconcile ───────────────────────────────────────────────────
    costCmd.addCommand(
      new Command('reconcile')
        .description("Compare this ledger to a provider's OWN invoice for a window (the only 'actual' figure)")
        .requiredOption('-p, --provider <id>', 'provider id the invoice line belongs to (e.g. deepseek)')
        .requiredOption('-a, --amount <usd>', "the provider's own charge for the window, in USD (e.g. 12.34)")
        .option('--days <n>', `window: the last N days, ending now (default: the current calendar month)`)
        .option('--since <iso|epochMs>', 'window start (overrides --days)')
        .option('--until <iso|epochMs>', 'window end, exclusive (default: now)')
        .option('--note <text>', 'where the figure came from, printed with the result (e.g. "dashboard, Oct 2026")')
        .option(
          '--declare-tier [tier]',
          'record the billing fact this invoice EVIDENCES (paid|free|subscription); no value = the tier the invoice proves',
        )
        .option('--json', 'machine-readable JSON report')
        .action(async (options: ReconcileOptions) => {
          await this.reconcileCost(options);
        }),
    );

    // ── cost bill ────────────────────────────────────────────────────────
    costCmd.addCommand(
      new Command('bill')
        .description("Ask each provider for its OWN spend/balance figure (live; DeepSeek, OpenRouter, OpenAI, Anthropic)")
        .option('-p, --provider <id>', 'only this provider id (default: every configured provider with a billing endpoint)')
        .option('--days <n>', `window for window-scoped reports, in days (default: ${DEFAULT_BILLING_WINDOW_DAYS})`)
        .option('--json', 'machine-readable JSON report')
        .action(async (options: BillOptions) => {
          await this.showProviderBills(options);
        }),
    );

    // ── cost reprice ─────────────────────────────────────────────────────
    costCmd.addCommand(
      new Command('reprice')
        .description('Re-price legacy ledger rows with the ONE price source; drop test rows (dry run by default)')
        .option('--apply', 'write the repaired ledger (a .bak is kept beside it)')
        .option('--keep-test-rows', 're-price only: do NOT drop test-origin / fixture-id rows')
        .option('--file <path>', 'a specific cost ledger file (default: the resolved profile ledger)')
        .option('--json', 'machine-readable JSON report')
        .action((options: RepriceOptions) => {
          this.repriceLedger(options);
        }),
    );

    command.addCommand(costCmd);

    // ── history ──────────────────────────────────────────────────────────
    const historyCmd = new Command('history')
      .description('Show conversation history statistics')
      .action(() => {
        this.showHistoryStats();
      });

    command.addCommand(historyCmd);

    // Default: show all stats
    command.action(() => {
      this.showAllStats();
    });

    return command;
  }

  private async showCost(options?: { clear?: boolean }): Promise<void> {
    if (options?.clear) {
      getCostTracker().clear();
      logger.success('Cost tracking data cleared.');
      return;
    }

    const tracker = getCostTracker();
    console.log(`\n${tracker.formatSummary()}`);
  }

  /**
   * `stats cost reconcile` — the provider's own figure vs this ledger.
   *
   * Two rules the defaults encode:
   *  1. A WINDOW IS MANDATORY. Comparing an all-time ledger to a monthly invoice
   *     is a meaningless subtraction that would print a delta as if it meant
   *     something. The default is the current calendar month, and the window is
   *     always printed so a partial (still-running) period can be judged as such.
   *  2. THE PROVIDER IS VALIDATED. An unknown id would otherwise read as "no
   *     rows", i.e. a silent zero that looks like "you used nothing" rather than
   *     "you typed the wrong id".
   */
  private async reconcileCost(options: ReconcileOptions): Promise<void> {
    const claim = this.buildClaim(options);
    if (!claim) return;

    const report = reconcileEntries(claim, getCostTracker().getAllEntries());
    // The record is the audit trail: "this was checked against the October
    // invoice, and the gap was $0.03". A later check appends; nothing is erased.
    recordReconciliation(report);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`\n${formatReconciliation(report)}`);
    console.log(`   Recorded in ${reconciliationLedgerPath()}\n`);

    if (options.declareTier !== undefined) {
      this.applyTierDeclaration(claim.provider, options.declareTier, report);
    } else if (report.tierEvidence) {
      // Evidence was found but recording it is the operator's call: writing a
      // config field on the strength of a run they may not have intended as a
      // declaration would be its own kind of assumption.
      logger.info(
        `   This invoice EVIDENCES billingTier=${report.tierEvidence.tier} for ${claim.provider}. Record it with:\n` +
          `   nuvira stats cost reconcile --provider ${claim.provider} --amount ${claim.invoiceUsd} --declare-tier`,
      );
    }
  }

  /**
   * Turn the CLI flags into an invoice claim, or explain why they cannot be.
   * Returns null after printing the reason — the command exits without a report
   * rather than reconciling against a window we had to guess.
   */
  private buildClaim(options: ReconcileOptions): {
    provider: string;
    invoiceUsd: number;
    since: number;
    until: number;
    note?: string;
  } | null {
    const provider = (options.provider || '').trim();
    const known = new Set<string>([
      ...CATALOG_PROVIDER_IDS,
      ...Object.keys(this.configManager.getAll().providers || {}),
      // Ids that appear in the ledger are real even when they are not in the
      // catalog (a plugin provider, a sidecar gateway) — never reject those.
      ...getCostTracker()
        .getAllEntries()
        .map((e) => e.provider),
    ]);
    if (!known.has(provider)) {
      logger.error(
        `Unknown provider "${provider}". Known ids: ${[...known].sort().join(', ')}`,
      );
      logger.info(
        '  Use the id the ledger records (the `By Provider` table of `nuvira stats cost`) — reconciling against a typo would report zero usage.',
      );
      return null;
    }

    const invoiceUsd = parseAmount(options.amount);
    if (invoiceUsd === null) {
      logger.error(
        `Invalid --amount "${options.amount}". Pass the provider's charge in USD, e.g. --amount 12.34 (0 is valid: nothing was charged).`,
      );
      return null;
    }

    const now = Date.now();
    let since: number | undefined;
    let until: number | undefined;

    const parseWhen = (raw: string, label: string): number | null => {
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
      logger.error(`Invalid ${label} "${raw}". Use an ISO date (2026-10-01) or epoch milliseconds.`);
      return null;
    };

    if (options.since !== undefined) {
      if (options.days !== undefined) {
        logger.error('Use either --since or --days, not both — the window must be unambiguous.');
        return null;
      }
      const parsed = parseWhen(options.since, '--since');
      if (parsed === null) return null;
      since = parsed;
    } else if (options.days !== undefined) {
      const days = Number(options.days);
      if (!Number.isFinite(days) || days <= 0) {
        logger.error(`Invalid --days "${options.days}". Pass a positive number of days.`);
        return null;
      }
      since = now - days * DAY_MS;
    } else {
      // The current calendar month, local time — what most providers bill in.
      const start = new Date(now);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      since = start.getTime();
      if (since > now) {
        // A clock at the very start of the month: fall back to the last 24h so
        // the window is never empty-by-construction.
        since = now - DAY_MS;
      }
    }

    if (options.until !== undefined) {
      const parsed = parseWhen(options.until, '--until');
      if (parsed === null) return null;
      until = parsed;
    } else {
      // HALF-OPEN WINDOW, INCLUSIVE-AT-THE-END DEFAULT. A ledger row's timestamp
      // is `Date.now()` at record time and so is this one, in the SAME
      // millisecond resolution — so a default end of exactly `now` drops a row
      // recorded a moment earlier. MEASURED while writing these tests: the row
      // landed ON `until` and the report said "no ledger rows in this window".
      // A boundary the operator did not state has no business excluding
      // anything, so the default end is one millisecond past now. An EXPLICIT
      // `--until` keeps the half-open meaning, so reconciling September and then
      // October cannot count a midnight-boundary row twice.
      until = now + 1;
    }

    if (until <= since) {
      logger.error('The window end must be after its start.');
      return null;
    }

    const startOfMonth = new Date(since);
    if (until > now - 60_000 && startOfMonth.getDate() === 1) {
      logger.info(
        '   Note: the window runs up to now, so if this billing period has not closed the invoice may still be partial.',
      );
    }

    return {
      provider,
      invoiceUsd,
      since,
      until,
      ...(options.note ? { note: options.note } : {}),
    };
  }

  /**
   * Record the billing fact, but ONLY one the invoice does not contradict.
   *
   * This is the whole point of the exercise: `billingTier` moves the headline
   * from "unverified" to "billed", so letting a user declare `free` while holding
   * an invoice that charged $18 would reintroduce exactly the fabricated picture
   * this change removed. A refusal is the useful answer.
   */
  private applyTierDeclaration(
    provider: string,
    requested: string | boolean,
    report: {
      invoiceUsd: number;
      requests: number;
      tierEvidence?: { tier: BillingTier; basis: string };
    },
  ): void {
    let tier: BillingTier;
    if (requested === true) {
      if (!report.tierEvidence) {
        logger.error(
          'This reconciliation does not prove a billing tier — the CLI will not guess one. Pass it explicitly if you know it: --declare-tier paid|free|subscription',
        );
        return;
      }
      tier = report.tierEvidence.tier;
    } else {
      const typed = asBillingTier(String(requested).trim().toLowerCase());
      if (!(BILLING_TIERS as readonly string[]).includes(String(requested).trim().toLowerCase())) {
        logger.error(`Invalid tier "${String(requested)}". Valid values: ${BILLING_TIERS.join(' | ')}.`);
        return;
      }
      tier = typed;
    }

    // The invoice is evidence against these two claims; refuse rather than write
    // a fact the provider's own bill contradicts.
    if ((tier === 'free' || tier === 'subscription') && report.invoiceUsd > 0) {
      logger.error(
        `Refusing to declare "${tier}": the invoice you entered charged $${report.invoiceUsd.toFixed(6)} for this window, so this key IS billed per call. Declare \`paid\` (metered), or \`subscription\` only if a flat plan covers these calls and the charge you entered is that plan's fee.`,
      );
      return;
    }
    if (tier === 'paid' && report.invoiceUsd === 0 && report.requests > 0) {
      logger.error(
        `Refusing to declare "paid": the invoice you entered is $0 across ${report.requests} call(s), so nothing was charged. Declare \`free\`, or re-run with the correct invoice amount.`,
      );
      return;
    }

    this.configManager.save({ providers: { [provider]: { billingTier: tier } } });
    // The classification context caches a config read for the process; drop it so
    // any later read in this process (tests, a wrapper) sees the new fact.
    resetPricingContextCache();
    logger.success(
      `Recorded providers.${provider}.billingTier = ${tier} — evidenced by the invoice, not assumed.`,
    );
    if (tier === 'paid') {
      logger.info('  List-priced calls for this provider now count as an estimated bill (the invoice remains the actual figure).');
    } else {
      logger.info('  Calls for this provider are now $0 billed by evidence; their list price is reported as value, never spend.');
    }
  }

  /**
   * `stats cost bill` — the provider's own figure, fetched live.
   *
   * PROVIDER SELECTION. `--provider X` asks X (even when X has no configured key,
   * which then reports "no API key" rather than silently vanishing). Otherwise it
   * asks every CONFIGURED provider: those are the accounts the user actually
   * holds, and a provider whose key came from the environment is in the config
   * too (ConfigManager maps every catalog env var into `providers.<id>`).
   *
   * NO AUTO-RECONCILE. The output hands the user the exact `reconcile` command
   * instead of writing a reconciliation itself: an OpenAI/Anthropic report is
   * ORG-wide and a DeepSeek balance is not a charge, so auto-comparing either to
   * this ledger would manufacture a delta that means nothing.
   */
  private async showProviderBills(options: BillOptions): Promise<void> {
    const days = options.days === undefined ? DEFAULT_BILLING_WINDOW_DAYS : Number(options.days);
    if (!Number.isFinite(days) || days <= 0) {
      logger.error(`Invalid --days "${options.days}". Pass a positive number of days.`);
      return;
    }

    const config = this.configManager.getAll();
    const providers = config.providers || {};
    const apiKeyOf = (id: string): string | undefined => {
      const key = providers[id]?.apiKey;
      return typeof key === 'string' && key.trim() !== '' ? key : undefined;
    };

    // Vault-stored keys (`vault:<account>`) are refs until the vault is attached.
    // Attach + hydrate here, exactly as startup does, so a keychain-backed profile
    // can bill itself instead of reporting "no API key". Best-effort: a missing
    // keyring must not break the command.
    if (Object.keys(providers).some((id) => apiKeyOf(id)?.startsWith('vault:') === true)) {
      try {
        const { Vault } = await import('../enterprise/vault.js');
        this.configManager.attachVault(Vault.open({}));
        await this.configManager.hydrateVaultRefs();
      } catch {
        // Best-effort — the per-provider error below will name the problem.
      }
    }

    let targets: string[];
    if (options.provider) {
      const requested = options.provider.trim().toLowerCase();
      const known = new Set<string>([...Object.keys(BILLING_SOURCES), ...Object.keys(providers)]);
      if (!known.has(requested)) {
        logger.error(
          `Unknown provider "${options.provider}". Known ids: ${[...known].sort().join(', ')}`,
        );
        logger.info(
          `  Live billing is available for: ${Object.keys(BILLING_SOURCES).sort().join(', ')} — other providers are reported as unsupported.`,
        );
        return;
      }
      targets = [requested];
    } else {
      targets = Object.keys(providers).filter((id) => apiKeyOf(id) !== undefined);
    }

    if (targets.length === 0) {
      logger.info(
        'No provider with a key is configured — set DEEPSEEK_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (or add providers.<id>.apiKey) and run this again.',
      );
      return;
    }

    const until = Date.now();
    const since = until - days * DAY_MS;
    const statements: ProviderStatement[] = [];
    for (const provider of targets) {
      const id = provider.trim().toLowerCase();
      const key = apiKeyOf(id);
      if (!key) {
        // `--provider` on a provider with no key: say so instead of skipping it.
        statements.push({
          provider: id,
          label: providerLabel(id),
          status: 'error',
          kind: hasBillingSource(id) ? BILLING_SOURCES[id]!.kind : 'spend',
          scope: hasBillingSource(id) ? BILLING_SOURCES[id]!.scope : 'snapshot',
          details: [],
          error: 'no API key is configured for this provider',
          fetchedAt: until,
        });
        continue;
      }
      statements.push(
        await fetchProviderStatement({
          provider: id,
          apiKey: key,
          ...(providers[id]?.baseUrl ? { baseUrl: providers[id]!.baseUrl } : {}),
          since,
          until,
        }),
      );
    }

    if (options.json) {
      console.log(JSON.stringify({ statements, fetchedAt: until, windowDays: days }, null, 2));
      return;
    }

    console.log(`\n${formatStatements(statements, until)}`);
  }

  /**
   * `stats cost reprice` — the explicit repair of the rows already on disk.
   *
   * Dry run by default: the ledger is the user's billing history, and a reprice
   * changes every legacy figure in it. `--apply` writes once, after taking a
   * backup, and the report says exactly what changed either way.
   */
  private repriceLedger(options: RepriceOptions): void {
    const report = maintainCostLedger({
      ...(options.file ? { file: options.file } : {}),
      apply: options.apply === true,
      pruneTestRows: options.keepTestRows !== true,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`\n${formatMaintenanceReport(report)}`);
    if (report.applied) {
      logger.success(
        `Ledger re-priced: ${report.rows.repriced} row(s) repaired, ${report.rows.testOriginRemoved + report.rows.fixtureRemoved} test row(s) removed.`,
      );
      // A reprice rewrites the stored figures; anything cached for classification
      // in this process is now stale by definition.
      resetPricingContextCache();
    } else if (report.rows.repriced + report.rows.testOriginRemoved + report.rows.fixtureRemoved > 0) {
      logger.info('  Re-run with --apply to write (a .bak is kept beside the ledger).');
    }
  }

  private showHistoryStats(): void {
    const history = getChatHistory();
    const total = history.count();
    const recent = history.getRecentSessions(7);

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  📝  Conversation History');
    logger.highlight(`${'═'.repeat(60)}`);

    console.log(`\n  Total sessions: ${total}`);
    console.log(`  Recent (7 days): ${recent.length}`);

    if (recent.length > 0) {
      console.log(`\n  Recent sessions:`);
      for (const session of recent.slice(0, 10)) {
        console.log(history.formatSessionSummary(session));
      }
    }

    console.log('');
  }

  private showAllStats(): void {
    this.showHistoryStats();

    const tracker = getCostTracker();
    const summary = tracker.getSummary();

    if (summary.totalRequests > 0) {
      console.log(`\n${tracker.formatSummary()}`);
    } else {
      logger.info('No cost data yet. Start using providers to track costs.');
    }
  }
}

/**
 * Parse a currency amount the way a user copies it off a dashboard: `$12.34`,
 * `1,234.56`, ` 12.34 `. Returns null when it is not a non-negative finite
 * number — a reconciled figure is money, and "NaN" must never reach a report.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1e6) / 1e6;
}
