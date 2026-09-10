/**
 * E3b — `ask_user` renderer.
 *
 * The clarify tool shows a question + ≤4 choices and renders
 * arrow-key/checkbox selection in the CLI. We mirror that exactly with
 * inquirer: single-select = arrow-key list, multi_select = checkbox.
 * Injectable via ToolContext.askUser so tests never touch a real TTY.
 */
import type { AskUserAnswer, AskUserChoice } from './registry.js';
/** Render an in-loop clarification. */
export declare function renderAskUser(question: string, choices: AskUserChoice[], multiSelect: boolean): Promise<AskUserAnswer>;
//# sourceMappingURL=ask-user.d.ts.map