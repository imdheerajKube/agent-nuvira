/**
 * History command — Browse and search conversation history.
 *
 * Usage:
 *   nuvira history                    — Show recent conversations
 *   nuvira history list               — Show all saved conversations
 *   nuvira history search <q>         — Search conversations by keyword
 *   nuvira history show <id>          — Show a specific conversation
 *   nuvira history clear              — Clear all history
 *   nuvira history prune              — Remove conversations older than retention period
 *   nuvira history reindex            — Rebuild semantic search index
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class HistoryCommand extends BaseCommand {
    create(): Command;
    private listHistory;
    private searchHistory;
    private showSession;
    private clearHistory;
    private pruneHistory;
    private reindexHistory;
}
//# sourceMappingURL=history.d.ts.map