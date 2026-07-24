/**
 * Memory command — Manage agent memory store with compression and pruning.
 *
 * Usage:
 *   buff memory                    — Show memory usage statistics
 *   buff memory stats              — Show detailed memory store statistics
 *   buff memory optimize           — Run automatic compression + pruning
 *   buff memory optimize --dry-run — Show what would be done without doing it
 *   buff memory optimize --aggressive — More aggressive compression (14d retention, 0.2 min score)
 *   buff memory prune              — Prune old/low-quality trajectories
 *   buff memory prune --max-age 30 — Remove trajectories older than 30 days
 *   buff memory prune --min-score 0.2 — Remove trajectories with score below 0.2
 *   buff memory prune --max-count 200 — Keep at most 200 trajectories
 *   buff memory summarize          — Summarize old trajectories by project fingerprint
 *   buff memory summarize --retention 14 — Keep originals newer than 14 days
 *   buff memory clear              — Clear all stored trajectories
 *   buff memory info               — Show detailed compression analysis
 *
 * The memory optimization system provides:
 * - Configurable retention policy (age-based, score-based, count-based)
 * - Automatic trajectory summarization (merges similar old trajectories)
 * - Dry-run mode to preview changes before applying
 * - Aggressive mode for maximum space savings
 * - Detailed memory usage statistics
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class MemoryCommand extends BaseCommand {
    create(): Command;
    private showStats;
    private optimize;
    private prune;
    private summarize;
    private showInfo;
    private clearMemory;
    private formatBytes;
}
//# sourceMappingURL=memory.d.ts.map