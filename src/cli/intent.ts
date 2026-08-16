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
import { semanticResolve, type SemanticMatch } from '../commands/semantic-intent.js';
import { maskSenderId } from '../utils/mask.js';
import { runIntentEval } from '../learning/intent-eval.js';

export class IntentCommand {
  create(): Command {
    const cmd = new Command('intent')
      .description('Plain-English → CLI routing — resolve an ask into the exact `buff` command(s) to run');

    cmd
      .command('resolve')
      .description('Resolve a plain-English ask (e.g. "stop the dashboard", "add Rahul to whatsapp") into CLI commands')
      .argument('<ask...>', 'The plain-English ask')
      .option('-j, --json', 'Emit the matches as JSON (machine-readable)')
      .option('-s, --semantic', 'Also rank via embedding similarity (side-by-side vs deterministic) — no FAISS required')
      .action((ask: string[], opts: { json?: boolean; semantic?: boolean }) => {
        void this.resolve(ask.join(' '), opts);
      });

    cmd
      .command('eval')
      .description('Score deterministic vs semantic matching over a labeled ask corpus (novel phrasings included)')
      .option('-j, --json', 'Emit the eval results as JSON (machine-readable)')
      .action((opts: { json?: boolean }) => {
        void runIntentEval(opts).catch((err) => {
          logger.error(`Intent eval failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });

    return cmd;
  }

  private async resolve(ask: string, opts: { json?: boolean; semantic?: boolean }): Promise<void> {
    const matches = resolveAsk(ask);

    let semantic: SemanticMatch[] = [];
    if (opts.semantic) {
      try {
        semantic = await semanticResolve(ask);
      } catch (err) {
        logger.warn(`  semantic tier unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ ask, matches, semantic }, null, 2));
      return;
    }

    logger.highlight(`\n🧭 Intent resolution: "${ask}"`);
    if (matches.length === 0) {
      logger.warn('No matching intent in the deterministic tier — try rephrasing, or check docs/COMMANDS.md.');
      logger.info('Examples: "stop the dashboard", "start the gateway", "add Rahul to whatsapp",');
      logger.info('          "run the eval suite", "send a message to ops".');
      if (semantic.length === 0 && !opts.semantic) return;
    } else {
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

    if (opts.semantic) {
      logger.highlight('\n🧠 Semantic tier (embedding similarity, no FAISS):');
      if (semantic.length === 0) {
        logger.warn('  No semantic match above the similarity floor — the deterministic tier is the only signal.');
      } else {
        for (const m of semantic) {
          logger.info(`  intent: ${m.intent} (similarity ${m.similarity.toFixed(3)}) — matched alias "${m.matchedAlias}"`);
          if (m.command) logger.info(`  command: ${m.command}`);
          logger.info('');
        }
        const detTop = matches[0];
        if (detTop && semantic[0] && detTop.intent !== semantic[0].intent) {
          logger.warn(`  ⚖ disagreement: deterministic → ${detTop.intent}, semantic → ${semantic[0].intent}`);
        } else if (detTop && semantic[0]) {
          logger.info('  ✓ agreement: both tiers point at the same intent.');
        }
      }
    }
  }
}
