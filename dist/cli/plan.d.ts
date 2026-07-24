import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Plan command — generate implementation plans for code changes
 * buff plan <directory> [--provider openrouter] [--task "add user auth"]
 */
export declare class PlanCommand extends BaseCommand {
    create(): Command;
    private execute;
}
//# sourceMappingURL=plan.d.ts.map