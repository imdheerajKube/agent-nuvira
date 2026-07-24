/**
 * LearnCommand — CLI interface for the self-improvement system.
 *
 * Subcommands:
 *   buff learn stats         — Show agent performance stats
 *   buff learn patterns      — Show/extract coding patterns
 *   buff learn optimize      — Generate optimized model routing
 *   buff learn status        — Show overall self-improvement status
 *   buff learn clear         — Reset learning data
 *   buff learn compare       — A/B model comparison via benchmarks
 *   buff learn feedback      — Rate a trajectory or view feedback stats
 *   buff learn quality       — Show pattern quality and decay metrics
 *   buff learn gc            — Garbage-collect low-quality patterns
 */
import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
export declare class LearnCommand {
    private configManager;
    constructor(configManager?: ConfigManager);
    create(): Command;
    private showStats;
    private showPatterns;
    private showOptimizations;
    private showStatus;
    private clearData;
    private compareModels;
    private handleFeedback;
    private showQuality;
    private garbageCollect;
}
//# sourceMappingURL=learn.d.ts.map