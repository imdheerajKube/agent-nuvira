/**
 * `nuvira decisions` — the project's recorded must-ask decisions.
 *
 * WHEN the agent cannot proceed without the user's choice, `ask_user` shows a
 * question and the answer lands in `.nuvira/decisions.jsonl` (+ a readable
 * `DECISIONS.md`). This command is how that record is READ BACK and REVISED: list
 * what was decided, find the decisions relevant to an ask, and change one — with
 * the history kept, so a decision that changed is documented rather than lost.
 *
 *   nuvira decisions                        — every recorded decision (newest last)
 *   nuvira decisions --for "database"       — decisions relevant to an ask
 *   nuvira decisions show <id>              — the full record, incl. history
 *   nuvira decisions revise <id> --answer "…" [--note "…"]
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { resolve } from 'node:path';
import {
  readDecisions,
  recallDecisions,
  reviseDecision,
  formatDecisionSummaries,
  decisionsDocPath,
  decisionLogPath,
  type DecisionRecord,
} from '../learning/decision-log.js';

export class DecisionsCommand {
  create(): Command {
    const cmd = new Command('decisions')
      .description(
        'The must-ask decisions recorded for this project — list, search, and revise them (written by ask_user)',
      )
      // NO short flag: the root program already owns `-d` (`--debug`), and
      // commander lets the outer option swallow it — a `-d` here would silently
      // resolve to the wrong directory. `--dir` is unambiguous.
      .option('--dir <path>', 'project directory (default: the current directory)')
      .option('--for <text>', 'show decisions relevant to an ask instead of all of them')
      .option('--limit <n>', 'with --for: how many relevant decisions to show (default 5)')
      .option('--json', 'print the raw records as JSON')
      .action((opts: { dir?: string; for?: string; limit?: string; json?: boolean }) => {
        this.list(opts);
      });

    // NOTE: `--dir` lives on the PARENT only. Commander parses a parent's options
    // even when they follow a subcommand, so a `-d` declared on both would be
    // swallowed by the parent and the child would silently read `undefined`.
    cmd
      .command('show')
      .argument('<id>', 'the decision id (see the list)')
      .option('--json', 'print the record as JSON')
      .action((id: string, opts: { json?: boolean }, command: Command) => {
        this.show(id, this.parentDir(command), Boolean(opts.json));
      });

    cmd
      .command('revise')
      .argument('<id>', 'the decision id')
      .requiredOption('-a, --answer <text>', 'the new answer')
      .option('-n, --note <text>', 'why it changed (kept in the history)')
      .action((id: string, opts: { answer: string; note?: string }, command: Command) => {
        this.revise(id, this.parentDir(command), opts.answer, opts.note);
      });

    return cmd;
  }

  private dirOf(dir?: string): string {
    return resolve(dir || process.cwd());
  }

  /** The `--dir` value declared on the PARENT command (see the note in `create`). */
  private parentDir(command: Command): string {
    const dir = (command.parent?.opts() as { dir?: string } | undefined)?.dir;
    return this.dirOf(dir);
  }

  private list(opts: { dir?: string; for?: string; limit?: string; json?: boolean }): void {
    const dir = this.dirOf(opts.dir);
    if (opts.for) {
      const limit = Math.max(1, Math.min(50, Number(opts.limit) || 5));
      const rows = recallDecisions(dir, opts.for, limit);
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      logger.highlight(`\n🧭 Decisions relevant to: ${opts.for}`);
      if (rows.length === 0) {
        logger.info('   None recorded for this project — nothing to refer back to.');
        console.log('');
        return;
      }
      for (const line of formatDecisionSummaries(rows)) console.log(`   ${line}`);
      logger.info(`   Full record: ${decisionsDocPath(dir)}`);
      console.log('');
      return;
    }

    const rows = readDecisions(dir);
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    logger.highlight(`\n🧭 Decisions recorded for ${dir}`);
    if (rows.length === 0) {
      logger.info('   None yet — a decision is recorded when the agent has to ask you one.');
      console.log('');
      return;
    }
    for (const line of formatDecisionSummaries(rows)) console.log(`   ${line}`);
    logger.info(`   ${rows.length} decision(s) · store: ${decisionLogPath(dir)}`);
    logger.info(`   Readable copy: ${decisionsDocPath(dir)}`);
    logger.info('   Change one with: nuvira decisions revise <id> --answer "…"');
    console.log('');
  }

  private show(id: string, dir: string, json: boolean): void {
    const record = readDecisions(dir).find((r) => r.id === id);
    if (!record) {
      logger.error(`No decision with id ${id} in ${dir}`);
      process.exitCode = 1;
      return;
    }
    if (json) {
      process.stdout.write(JSON.stringify(record, null, 2) + '\n');
      return;
    }
    logger.highlight('\n🧭 Decision');
    console.log(`   ${record.question}`);
    console.log(`   answer:   ${record.answer || '(none)'}`);
    if (record.choices && record.choices.length > 0) {
      console.log(`   offered:  ${record.choices.join(' | ')}`);
    }
    console.log(`   recorded: ${new Date(record.at).toLocaleString()} · ${record.source}`);
    console.log(`   status:   ${record.status}`);
    if (record.revisions && record.revisions.length > 0) {
      console.log('   history:');
      for (const rev of record.revisions) {
        console.log(
          `     ${new Date(rev.at).toLocaleString()} → ${rev.answer || '(none)'}${rev.note ? ` — ${rev.note}` : ''}`,
        );
      }
    }
    console.log('');
  }

  private revise(id: string, dir: string, answer: string, note?: string): void {
    const revised = reviseDecision(dir, id, answer, note);
    if (!revised) {
      logger.error(`Could not revise ${id} — no such decision in ${dir}.`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Revised ${id}: ${revised.answer}`);
    logger.info(`   The previous answer is kept in the history (${revised.revisions?.length ?? 1}).`);
    logger.info(`   Updated: ${decisionsDocPath(dir)}`);
    console.log('');
  }
}

/** Exported for tests: the shape a caller reads back. */
export type { DecisionRecord };
