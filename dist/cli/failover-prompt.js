/**
 * Interactive failover confirmation for Auto mode (routing.promptOnFailover).
 *
 * By default Auto mode fails over SILENTLY: when a provider dies mid-session
 * (expired key, exhausted quota, deprecated model), the next-ranked candidate
 * answers automatically and the user never gets stuck. When the user opts into
 * `routing.promptOnFailover: true`, the CLI instead asks BEFORE the switch:
 *
 *   🔄 provider failed — auto routing suggests next-provider (model)
 *   How would you like to proceed?
 *     🔄 Switch to next-provider (model) — recommended
 *     🎯 Let me pick a provider myself
 *
 * This module is deliberately small and dependency-light so it can be unit
 * tested in isolation (inquirer mocked) and reused by any auto-mode caller.
 */
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
// ─── Gate ───────────────────────────────────────────────────────────────────
/**
 * Whether Auto mode should ASK before failing over. Reads
 * `routing.promptOnFailover` (default false — silent auto-failover).
 */
export function shouldConfirmFailover(config) {
    return config.routing?.promptOnFailover === true;
}
// ─── Prompt ─────────────────────────────────────────────────────────────────
/**
 * Ask the user how to handle a mid-session auto-mode failover.
 *
 * @param failedProviderName Human name of the provider that just failed
 * @param nextProviderName   Human name of the next-ranked candidate
 * @param nextModel          The candidate's model
 * @returns 'switch' to adopt the next candidate, 'manual' to fall through to
 *          the standard interactive recovery (model picker etc.)
 */
export async function promptFailoverChoice(failedProviderName, nextProviderName, nextModel) {
    console.log('');
    logger.warn(`   ⚠️ ${failedProviderName} failed — auto routing suggests ${nextProviderName} (${nextModel})`);
    console.log('');
    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Auto-mode failover — how would you like to proceed?',
            prefix: '🔄',
            choices: [
                { name: `🔄  Switch to ${nextProviderName} (${nextModel}) — recommended`, value: 'switch' },
                { name: '🎯  Let me pick a provider myself', value: 'manual' },
            ],
        },
    ]);
    console.log('');
    return answer.action === 'manual' ? 'manual' : 'switch';
}
//# sourceMappingURL=failover-prompt.js.map