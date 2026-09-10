/**
 * H1 — `nuvira tools` command.
 *
 * The H1 acceptance surface: every registered tool is visible here, and the
 * registry is consumed by every action command (chat/execute/plan/run/ci/
 * workflow) — a tool registered once works everywhere with zero per-command
 * re-implementation (STANDING RULE).
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class ToolsCommand extends BaseCommand {
    create(): Command;
    private toolsets;
    private listTools;
    private showTool;
}
//# sourceMappingURL=tools.d.ts.map