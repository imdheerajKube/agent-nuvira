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
import { getAutoRouter } from '../learning/auto-router.js';
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
export class NluCommand extends BaseCommand {
    create() {
        const command = new Command('nlu')
            .description('NLU request understanding — debug intent/entity/action resolution')
            .addCommand(new Command('debug')
            .description('Debug how a request is understood (rule path + optional LLM verify)')
            .argument('<query>', 'The request text to analyze')
            .option('--llm', 'Run the LLM verify path when the rule path is below the trust threshold')
            .action(async (query, options) => {
            await this.execute(query, options || {});
        }));
        return command;
    }
    async execute(query, options) {
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
        if (!options.llm || parsed.confidence >= RULE_TRUST_THRESHOLD) {
            if (parsed.confidence >= RULE_TRUST_THRESHOLD) {
                logger.info('LLM verify  : skipped (rule path is trusted)');
            }
            else {
                logger.info('Hint: add --llm to run the LLM verify path below the threshold.');
            }
            return;
        }
        // ── LLM verify path (cheap model via the auto-router, mirrors chat) ────
        try {
            const decision = getAutoRouter().resolve('nlu', query, { verbose: false, useRuntimeStats: true }, this.configManager);
            const resolved = resolveProvider(this.configManager, decision.provider);
            const model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
            const callLLM = (prompt, opts) => resolved.provider.generate(prompt, { ...opts, model });
            const verified = await parseRequest(query, callLLM, process.cwd());
            logger.info(`LLM verify  : intent=${verified.intent} confidence=${verified.confidence.toFixed(2)} source=${verified.source}`);
            logger.info(`             action=${verified.action.name} (mode=${verified.mode}) router-seed=${taskTypeForIntent(verified.intent)}`);
            if (verified.memoryHint)
                logger.info(`Memory hint : ${verified.memoryHint}`);
            if (verified.source === 'rule-fallback') {
                logger.warn('             verify call failed/unparseable — rule result stands (never a guess).');
            }
        }
        catch (err) {
            logger.warn(`LLM verify unavailable (${err instanceof Error ? err.message : String(err)}) — rule result stands.`);
        }
    }
}
//# sourceMappingURL=nlu.js.map