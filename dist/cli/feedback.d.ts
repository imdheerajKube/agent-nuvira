/**
 * Feedback command — Record, view, and manage user feedback on agent outputs.
 *
 * Usage:
 *   buff feedback record <trajectory-id>  — Rate a trajectory (👍/👎)
 *   buff feedback list                     — Show recent feedback entries
 *   buff feedback stats                    — Show aggregated feedback statistics
 *   buff feedback clear                    — Clear all feedback data
 *
 * Feedback helps the self-improvement system learn which outputs are
 * useful and tune provider/model routing accordingly.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class FeedbackCommand extends BaseCommand {
    create(): Command;
    private recordFeedback;
    private listFeedback;
    private showStats;
    private clearFeedback;
}
//# sourceMappingURL=feedback.d.ts.map