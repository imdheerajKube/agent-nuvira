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
 * C1 — the label of the "type my own answer" choice appended to every ask_user
 * list. Exported so surfaces and tests agree on the exact wording.
 */
export const OTHER_CHOICE_LABEL = '✏️ Other — type my own answer';

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
    // PARITY WITH THE GATEWAY. A messaging channel with askUserWait OFF
    // replies with the QUESTION and says which option it is going with ("Going
    // with 1. X — reply to change it"), so the sender can correct it. A piped /
    // headless CLI run could not do even that: it picked choice 1, told the
    // MODEL to move on, and the question itself never reached the human — the
    // model's answer read as a decision the user never made (observed live:
    // "I have selected Python/Qt" after a silent default). Show the question
    // and the choices on the visible output, and make the disclosure part of
    // the model's ANSWER instead of an internal note it echoes verbatim.
    logger.highlight('  Choices:');
    choices.forEach((c, i) => {
      const mark = i === 0 ? '→' : ' ';
      logger.info(`   ${mark} ${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}`);
    });
    logger.info(`↩ no interactive user attached — proceeding with 1. "${fallback}" and continuing`);
    console.log('');
    return {
      answer: multiSelect ? [fallback] : fallback,
      index: multiSelect ? [0] : 0,
      custom:
        `Nobody was available to answer in this run, so "${fallback}" was assumed. ` +
        'Do NOT mention this internal note. Instead, in your written answer tell the user the question ' +
        `you would have asked and the assumption you made (e.g. "I assumed "${fallback}" — tell me ` +
        'if you would prefer something else"), then continue with that assumption.',
    };
  }

  // C1 — the model offers 2–4 choices, but the user's real answer is sometimes
  // none of them. Without this the only ways out were picking a wrong option or
  // Skip; the `custom` field was plumbed end-to-end (AskUserAnswer.custom →
  // registry → dashboard `chatRespond`) yet no surface ever let a human type one.
  const other: AskUserChoice = {
    label: OTHER_CHOICE_LABEL,
    description: 'type an answer that is not in the list',
  };

  const prompt = multiSelect
    ? {
        type: 'checkbox' as const,
        name: 'answer',
        message: 'Select all that apply (space to toggle, Enter to confirm):',
        prefix: '🔀',
        choices: [...choices, other].map((c) => ({ name: c.label, value: c.label })),
        pageSize: 8,
      }
    : {
        type: 'list' as const,
        name: 'answer',
        message: 'Choose one:',
        prefix: '🔀',
        choices: [...choices, other].map((c) => ({
          name: c.description ? `${c.label} — ${c.description}` : c.label,
          value: c.label,
        })),
        pageSize: 9,
      };

  const { answer } = await inquirer.prompt<{ answer: string | string[] }>(prompt);
  console.log('');

  // Single-select "Other": ask for the free text and return it as the answer.
  if (!multiSelect && answer === OTHER_CHOICE_LABEL) {
    const typed = await promptForCustomText();
    if (!typed) {
      // An empty entry is a decline, not an answer of "other").
      return { answer: '', index: -1 };
    }
    return { answer: typed, index: -1, custom: typed };
  }

  const labels = (Array.isArray(answer) ? answer : [answer]).filter((l) => l !== OTHER_CHOICE_LABEL);
  const indices = labels.map((label) => choices.findIndex((c) => c.label === label));
  // Multi-select "Other": the typed text joins the selection.
  let custom: string | undefined;
  if (multiSelect && (Array.isArray(answer) ? answer : [answer]).includes(OTHER_CHOICE_LABEL)) {
    custom = await promptForCustomText();
  }
  const finalLabels = custom ? [...labels, custom] : labels;
  return {
    answer: multiSelect ? finalLabels : finalLabels[0] ?? '',
    index: multiSelect ? indices : indices[0] ?? -1,
    ...(custom ? { custom } : {}),
  };
}

/** Ask for the free-text answer behind the "Other" choice. */
async function promptForCustomText(): Promise<string> {
  try {
    const { text } = await inquirer.prompt<{ text: string }>([
      {
        type: 'input',
        name: 'text',
        message: 'Type your answer (Enter to skip):',
        prefix: '✏️',
      },
    ]);
    return String(text ?? '').trim();
  } catch {
    return '';
  }
}
