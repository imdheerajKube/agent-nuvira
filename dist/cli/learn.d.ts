/**
 * LearnCommand — CLI interface for the self-improvement system.
 *
 * Subcommands:
 *   nuvira learn stats         — Show agent performance stats
 *   nuvira learn patterns      — Show/extract coding patterns
 *   nuvira learn lessons       — Show/extract failure lessons (what didn't work)
 *   nuvira learn optimize      — Generate optimized model routing
 *   nuvira learn status        — Show overall self-improvement status
 *   nuvira learn clear         — Reset learning data
 *   nuvira learn compare       — A/B model comparison via benchmarks
 *   nuvira learn feedback      — Rate a trajectory or view feedback stats
 *   nuvira learn quality       — Show pattern quality and decay metrics
 *   nuvira learn gc            — Garbage-collect low-quality patterns
 */
import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
export declare class LearnCommand {
    private configManager;
    constructor(configManager?: ConfigManager);
    create(): Command;
    private showStats;
    private showPatterns;
    private showLessons;
    /**
     * Build the shared LLM call function used by `learn patterns --extract` and
     * `learn lessons --extract`. Resolves the provider config (handling 'auto'),
     * attributes success/failure to the registry (per-action 'learn' rows), and
     * falls back to the next provider on retryable errors — the same discipline
     * chat/execute use.
     */
    private buildLearnCallLLM;
    private showOptimizations;
    private showStatus;
    private clearData;
    private compareModels;
    private handleFeedback;
    private showQuality;
    private garbageCollect;
}
//# sourceMappingURL=learn.d.ts.map