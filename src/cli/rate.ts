/**
 * Rate command — `nuvira rate <good|bad>` — the USER's verdict on a turn.
 *
 * WHY A COMMAND FOR THIS. Every other honesty signal in nuvira is DERIVED from
 * what the run did; acceptance is not, because only the user knows whether the
 * work was what they wanted. That makes it the single most valuable input the
 * harness cannot compute, and the only source of the POSITIVE label a quality
 * signal needs (the derived correction signal can only ever produce negatives).
 *
 * WHAT IT WRITES. The verdict lands on the turn's reasoning trace
 * (`userVerdict`, with its source) and, when that turn delivered an authored
 * artifact, labels the matching row in the deliverable corpus. Both are what a
 * measured `P(accepted | features)` would later be fit to.
 *
 * WHAT IT DOES NOT DO. Nothing routes on it, no score is derived from it, and
 * the corpus keeps `verdict: null` for a turn nobody rated — reading silence as
 * acceptance would manufacture the positive class instead of measuring it.
 *
 *   nuvira rate good                 — the most recent turn was what you wanted
 *   nuvira rate bad                  — it was not
 *   nuvira rate bad --trace <id>     — rate a specific turn (see `nuvira trace list`)
 *   nuvira rate --list               — recent verdicts
 *   nuvira rate --stats              — the corpus: labels, class balance, per-pair, fit status
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { parseVerdict, rateTurn, listTurnVerdicts, latestRateableTraceId } from '../learning/turn-feedback.js';
import { acceptanceSummary, formatAcceptanceSummary } from '../learning/acceptance-model.js';

export class RateCommand {
  create(): Command {
    return new Command('rate')
      .description(
        'Rate the last turn (good|bad) — records the one label a quality signal can be fit to (also on the dashboard Trace tab)',
      )
      .argument('[verdict]', 'good | bad (aliases: accepted | rejected)')
      .option('-t, --trace <id>', 'rate a specific trace instead of the most recent turn')
      .option('-l, --list', 'show recent verdicts instead of recording one')
      .option('-s, --stats', 'show the acceptance corpus: labels, class balance, per-pair record, fit status')
      .action((verdict: string | undefined, opts?: { trace?: string; list?: boolean; stats?: boolean }) => {
        this.run(verdict, opts ?? {});
      });
  }

  private run(verdict: string | undefined, opts: { trace?: string; list?: boolean; stats?: boolean }): void {
    if (opts.stats) {
      this.stats();
      return;
    }
    if (opts.list) {
      this.list();
      return;
    }
    const parsed = verdict ? parseVerdict(verdict) : null;
    if (!parsed) {
      logger.error('Usage: nuvira rate <good|bad>   (aliases: accepted | rejected)');
      const id = latestRateableTraceId();
      if (id) {
        logger.info(`   Most recent turn: ${id} — review it first with: nuvira trace show ${id}`);
      } else {
        logger.info('   No turns recorded yet — run a chat turn, then rate it.');
      }
      process.exitCode = 1;
      return;
    }

    const result = rateTurn({
      verdict: parsed,
      ...(opts.trace ? { traceId: opts.trace } : {}),
      source: 'cli',
    });
    if (!result.ok) {
      logger.error(result.error);
      process.exitCode = 1;
      return;
    }

    const rated = result.rated;
    logger.success(`${parsed === 'accepted' ? '👍 accepted' : '👎 rejected'} — ${rated.traceId}`);
    logger.info(`   ${rated.goal.slice(0, 100)}`);
    logger.info(
      rated.corpusLabeled
        ? '   Labelled the delivered artifact in the quality corpus (one row).'
        : '   No delivered artifact on this turn — the verdict is recorded on the trace.',
    );
    logger.info('   Recorded as MEASUREMENT only: nothing routes on it and no score is derived from it yet.');
    console.log('');
  }

  /**
   * The corpus at a glance: how many turns are labelled, the class balance, the
   * per-pair record, and whether the fit has enough to train. READ-ONLY — this is
   * the same data `model explain` prints, from the same `acceptanceSummary`, so the
   * two surfaces cannot describe the corpus differently.
   */
  private stats(): void {
    const lines = formatAcceptanceSummary(acceptanceSummary());
    logger.highlight('\n📊 Acceptance corpus');
    for (const line of lines) console.log(`   ${line}`);
    console.log('');
  }

  private list(): void {
    const rows = listTurnVerdicts(20);
    logger.highlight('\n⭐ Turn verdicts');
    if (rows.length === 0) {
      logger.info('   No verdicts recorded yet. Run `nuvira rate good` after a turn.');
      console.log('');
      return;
    }
    for (const r of rows) {
      console.log(
        `   ${r.verdict === 'accepted' ? '👍' : '👎'} ${r.traceId}  [${r.source}]  ${new Date(r.at).toLocaleString()}`,
      );
      console.log(`        ${r.goal.slice(0, 100)}`);
    }
    console.log('');
  }
}
