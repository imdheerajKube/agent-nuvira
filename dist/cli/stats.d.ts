/**
 * Stats command — View usage statistics and cost tracking.
 *
 * Usage:
 *   nuvira stats              — Show all stats summary
 *   nuvira stats cost         — Show cost tracking details
 *   nuvira stats cost --clear — Reset cost tracking data
 *   nuvira stats history      — Show conversation history stats
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