/**
 * `buff intent resolve "<ask>"` — plain-English → CLI routing.
 *
 * The user-facing half of the intent router (src/commands/intent-router.ts):
 * type "stop the dashboard", "add Rahul's mobile +919958604222 to whatsapp",
 * "start the gateway", "run the eval suite" and see exactly which `buff`
 * command the agent would execute — including a clarifying question when the
 * ask is ambiguous (verified list vs send-by-name mapping, …).
 *
 * This is the reference surface for the docs/COMMANDS.md §15 design: the same
 * resolver is what the agent itself should call before running any command.
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { resolveAsk } from '../commands/intent-router.js';
import { maskSenderId } from '../utils/mask.js';

export class IntentCommand {
  create(): Command {
    const cmd = new Command('intent')
      .description('Plain-English → CLI routing — resolve an ask into the exact `buff` command(s) to run');

    cmd
      .command('resolve')
      .description('Resolve a plain-English ask (e.g. "stop the dashboard", "add Rahul to whatsapp") into CLI commands')
      .argument('<ask...>', 'The plain-English ask')
      .option('-j, --json', 'Emit the matches as JSON (machine-readable)')
      .action((ask: string[], opts: { json?: boolean }) => this.resolve(ask.join(' '), opts));

    return cmd;
  }

  private resolve(ask: string, opts: { json?: boolean }): void {
    const matches = resolveAsk(ask);

    if (opts.json) {
      console.log(JSON.stringify({ ask, matches }, null, 2));
      return;
    }

    logger.highlight(`\n🧭 Intent resolution: "${ask}"`);
    if (matches.length === 0) {
      logger.warn('No matching intent — try rephrasing, or check docs/COMMANDS.md.');
      logger.info('Examples: "stop the dashboard", "start the gateway", "add Rahul to whatsapp",');
      logger.info('          "run the eval suite", "send a message to ops".');
      return;
    }

    for (const m of matches.slice(0, 3)) {
      logger.info(`  intent: ${m.intent} (score ${m.score.toFixed(2)})${m.matchedAlias ? ` — matched "${m.matchedAlias}"` : ''}`);
      if (m.ambiguous) {
        logger.warn('  ⚠ AMBIGUOUS — ask the user which they mean:');
        for (const opt of m.options ?? []) {
          logger.info(`    • ${opt.summary}`);
          logger.info(`      → ${opt.command}`);
        }
      } else {
        logger.info(`  command: ${m.command}`);
        if (m.example) logger.info(`  example: ${m.example}`);
      }
      const entities = Object.entries(m.entities).filter(([, v]) => v.length > 0);
      if (entities.length > 0) {
        const pretty = entities
          .map(([k, v]) => `${k}=[${v.map((x) => (k === 'phone' || k === 'target' ? maskSenderId(x) : x)).join(', ')}]`)
          .join(' ');
        logger.info(`  entities: ${pretty}`);
      }
      logger.info('');
    }
  }
}
