/**
 * C3 — `nuvira nlu debug "<query>"`.
 *
 * Explainability surface for the NLU layer: shows the deterministic rule path
 * (intent, confidence, mode, action, entities, temporal refs, router
 * task-intent, menu-unreachable gate) and — with `--llm` when the rule path is
 * below the trust threshold — the LLM verify path (mirrors runDeveloperMode's
 * cheap-model resolution so the verify call uses a real, working model).
 */

import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { RULE_TRUST_THRESHOLD } from '../nlu/intent.js';
import { parseRequestSync, parseRequest } from '../nlu/parser.js';
import { shouldAutoDispatch, taskTypeForIntent } from '../nlu/actions.js';
import { explainAskKind } from '../nlu/conversation-gate.js';
import { listLearnings, removeLearning } from '../nlu/learnings.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import type { LLMCallFn } from '../agents/agent.js';

export class NluCommand extends BaseCommand {
  create(): Command {
    const command = new Command('nlu')
      .description('NLU request understanding — debug intent/entity/action resolution')
      .addCommand(
        new Command('debug')
          .description('Debug how a request is understood (rule path + optional LLM verify)')
          .argument('<query>', 'The request text to analyze')
          .option('--llm', 'Run the LLM verify path when the rule path is below the trust threshold')
          .action(async (query: string, options?: { llm?: boolean }) => {
            await this.execute(query, options || {});
          }),
      )
      .addCommand(
        new Command('learnings')
          .description(
            'Show the routing corrections learned from CONFIRMED misreadings (the agent improving itself)',
          )
          .option('--forget <id>', 'Remove one learning — routing returns to the deterministic rules for that ask')
          .option('--json', 'Print the raw store (for scripts)')
          .action(async (options?: { forget?: string; json?: boolean }) => {
            this.learnings(options || {});
          }),
      );

    return command;
  }

  /**
   * The learned corrections, and how to forget one.
   *
   * Inspectability is the point: a rule that overrides the deterministic NLU
   * must be visible and removable, or a bad learning would silently misroute
   * every future instance of an ask with no way back.
   */
  private learnings(options: { forget?: string; json?: boolean }): void {
    if (options.forget) {
      const id = options.forget.trim();
      if (removeLearning(id)) {
        logger.success(`\n🗑️  Forgot ${id} — that ask routes by the deterministic rules again.`);
      } else {
        logger.warn(`\nNo learning with id ${id}. Run \`nuvira nlu learnings\` to list them.`);
      }
      return;
    }

    const stored = listLearnings();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(stored, null, 2)}\n`);
      return;
    }
    if (stored.length === 0) {
      logger.info('\n🧠 No NLU learnings yet — routing is fully rule-driven.');
      return;
    }

    logger.highlight(`\n🧠 ${stored.length} learned routing correction(s)`);
    logger.info('A learning is written only when a repeatedly-failing ask is CONFIRMED to have been read wrong.');
    for (const l of stored) {
      logger.info('');
      logger.info(`  ${l.id}   ${l.from} → ${l.to}   applied ${l.hits}×`);
      logger.info(`     ask : "${l.example.slice(0, 100)}"`);
      if (l.reason) logger.info(`     why : ${l.reason}`);
      logger.info(`     when: ${new Date(l.recordedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    }
    logger.info('\nForget one: nuvira nlu learnings --forget <id>');
  }

  private async execute(query: string, options: { llm?: boolean }): Promise<void> {
    // ── Deterministic rule path (always shown, zero network) ───────────────
    const parsed = parseRequestSync(query);
    logger.highlight(`\n🧠 NLU analysis: "${query}"`);
    logger.info(`Rule path   : intent=${parsed.intent} confidence=${parsed.confidence.toFixed(2)}`);
    logger.info(`             mode=${parsed.mode} action=${parsed.action.name} (${parsed.action.run})`);
    logger.info(`Entities    : files=[${parsed.entities.files?.join(', ') || 'none'}] frameworks=[${parsed.entities.frameworks?.join(', ') || 'none'}]`);
    if (parsed.entities.timeRange) {
      const t = parsed.entities.timeRange;
      logger.info(`Temporal    : "${t.text}" → ${t.start ?? ''}${t.end ? ` → ${t.end}` : ''}`);
    }
    logger.info(`Router seed : task-intent=${taskTypeForIntent(parsed.intent)}`);
    logger.info(`Dispatch    : auto-dispatch (no menu) = ${shouldAutoDispatch(parsed.intent, parsed.confidence)}`);
    // The SHARED chat-vs-pipeline verdict every surface uses, plus any learned
    // correction that overrode the rules for this exact ask. An override a user
    // cannot see is worse than no override at all.
    const verdict = explainAskKind(query, parsed);
    logger.info(`Route       : ${verdict.kind}${verdict.learning ? `  (LEARNED override — ${verdict.learning.from} → ${verdict.learning.to})` : `  (rules; would be ${verdict.base})`}`);
    if (verdict.learning) {
      logger.info(`             id=${verdict.learning.id} applied=${verdict.learning.hits}×${verdict.learning.reason ? ` why="${verdict.learning.reason}"` : ''}`);
      logger.info('             forget it: nuvira nlu learnings --forget ' + verdict.learning.id);
    }

    if (!options.llm || parsed.confidence >= RULE_TRUST_THRESHOLD) {
      if (parsed.confidence >= RULE_TRUST_THRESHOLD) {
        logger.info('LLM verify  : skipped (rule path is trusted)');
      } else {
        logger.info('Hint: add --llm to run the LLM verify path below the threshold.');
      }
      return;
    }

    // ── LLM verify path (cheap model via the auto-router, mirrors chat) ────
    try {
      const decision = getAutoRouter().resolve(
        'nlu',
        query,
        { verbose: false, useRuntimeStats: true },
        this.configManager,
      );
      const resolved = resolveProvider(this.configManager, decision.provider);
      const model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
      const callLLM: LLMCallFn = (prompt, opts) => resolved.provider.generate(prompt, { ...opts, model });
      const verified = await parseRequest(query, callLLM, process.cwd());
      logger.info(`LLM verify  : intent=${verified.intent} confidence=${verified.confidence.toFixed(2)} source=${verified.source}`);
      logger.info(`             action=${verified.action.name} (mode=${verified.mode}) router-seed=${taskTypeForIntent(verified.intent)}`);
      if (verified.memoryHint) logger.info(`Memory hint : ${verified.memoryHint}`);
      if (verified.source === 'rule-fallback') {
        logger.warn('             verify call failed/unparseable — rule result stands (never a guess).');
      }
    } catch (err) {
      logger.warn(`LLM verify unavailable (${err instanceof Error ? err.message : String(err)}) — rule result stands.`);
    }
  }
}
