/**
 * Interactive weak-model decision prompt for the orchestrator
 * (routing.promptOnWeakModel).
 *
 * When a task can only run on a WEAK model (model escalation is a no-op —
 * every stronger candidate is unavailable/blocked, e.g. only a small local
 * model is configured), the orchestrator ASKS before committing to that path
 * (ask-first by default — never a silent weak model). An explicit
 * `routing.promptOnWeakModel: false` (or `weakModelPolicy: 'auto-allow'`)
 * restores the silent weak-model continuation. The ask fires ONCE per pipeline
 * and only on an interactive TTY:
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

// ─── Types ──────────────────────────────────────────────────────────────────

/** The config shape we read (only the routing sub-section). */
export interface WeakModelPromptConfig {
  routing?: { promptOnWeakModel?: boolean; weakModelPolicy?: unknown };
}

/** What the user chose when a task can only run on a weak model. */
export type WeakModelChoice = 'continue' | 'wait' | 'abort';

// ─── Gate ───────────────────────────────────────────────────────────────────

/**
 * Whether the orchestrator should ASK what to do when only a weak model is
 * available.
 *
 * ASK-FIRST BY DEFAULT (the user's requirement: never a silent weak model).
 * An explicit `routing.promptOnWeakModel: false` remains the opt-out, and
 * `weakModelPolicy: 'auto-allow'` (the non-interactive fallback) also opts out
 * so an unattended deployment is not forced to prompt. Any other value —
 * including unset — asks.
 *
 * NOTE: the caller only reaches the prompt on an interactive TTY
 * (`process.stdin.isTTY`), so a piped/CI/headless run is never blocked.
 */
export function shouldPromptWeakModel(config: WeakModelPromptConfig): boolean {
  const r = config.routing;
  if (!r) return true;
  if (r.promptOnWeakModel === false) return false;
  if (r.promptOnWeakModel === true) return true;
  const policy = String(r.weakModelPolicy ?? '').trim().toLowerCase();
  return policy !== 'auto-allow';
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
export async function promptWeakModelChoice(
  weakModelLabel: string,
  opts: { waitAvailable: boolean },
): Promise<WeakModelChoice> {
  console.log('');
  logger.warn(
    `   ⚠️ Only a weak model is available (${weakModelLabel}) — it can give guidance ` +
      'but may not reliably deliver this task.',
  );
  console.log('');

  const choices: Array<{ name: string; value: WeakModelChoice }> = [
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

  const answer = await inquirer.prompt<{ action: WeakModelChoice }>([
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
