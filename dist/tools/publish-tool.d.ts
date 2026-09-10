/**
 * E3c — Publish workflow as a TOOL (`src/tools/publish-tool.ts`).
 *
 * The model-decides vocabulary: a chat turn can run the SAME publish pipeline
 * as `nuvira publish` by calling the `publish` tool — no mode selection, no
 * command the user must type. The CLI command (src/cli/publish.ts) and this
 * tool share `buildPublishPhases` (one phase list, zero divergence).
 *
 * Tool semantics (credentialed, irreversible action):
 * - NON-INTERACTIVE: credentials come from the environment / detected config
 *   ONLY (the CLI's interactive collectAll prompts never run inside a tool
 *   call — the model asks the user for tokens via `ask_user` instead).
 * - Missing credentials are reported back as a tool result so the model can
 *   ask for them and retry.
 * - `dry_run: true` previews the phases without touching anything.
 * - Returns a summary text fed back to the model (never throws).
 */
import type { ToolContext } from './registry.js';
/**
 * Run the publish workflow as a tool — returns model-feedable text.
 * The input schema lives in the registry (single source, never hand-kept) —
 * loaded lazily here so registry.ts stays import-light (STANDING RULE).
 */
export declare function runPublishTool(args: unknown, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=publish-tool.d.ts.map