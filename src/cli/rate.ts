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
 * WHAT IT DOES. The verdict is stored on the trace (and the matching corpus row)
 * as the label a fitted quality model reads, AND — since Bundle 36 — a REJECTION
 * also corrects the ROUTER: it applies the deferred `userAccepted: false` delta to
 * the bandit arm that served the turn, exactly as the derived correction does, and
 * exactly once per trace (see `learning/verdict-routing.ts`). So a 👎 now changes
 * what the agent tries next, not merely what it records.
 *
 * WHAT IT DOES NOT DO. No score is derived from the label, the FITTED quality model
 * routes nothing, and the corpus keeps `verdict: null` for a turn nobody rated —
 * reading silence as acceptance would manufacture the positive class instead of
 * measuring it. An ACCEPTANCE moves no bandit arm: the turn was already recorded as
 * its own outcome, so a 👍 adds no new observation to routing.
 *
 *   nuvira rate good                 — the most recent turn was what you wanted
 *   nuvira rate bad                  — it was not (and the router arm is corrected)
 *   nuvira rate bad --trace <id>     — rate a specific turn (see `nuvira trace list`)
 *   nuvira rate --list               — recent verdicts
 *   nuvira rate --stats              — the corpus: labels, class balance, per-pair, fit status
 *   nuvira rate --explain <id>       — one trace: its features, its label, the fitted P(accepted)
 *   nuvira rate --export corpus.csv  — export the labelled corpus (JSON/CSV) for offline fitting
 *   nuvira rate --import corpus.json — merge an exported corpus back into the local store
 *   nuvira rate --merge corpus.json  — reconcile against local labels (--replace lets the import win)
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseVerdict, rateTurn, listTurnVerdicts, latestRateableTraceId } from '../learning/turn-feedback.js';
import {
  acceptanceSummary,
  formatAcceptanceSummary,
  collectLabelledTurns,
  serializeLabelledTurns,
  parseCorpusText,
  detectCorpusFormat,
  mergeImportedLabels,
  mergeLabelledCorpus,
  explainTraceLabel,
  ACCEPTANCE_FEATURES,
  type CorpusFormat,
} from '../learning/acceptance-model.js';

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
      .option('-e, --export [path]', 'export the labelled corpus (JSON, or CSV with --format csv / a .csv path); no path prints to stdout')
      .option('-i, --import <file>', 'merge an exported corpus (JSON or CSV) into the local labelled corpus')
      .option('-m, --merge <file>', 'reconcile an exported corpus against LOCAL labels (default: keep local on a conflict)')
      .option('--replace', 'with --merge: let the incoming label win on a conflict')
      .option('--explain <id>', 'explain one trace: its features, its label, and the fitted P(accepted)')
      .option('--format <format>', 'export format: json | csv (default: by path extension, else json)')
      .action(
        (
          verdict: string | undefined,
          opts?: {
            trace?: string;
            list?: boolean;
            stats?: boolean;
            export?: string | boolean;
            import?: string;
            merge?: string;
            replace?: boolean;
            format?: string;
            explain?: string;
          },
        ) => {
          this.run(verdict, opts ?? {});
        },
      );
  }

  private run(
    verdict: string | undefined,
    opts: {
      trace?: string;
      list?: boolean;
      stats?: boolean;
      export?: string | boolean;
      import?: string;
      merge?: string;
      replace?: boolean;
      format?: string;
      explain?: string;
    },
  ): void {
    if (opts.explain !== undefined) {
      this.explain(opts.explain);
      return;
    }
    if (opts.merge !== undefined) {
      this.mergeCorpus(opts.merge, Boolean(opts.replace));
      return;
    }
    if (opts.import !== undefined) {
      this.importCorpus(opts.import);
      return;
    }
    if (opts.export !== undefined) {
      this.export(opts.export, opts.format);
      return;
    }
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
    // Bundle 36 — the verdict also corrects the ROUTER. A rejection moves the
    // bandit arm that served the turn (once); print what actually happened rather
    // than implying a correction that did not land.
    const router = rated.router;
    if (router) {
      const where = router.provider
        ? ` (${router.provider}${router.model ? `/${router.model}` : ''} @ ${router.complexity})`
        : '';
      if (router.alreadyApplied) {
        logger.info(`   Router: this verdict was already applied${where} — the arm moved once, not twice.`);
      } else if (router.applied && router.moved > 0) {
        logger.info(`   Router: corrected ${router.moved} bandit prior(s)${where} — the rejected arm now samples lower.`);
      } else if (router.applied) {
        logger.info(`   Router: no recorded arm for this pair yet${where} — nothing to correct (a verdict never invents one).`);
      } else {
        logger.info(`   Router: not applied — ${router.reason}`);
      }
    }
    logger.info('   The fitted quality model still reads the label only; it routes nothing yet.');
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

  /**
   * Merge an exported corpus into the local store so labels collected elsewhere can
   * be joined. Deduped by trace (or identity): re-importing the same file is
   * idempotent. Imported rows carry their OWN features, so nothing is re-derived from
   * a local run that may not exist.
   */
  private importCorpus(file: string): void {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      logger.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const turns = parseCorpusText(text, detectCorpusFormat(file, text));
    if (turns.length === 0) {
      logger.error(`No labelled turns found in ${file} — is it an exported corpus (JSON or CSV)?`);
      process.exitCode = 1;
      return;
    }
    const { added, updated, total } = mergeImportedLabels(turns);
    logger.success(`Imported ${turns.length} row(s) from ${file}: ${added} new, ${updated} already present.`);
    logger.info(`   Imported store now holds ${total} labelled turn(s); they are read by the fit alongside your own.`);
    console.log('');
  }

  /**
   * Explain ONE trace (Bundle 36): its features, its label and the fitted
   * `P(accepted | features)` for it — so a single rating can be audited against the
   * exact evidence the model sees.
   */
  private explain(traceId: string): void {
    const e = explainTraceLabel(traceId);
    if (!e) {
      logger.error(`Trace not found: ${traceId}`);
      process.exitCode = 1;
      return;
    }
    logger.highlight('\n🔎 Acceptance explanation');
    console.log(`   ${e.traceId}${e.provider ? `  ${e.provider}/${e.model ?? ''}` : ''}`);
    console.log(`   ${e.goal.slice(0, 100)}`);
    console.log(`   verification ${e.verification ?? 'not-applicable'} · delivered ${e.delivered ? 'yes' : 'no'}`);
    console.log(`   flags: ${e.flags.length > 0 ? e.flags.join(', ') : 'none'}`);
    console.log(`   features: ${ACCEPTANCE_FEATURES.map((f) => `${f}=${e.features[f]}`).join('  ')}`);
    console.log(
      `   label: ${
        e.label === null ? 'unrated (silence is not acceptance)' : e.label ? '👍 accepted' : '👎 rejected'
      }${e.source ? ` [${e.source}]` : ''}`,
    );
    console.log(
      `   P(accepted | these features): ${
        e.probability === null ? 'n/a — the fit is not trained yet' : e.probability.toFixed(3)
      }`,
    );
    console.log('   (read-only: the fit routes nothing and derives no score)');
    console.log('');
  }

  /**
   * Reconcile an exported corpus against the LOCAL labels, explicitly (Bundle 35).
   * Unlike `--import` (a plain union), this REPORTS conflicts — a trace the local
   * record already labels differently — and by default keeps the local label, the
   * one this machine measured. `--replace` lets the incoming label win.
   */
  private mergeCorpus(file: string, replace: boolean): void {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      logger.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const rows = parseCorpusText(text, detectCorpusFormat(file, text));
    if (rows.length === 0) {
      logger.error(`No labelled turns found in ${file} — is it an exported corpus (JSON or CSV)?`);
      process.exitCode = 1;
      return;
    }
    const res = mergeLabelledCorpus(rows, { replace });
    logger.success(`Merged ${res.incoming} row(s) from ${file}.`);
    logger.info(`   ${res.stored} stored · ${res.conflicts} conflict(s) · ${res.matching} matching`);
    if (res.conflicts > 0) {
      logger.info(
        replace
          ? `   ${res.replaced} conflict(s) replaced with the incoming label.`
          : `   ${res.keptLocal} conflict(s) kept the LOCAL label — re-run with --replace to let the import win.`,
      );
    }
    logger.info(`   Imported store now holds ${res.total} labelled turn(s).`);
    console.log('');
  }

  /**
   * Ship the labelled corpus for offline fitting: the SAME rows a fit here would
   * read (`collectLabelledTurns`), so nothing is lost in the hand-off. JSON keeps the
   * full structure; CSV is the flat spreadsheet form. With no path, the text goes to
   * stdout so it can be piped.
   */
  private export(pathOrFlag: string | boolean, format: string | undefined): void {
    const path = typeof pathOrFlag === 'string' ? pathOrFlag : undefined;
    let fmt: CorpusFormat;
    if (format !== undefined) {
      const normalized = format.toLowerCase();
      if (normalized !== 'json' && normalized !== 'csv') {
        logger.error(`Unknown --format "${format}" — use json or csv.`);
        process.exitCode = 1;
        return;
      }
      fmt = normalized;
    } else {
      fmt = path && path.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
    }

    const rows = collectLabelledTurns();
    const text = serializeLabelledTurns(rows, fmt);
    if (!path) {
      process.stdout.write(text);
      return;
    }
    try {
      writeFileSync(path, text, 'utf-8');
    } catch (err) {
      logger.error(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Exported ${rows.length} labelled turn(s) to ${path} (${fmt}).`);
    if (rows.length === 0) {
      logger.info('   The corpus is empty — rate a turn (`nuvira rate good|bad`) and export again.');
    } else {
      logger.info('   These are the rows a fit reads here; ship the file to fit offline.');
    }
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
