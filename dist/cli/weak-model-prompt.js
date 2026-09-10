/**
 * Interactive weak-model decision prompt for the orchestrator
 * (routing.promptOnWeakModel).
 *
 * When a task can only run on a WEAK model (model escalation is a no-op —
 * every stronger candidate is unavailable/blocked, e.g. only a small local
 * model is configured), the default behavior is SILENT: the pipeline
 * continues on the weak model with lenient parsing and a bounded repair
 * budget (never stuck, but the deliverable may be recommendations rather
 * than reliable code). When the user opts into `routing.promptOnWeakModel:
 * true`, the orchestrator instead asks BEFORE committing to that path:
 *
 *   ⚠️ Only a weak model is available (local/gemma4:e4b)
 *   ? How would you like to proceed?
 *     ▶ Continue on the weak model — recommended if you just want its best
 *       effort (may be guidance, not a reliable deliverable)
 *     ⏳ Wait and retry when a stronger model is back (shown only when a
 *        stronger candidate is in a short cooldown)
 *     ⛔ Abort — I'll fix the provider config (add a key / wait out quota)
 *
 * This module is deliberately small and dependency-light so it can be unit
 * tested in isolation (inquirer mocked) and reused by any auto-mode caller.
 */
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
// ─── Gate ───────────────────────────────────────────────────────────────────
/**
 * Whether the orchestrator should ASK what to do when only a weak model is
 * available. Reads `routing.promptOnWeakModel` (default false — silent
 * weak-model continuation).
 */
export function shouldPromptWeakModel(config) {
    return config.routing?.promptOnWeakModel === true;
}
// ─── Prompt ─────────────────────────────────────────────────────────────────
/**
 * Ask the user how to handle a task that can only run on a weak model.
 *
 * @param weakModelLabel Human label of the weak model (e.g. "local/gemma4:e4b")
 * @param opts.waitAvailable When a stronger candidate is in a short cooldown,
 *        offer the "wait and retry" option (an honest wait — otherwise the
 *        only real choices are continue or abort).
 * @returns 'continue' to proceed on the weak model, 'wait' to stop and retry
 *          when a stronger model is back, 'abort' to stop the pipeline.
 */
export async function promptWeakModelChoice(weakModelLabel, opts) {
    console.log('');
    logger.warn(`   ⚠️ Only a weak model is available (${weakModelLabel}) — it can give guidance ` +
        'but may not reliably deliver this task.');
    console.log('');
    const choices = [
        {
            name: '▶  Continue on the weak model — use its best effort (may be recommendations, not a reliable deliverable)',
            value: 'continue',
        },
    ];
    if (opts.waitAvailable) {
        choices.push({
            name: '⏳  Wait and retry when a stronger model is back',
            value: 'wait',
        });
    }
    choices.push({
        name: '⛔  Abort — I will fix the provider config (add a key / wait out the quota)',
        value: 'abort',
    });
    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Only a weak model is available — how would you like to proceed?',
            prefix: '⚠️',
            choices,
        },
    ]);
    console.log('');
    return answer.action;
}
//# sourceMappingURL=weak-model-prompt.js.map