/**
 * E3b — `ask_user` renderer (Hermes `tools/clarify_tool.py` parity).
 *
 * Hermes' clarify tool shows a question + ≤4 choices and renders
 * arrow-key/checkbox selection in the CLI. We mirror that exactly with
 * inquirer: single-select = arrow-key list, multi_select = checkbox.
 * Injectable via ToolContext.askUser so tests never touch a real TTY.
 */

import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import type { AskUserAnswer, AskUserChoice } from './registry.js';

/** Render an in-loop clarification (Hermes clarify parity). */
export async function renderAskUser(
  question: string,
  choices: AskUserChoice[],
  multiSelect: boolean,
): Promise<AskUserAnswer> {
  console.log('');
  logger.highlight(`💬 ${question}`);

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
