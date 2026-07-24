/**
 * History command — Browse and search conversation history.
 *
 * Usage:
 *   buff history                    — Show recent conversations
 *   buff history list               — Show all saved conversations
 *   buff history search <q>         — Search conversations by keyword
 *   buff history show <id>          — Show a specific conversation
 *   buff history clear              — Clear all history
 *   buff history prune              — Remove conversations older than retention period
 *   buff history reindex            — Rebuild semantic search index
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