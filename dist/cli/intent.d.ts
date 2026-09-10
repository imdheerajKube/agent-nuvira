/**
 * `nuvira intent resolve "<ask>"` — plain-English → CLI routing.
 *
 * The user-facing half of the intent router (src/commands/intent-router.ts):
 * type "stop the dashboard", "add Rahul's mobile +919958604222 to whatsapp",
 * "start the gateway", "run the eval suite" and see exactly which `buff`
 * command the agent would execute — including a clarifying question when the
 * ask is ambiguous (verified list vs send-by-name mapping, …).
 *
 * This is the reference surface for the docs/COMMANDS.md §15 design: the same
 * resolver is what the agent itself should call before running any command.
 */
import { Command } from 'commander';
export declare class IntentCommand {
    create(): Command;
    private resolve;
}
//# sourceMappingURL=intent.d.ts.map