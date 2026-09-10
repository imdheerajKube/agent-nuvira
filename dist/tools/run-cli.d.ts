/**
 * run_cli — plain-English → CLI execution as an agent TOOL.
 *
 * The agent-side half of the intent router (src/commands/intent-router.ts +
 * src/resources/command-manifest.json): the user asks in plain English
 * ("stop the dashboard", "add Rahul's mobile +919958604222 to whatsapp",
 * "run the eval suite") and the model calls:
 *
 *   run_cli({ ask: "stop the dashboard" })
 *
 * The tool resolves the ask against the manifest and, when safe, executes the
 * exact `buff` command as a child process (`node dist/index.js <args>`) — the
 * SAME engine the user would run by hand, so behavior never diverges from the
 * CLI (this mirrors the dashboard task runner's design).
 *
 * Safety model (see docs/COMMANDS.md §15):
 *   - NO arbitrary shell: the tool only executes commands that came from the
 *     manifest's intent → command mapping. The model cannot smuggle a raw
 *     command string in.
 *   - Ambiguous asks (verified list vs send-by-name mapping, …) are NOT
 *     guessed: the tool returns the options and instructs the model to call
 *     `ask_user` first, then retry with the chosen intent.
 *   - Confirmation-flagged intents (stop/shutdown/publish/clear/disallow/…) do
 *     not run until the model passes `confirm: true`, which it only has after
 *     the user confirmed via ask_user.
 *   - Output is capped and sender ids are masked (maskSenderId) — the tool
 *     result never echoes full phone numbers back into the model.
 */
import type { ToolContext } from './registry.js';
/**
 * Strip a leading CLI-bin alias (`buff`, `agent-nuvira`, `nuvira`) from argv.
 * Manifest commands carry the human-facing `buff` prefix, but the spawn target
 * is `node dist/index.js <subcommand>` — a stray prefix would make the CLI
 * print root help instead of running the command.
 */
export declare function stripCliPrefix(argv: string[]): string[];
/** Split a command string into argv, honoring double/single quotes. */
export declare function splitCommand(command: string): string[];
/**
 * Run the run_cli tool — returns model-feedable text (never throws).
 */
export declare function runCliTool(args: unknown, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=run-cli.d.ts.map