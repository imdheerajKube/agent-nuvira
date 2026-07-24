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
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { getMemoryStats, clearMemory } from '../memory/memory-integration.js';
import { getPatternStore } from '../learning/pattern-extractor.js';
import { getVectorStore } from '../memory/vector-store.js';
import { getFeedbackStore } from '../learning/feedback.js';
import { logger } from '../utils/logger.js';
export class MemoryCommand extends BaseCommand {
    create() {
        const command = new Command('memory')
            .description('Manage agent memory store — compression, pruning, and optimization');
        // ── stats (default) ──────────────────────────────────────────────────
        command
            .command('stats')
            .description('Show memory store statistics')
            .action(async () => {
            await this.showStats();
        });
        // ── optimize ─────────────────────────────────────────────────────────
        const optimizeCmd = new Command('optimize')
            .description('Run automatic memory compression and pruning')
            .option('--dry-run', 'Show what would be done without making changes', false)
            .option('--aggressive', 'Use aggressive optimization settings', false)
            .action(async (options) => {
            await this.optimize(options || {});
        });
        command.addCommand(optimizeCmd);
        // ── prune ────────────────────────────────────────────────────────────
        const pruneCmd = new Command('prune')
            .description('Prune old or low-quality trajectories')
            .option('--max-age <days>', 'Remove trajectories older than N days', parseInt)
            .option('--min-score <score>', 'Remove trajectories with score below N', parseFloat)
            .option('--max-count <count>', 'Keep at most N trajectories', parseInt)
            .option('--verbose', 'Show details of what was removed', false)
            .action(async (options) => {
            await this.prune(options || {});
        });
        command.addCommand(pruneCmd);
        // ── summarize ────────────────────────────────────────────────────────
        const summarizeCmd = new Command('summarize')
            .description('Summarize old trajectories by merging similar ones')
            .option('--retention <days>', 'Keep original trajectories newer than N days', parseInt)
            .option('--verbose', 'Show details of summarization', false)
            .action(async (options) => {
            await this.summarize(options || {});
        });
        command.addCommand(summarizeCmd);
        // ── info ─────────────────────────────────────────────────────────────
        command
            .command('info')
            .description('Show detailed compression analysis')
            .action(async () => {
            await this.showInfo();
        });
        // ── clear ────────────────────────────────────────────────────────────
        command
            .command('clear')
            .description('Clear all stored trajectories and reset memory')
            .option('-f, --force', 'Skip confirmation')
            .action(async (options) => {
            await this.clearMemory(options || {});
        });
        // Default: show stats
        command.action(async () => {
            await this.showStats();
        });
        return command;
    }
    // ── Action Handlers ──────────────────────────────────────────────────────
    async showStats() {
        try {
            const stats = await getMemoryStats();
            logger.highlight('═'.repeat(60));
            logger.highlight('  💾  Agent Memory Store');
            logger.highlight('═'.repeat(60));
            console.log(`\n  📊 Trajectories:`);
            console.log(`     Total: ${stats.total}`);
            console.log(`     Avg quality score: ${(stats.avgScore * 100).toFixed(1)}%`);
            if (Object.keys(stats.byProjectFingerprint).length > 0) {
                console.log(`\n  📂 By Project Type:`);
                for (const [fp, count] of Object.entries(stats.byProjectFingerprint).sort(([, a], [, b]) => b - a)) {
                    console.log(`     ${fp.padEnd(20)} ${count} trajectory(ies)`);
                }
            }
            // Vector store stats
            const vs = getVectorStore();
            const vsStats = vs.stats();
            console.log(`\n  🔍 Vector Index:`);
            console.log(`     Entries: ${vsStats.totalEntries}`);
            console.log(`     Dimensions: ${vsStats.dimensions}`);
            // Pattern store stats
            const patternStore = getPatternStore();
            const patterns = patternStore.getAll();
            console.log(`\n  📝 Coding Patterns:`);
            console.log(`     Total: ${patterns.length}`);
            // Trajectory compression stats
            const trajStore = getTrajectoryStore();
            const compressionStats = trajStore.getCompressionStats();
            console.log(`\n  📦 Compression Analysis:`);
            console.log(`     Estimated size: ${this.formatBytes(compressionStats.totalSizeBytes)}`);
            console.log(`     Old (>30 days): ${compressionStats.oldTrajectories}`);
            console.log(`     Low score (<0.3): ${compressionStats.lowScoreTrajectories}`);
            console.log(`     Mergeable groups: ${compressionStats.mergeableGroups}`);
            console.log(`     ${compressionStats.estimatedOptimization}`);
            // Feedback stats
            const feedbackStore = getFeedbackStore();
            const feedbackStats = feedbackStore.getStats();
            if (feedbackStats.totalRatings > 0) {
                console.log(`\n  👍 User Feedback:`);
                console.log(`     Total ratings: ${feedbackStats.totalRatings}`);
                console.log(`     Positive: ${(feedbackStats.positiveRatio * 100).toFixed(0)}%`);
                console.log(`     Trend: ${feedbackStats.recentTrend}`);
            }
            console.log('');
            logger.info('Run `buff memory optimize` to compress and prune old data.');
            console.log('');
        }
        catch (err) {
            logger.error(`Failed to get memory stats: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async optimize(options) {
        const trajStore = getTrajectoryStore();
        const baseline = trajStore.getCompressionStats();
        logger.highlight('═'.repeat(60));
        logger.highlight(options.dryRun ? '  🔍  Memory Optimization (Dry Run)' : '  🔄  Running Memory Optimization');
        logger.highlight('═'.repeat(60));
        console.log(`\n  📊 Before: ${baseline.totalTrajectories} trajectories, ${this.formatBytes(baseline.totalSizeBytes)}`);
        if (options.dryRun) {
            console.log(`     Old (>30d): ${baseline.oldTrajectories} candidates for pruning`);
            console.log(`     Low score (<0.3): ${baseline.lowScoreTrajectories} candidates for pruning`);
            console.log(`     Mergeable groups: ${baseline.mergeableGroups} groups for summarization`);
            console.log(`     ${baseline.estimatedOptimization}`);
            console.log('');
            logger.info('Run without --dry-run to apply these optimizations.');
            console.log('');
            return;
        }
        // Phase 1: Prune by policy
        const maxAgeDays = options.aggressive ? 14 : 90;
        const minScore = options.aggressive ? 0.2 : 0.1;
        const maxCount = options.aggressive ? 200 : 500;
        logger.info(`\n  Phase 1: Pruning (maxAge=${maxAgeDays}d, minScore=${minScore}, maxCount=${maxCount})...`);
        const pruned = trajStore.pruneByPolicy(maxAgeDays, minScore, maxCount, false);
        logger.success(`  Removed ${pruned} trajectory(ies)`);
        // Phase 2: Summarize old trajectories
        const retentionDays = options.aggressive ? 7 : 30;
        logger.info(`\n  Phase 2: Summarizing (retention=${retentionDays}d)...`);
        const { summarized, merged } = await trajStore.summarize(retentionDays, false);
        logger.success(`  Summarized ${summarized} group(s), merged ${merged} trajectory(ies)`);
        // Phase 3: Garbage collect patterns
        logger.info('\n  Phase 3: Cleaning up coding patterns...');
        const patternStore = getPatternStore();
        const patternsRemoved = patternStore.garbageCollect();
        if (patternsRemoved > 0) {
            logger.success(`  Removed ${patternsRemoved} low-quality pattern(s)`);
        }
        else {
            logger.info('  No patterns needed cleanup');
        }
        // Results
        const after = trajStore.getCompressionStats();
        const saved = baseline.totalTrajectories - after.totalTrajectories;
        console.log('\n  ── Results ──');
        console.log(`  Before: ${baseline.totalTrajectories} trajectories`);
        console.log(`  After:  ${after.totalTrajectories} trajectories`);
        console.log(`  Saved:  ${saved} trajectories (${baseline.totalTrajectories > 0 ? Math.round((saved / baseline.totalTrajectories) * 100) : 0}% reduction)`);
        console.log(`  Size:   ${this.formatBytes(baseline.totalSizeBytes)} → ${this.formatBytes(after.totalSizeBytes)}`);
        console.log('');
        logger.success('Memory optimization complete!');
        console.log('');
    }
    async prune(options) {
        const trajStore = getTrajectoryStore();
        const maxAge = options.maxAge ?? 90;
        const minScore = options.minScore ?? 0.1;
        const maxCount = options.maxCount ?? 500;
        const verbose = options.verbose ?? false;
        logger.highlight('═'.repeat(60));
        logger.highlight('  🗑️  Pruning Trajectories');
        logger.highlight('═'.repeat(60));
        console.log(`\n  Max age: ${maxAge} days`);
        console.log(`  Min score: ${minScore}`);
        console.log(`  Max count: ${maxCount}`);
        const removed = trajStore.pruneByPolicy(maxAge, minScore, maxCount, verbose);
        if (removed > 0) {
            logger.success(`\n  Removed ${removed} trajectory(ies).`);
        }
        else {
            logger.info('\n  No trajectories needed pruning.');
        }
        const stats = await getMemoryStats();
        console.log(`  Remaining: ${stats.total} trajectory(ies)`);
        console.log('');
    }
    async summarize(options) {
        const trajStore = getTrajectoryStore();
        const retention = options.retention ?? 7;
        const verbose = options.verbose ?? false;
        logger.highlight('═'.repeat(60));
        logger.highlight('  📝  Summarizing Old Trajectories');
        logger.highlight('═'.repeat(60));
        console.log(`\n  Retention: ${retention} days (trajectories newer than this kept intact)`);
        const { summarized, merged } = await trajStore.summarize(retention, verbose);
        if (merged > 0) {
            logger.success(`\n  Summarized ${summarized} group(s) — merged ${merged} trajectory(ies).`);
        }
        else {
            logger.info('\n  No trajectories needed summarization.');
        }
        console.log('');
    }
    async showInfo() {
        const trajStore = getTrajectoryStore();
        const compressionStats = trajStore.getCompressionStats();
        const stats = await getMemoryStats();
        logger.highlight('═'.repeat(60));
        logger.highlight('  📋  Memory Compression Analysis');
        logger.highlight('═'.repeat(60));
        console.log('\n  ── Current Usage ──');
        console.log(`  Trajectories: ${compressionStats.totalTrajectories}`);
        console.log(`  Estimated size: ${this.formatBytes(compressionStats.totalSizeBytes)}`);
        console.log(`  Average quality score: ${(stats.avgScore * 100).toFixed(1)}%`);
        console.log('\n  ── Optimization Candidates ──');
        console.log(`  🕐  Old trajectories (>30 days): ${compressionStats.oldTrajectories}`);
        console.log(`     Run: buff memory prune --max-age 30`);
        console.log(`\n  ⭐  Low-quality trajectories (<0.3): ${compressionStats.lowScoreTrajectories}`);
        console.log(`     Run: buff memory prune --min-score 0.3`);
        console.log(`\n  🔗  Mergeable groups: ${compressionStats.mergeableGroups}`);
        console.log(`     Run: buff memory summarize --retention 7`);
        console.log(`\n  ${compressionStats.estimatedOptimization}`);
        console.log(`     Run: buff memory optimize --dry-run  # to preview`);
        console.log(`     Run: buff memory optimize            # to apply`);
        console.log('\n  ── All Data Stores ──');
        const vs = getVectorStore();
        const vsStats = vs.stats();
        const patterns = getPatternStore().getAll();
        const feedbackStore = getFeedbackStore();
        const feedbackStats = feedbackStore.getStats();
        console.log(`  🧠  Vector index: ${vsStats.totalEntries} entries (${vsStats.dimensions}-dim)`);
        console.log(`  📝  Coding patterns: ${patterns.length}`);
        console.log(`  👍  User feedback: ${feedbackStats.totalRatings} ratings`);
        console.log('');
        logger.info('To clear everything: buff memory clear --force');
        console.log('');
    }
    async clearMemory(options) {
        if (!options.force) {
            logger.warn('This will delete ALL stored trajectories and reset the vector index.');
            logger.warn('Use --force to confirm.');
            return;
        }
        logger.info('Clearing all memory data...');
        await clearMemory();
        // Also clear patterns and feedback
        getPatternStore().clear();
        getFeedbackStore().clear();
        logger.success('All memory data cleared (trajectories, patterns, feedback, vector index).');
    }
    // ── Helpers ──────────────────────────────────────────────────────────────
    formatBytes(bytes) {
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
//# sourceMappingURL=memory.js.map