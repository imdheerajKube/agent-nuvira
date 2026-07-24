/**
 * Stats command — View usage statistics and cost tracking.
 *
 * Usage:
 *   buff stats              — Show all stats summary
 *   buff stats cost         — Show cost tracking details
 *   buff stats cost --clear — Reset cost tracking data
 *   buff stats history      — Show conversation history stats
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class StatsCommand extends BaseCommand {
    create(): Command;
    private showCost;
    private showHistoryStats;
    private showAllStats;
}
//# sourceMappingURL=stats.d.ts.map