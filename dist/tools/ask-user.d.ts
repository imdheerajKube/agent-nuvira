/**
 * E3b — `ask_user` renderer.
 *
 * The clarify tool shows a question + ≤4 choices and renders
 * arrow-key/checkbox selection in the CLI. We mirror that exactly with
 * inquirer: single-select = arrow-key list, multi_select = checkbox.
 * Injectable via ToolContext.askUser so tests never touch a real TTY.
 */
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
export declare function renderAskUser(question: string, choices: AskUserChoice[], multiSelect: boolean): Promise<AskUserAnswer>;
//# sourceMappingURL=ask-user.d.ts.map