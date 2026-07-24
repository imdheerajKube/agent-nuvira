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
import { getCostTracker } from '../learning/cost-tracker.js';
import { getChatHistory } from '../context/history.js';
import { logger } from '../utils/logger.js';
export class StatsCommand extends BaseCommand {
    create() {
        const command = new Command('stats')
            .description('View usage statistics and cost tracking');
        // ── cost ─────────────────────────────────────────────────────────────
        const costCmd = new Command('cost')
            .description('Show API cost tracking details')
            .option('--clear', 'Reset all cost tracking data')
            .action(async (options) => {
            await this.showCost(options);
        });
        command.addCommand(costCmd);
        // ── history ──────────────────────────────────────────────────────────
        const historyCmd = new Command('history')
            .description('Show conversation history statistics')
            .action(() => {
            this.showHistoryStats();
        });
        command.addCommand(historyCmd);
        // Default: show all stats
        command.action(() => {
            this.showAllStats();
        });
        return command;
    }
    async showCost(options) {
        if (options?.clear) {
            getCostTracker().clear();
            logger.success('Cost tracking data cleared.');
            return;
        }
        const tracker = getCostTracker();
        console.log(`\n${tracker.formatSummary()}`);
    }
    showHistoryStats() {
        const history = getChatHistory();
        const total = history.count();
        const recent = history.getRecentSessions(7);
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight('  📝  Conversation History');
        logger.highlight(`${'═'.repeat(60)}`);
        console.log(`\n  Total sessions: ${total}`);
        console.log(`  Recent (7 days): ${recent.length}`);
        if (recent.length > 0) {
            console.log(`\n  Recent sessions:`);
            for (const session of recent.slice(0, 10)) {
                console.log(history.formatSessionSummary(session));
            }
        }
        console.log('');
    }
    showAllStats() {
        this.showHistoryStats();
        const tracker = getCostTracker();
        const summary = tracker.getSummary();
        if (summary.totalRequests > 0) {
            console.log(`\n${tracker.formatSummary()}`);
        }
        else {
            logger.info('No cost data yet. Start using providers to track costs.');
        }
    }
}
//# sourceMappingURL=stats.js.map