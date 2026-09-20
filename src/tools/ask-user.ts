/**
 * E3b — `ask_user` renderer.
 *
 * The clarify tool shows a question + ≤4 choices and renders
 * arrow-key/checkbox selection in the CLI. We mirror that exactly with
 * inquirer: single-select = arrow-key list, multi_select = checkbox.
 * Injectable via ToolContext.askUser so tests never touch a real TTY.
 */

import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import type { AskUserAnswer, AskUserChoice } from './registry.js';

/**
 * Render an in-loop clarification.
 *
 * NON-INTERACTIVE SAFETY: with no TTY there is nobody to press a key, and
 * inquirer renders its arrow-key list and then blocks on stdin forever. Verified
 * live — a scripted run reached this tool on step 4 and hung until it was killed,
 * which is indistinguishable from "the agent is stuck". Any piped/CI/headless
 * run (and the dashboard, which injects its own renderer for the same reason)
 * must resolve instead of block, so the model can act on an answer.
 *
 * Mirrors the gateway's rule in `GatewayRegistry.handleInbound`: pick the first
 * choice as a best-effort default, and say plainly that no human was reached so
 * the model proceeds rather than asking the same thing again.
 */
export async function renderAskUser(
  question: string,
  choices: AskUserChoice[],
  multiSelect: boolean,
): Promise<AskUserAnswer> {
  console.log('');
  logger.highlight(`💬 ${question}`);

  if (!process.stdin.isTTY) {
    const fallback = choices[0]?.label ?? 'skip';
    logger.info(`↩ no interactive user attached — defaulting to "${fallback}" and continuing`);
    console.log('');
    return {
      answer: multiSelect ? [fallback] : fallback,
      index: multiSelect ? [0] : 0,
      custom:
        'no interactive user is attached to this session (piped or headless run) — ' +
        'do not ask again; proceed with your best judgement and state the assumption you made',
    };
  }

  const prompt = multiSelect
    ? {
        type: 'checkbox' as const,
        name: 'answer',
        message: 'Select all that apply (space to toggle, Enter to confirm):',
        prefix: '🔀',
        choices: choices.map((c) => ({ name: c.label, value: c.label })),
        pageSize: 8,
      }
    : {
        type: 'list' as const,
        name: 'answer',
        message: 'Choose one:',
        prefix: '🔀',
        choices: choices.map((c) => ({
          name: c.description ? `${c.label} — ${c.description}` : c.label,
          value: c.label,
        })),
        pageSize: 8,
      };

  const { answer } = await inquirer.prompt<{ answer: string | string[] }>(prompt);

  console.log('');
  const labels = Array.isArray(answer) ? answer : [answer];
  const indices = labels.map((label) => choices.findIndex((c) => c.label === label));
  return {
    answer,
    index: multiSelect ? indices : indices[0] ?? -1,
  };
}
