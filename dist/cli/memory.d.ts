/**
 * Memory command — Manage agent memory store with compression and pruning.
 *
 * Usage:
 *   nuvira memory                    — Show memory usage statistics
 *   nuvira memory stats              — Show detailed memory store statistics
 *   nuvira memory optimize           — Run automatic compression + pruning
 *   nuvira memory optimize --dry-run — Show what would be done without doing it
 *   nuvira memory optimize --aggressive — More aggressive compression (14d retention, 0.2 min score)
 *   nuvira memory prune              — Prune old/low-quality trajectories
 *   nuvira memory prune --max-age 30 — Remove trajectories older than 30 days
 *   nuvira memory prune --min-score 0.2 — Remove trajectories with score below 0.2
 *   nuvira memory prune --max-count 200 — Keep at most 200 trajectories
 *   nuvira memory summarize          — Summarize old trajectories by project fingerprint
 *   nuvira memory summarize --retention 14 — Keep originals newer than 14 days
 *   nuvira memory clear              — Clear all stored trajectories
 *   nuvira memory info               — Show detailed compression analysis
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
    private listFacts;
    private addFact;
    private listMemories;
    private searchMemories;
    private addMemory;
    private deleteMemory;
    private exportMemories;
    private importMemories;
    private showBackend;
    private clearMemory;
    private formatBytes;
}
//# sourceMappingURL=memory.d.ts.map