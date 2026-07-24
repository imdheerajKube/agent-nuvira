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
import { getAgentStats } from '../learning/agent-stats.js';
import { getSelfImprover } from '../learning/self-improver.js';
import { getPatternStore } from '../learning/pattern-extractor.js';
import { getFeedbackStore } from '../learning/feedback.js';
import { compareModelRuns, findBestModelForAgent, formatComparisonResult, formatBenchmarkRecommendations, } from '../learning/model-compare.js';
import { getBenchmarkRuns } from '../learning/benchmark.js';
import { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from '../inference/factory.js';
import { logger } from '../utils/logger.js';
export class LearnCommand {
    configManager;
    constructor(configManager) {
        this.configManager = configManager ?? new ConfigManager();
    }
    create() {
        const cmd = new Command('learn')
            .description('Self-improvement system — agent stats, patterns, and optimization');
        cmd
            .command('stats')
            .description('Show per-agent performance statistics')
            .action(() => this.showStats());
        cmd
            .command('patterns')
            .description('Show extracted coding patterns')
            .option('--extract', 'Force pattern extraction from stored trajectories')
            .option('--provider <provider>', 'Provider to use for LLM calls during extraction')
            .option('--model <model>', 'Model to use for extraction')
            .action((opts) => this.showPatterns(opts));
        cmd
            .command('optimize')
            .description('Generate optimized model-to-agent routing recommendations')
            .action(() => this.showOptimizations());
        cmd
            .command('status')
            .description('Show overall self-improvement status')
            .action(() => this.showStatus());
        cmd
            .command('clear')
            .description('Reset all learning data (stats, patterns, memory)')
            .option('-f, --force', 'Skip confirmation prompt')
            .action((opts) => this.clearData(opts));
        // ── Phase 2.5: New subcommands ─────────────────────────────────────
        cmd
            .command('compare')
            .description('Compare benchmark results between two models')
            .option('--last', 'Compare the last two benchmark runs', false)
            .option('--all', 'Show all benchmark-driven model recommendations', false)
            .action(async (opts) => this.compareModels(opts));
        cmd
            .command('feedback')
            .description('Rate a trajectory or view feedback statistics')
            .option('--trajectory <id>', 'Trajectory ID to rate')
            .option('--rating <positive|negative|neutral|skip>', 'Your rating')
            .option('--comment <text>', 'Optional comment on your rating')
            .option('--stats', 'Show feedback statistics', false)
            .action(async (opts) => this.handleFeedback(opts));
        cmd
            .command('quality')
            .description('Show pattern quality and decay metrics')
            .option('--details', 'Show detailed per-pattern metrics', false)
            .action((opts) => this.showQuality(opts));
        cmd
            .command('gc')
            .description('Garbage-collect low-quality patterns')
            .option('-n, --dry-run', 'Show what would be removed without removing', false)
            .action(async (opts) => this.garbageCollect(opts));
        return cmd;
    }
    // ── Action handlers ───────────────────────────────────────────────────
    showStats() {
        const stats = getAgentStats();
        console.log(stats.formatStats());
        const recommendations = stats.formatModelRecommendations();
        if (recommendations.includes('→')) {
            console.log('');
            console.log(recommendations);
        }
    }
    async showPatterns(opts) {
        const patternStore = getPatternStore();
        const patterns = patternStore.getAll();
        if (opts.extract) {
            console.log('🔄 Extracting patterns from stored trajectories...\n');
            const providerType = (opts.provider || this.configManager.getAll().defaultProvider);
            const { config } = this.configManager.getProviderConfig(providerType);
            const provider = ProviderFactory.createProvider(providerType, config);
            const callLLM = async (prompt) => {
                const result = await provider.generate(prompt, {
                    model: opts.model || config.model,
                    temperature: 0.3,
                    maxTokens: 4096,
                });
                return result;
            };
            const improver = getSelfImprover();
            const count = await improver.extractPatterns(callLLM, true);
            improver.resetExtractionCounter();
            if (count === 0) {
                console.log('   No new patterns extracted. Check that trajectories exist and have scores above 0.7.');
            }
            return;
        }
        if (patterns.length === 0) {
            console.log('📝 No patterns found. Run with `--extract` to generate patterns from stored trajectories.');
            return;
        }
        console.log(`📝 ${patterns.length} Coding Pattern(s)\n`);
        for (let i = 0; i < patterns.length; i++) {
            const p = patterns[i];
            console.log(`${'─'.repeat(50)}`);
            console.log(`Pattern ${i + 1}: ${p.title}`);
            console.log(`   Domains: ${p.applicableDomains.join(', ')}`);
            console.log(`   Source trajectories: ${p.sourceCount}`);
            console.log(`   Avg source score: ${(p.avgSourceScore * 100).toFixed(0)}%`);
            console.log(`   Usage: ${p.usageCount} time(s)`);
            console.log('');
            console.log(`   ${p.description}`);
            console.log('');
            console.log(`   Common files: ${p.commonFiles.join(', ')}`);
            console.log(`   Agent sequence: ${p.commonAgentSequence.join(' → ')}`);
        }
        console.log(`${'─'.repeat(50)}`);
    }
    showOptimizations() {
        const improver = getSelfImprover();
        const modelMap = improver.getOptimizedModelMap();
        if (Object.keys(modelMap).length === 0) {
            console.log('🤖 No optimization data yet. Run some agent tasks first to collect performance stats.');
            return;
        }
        console.log('🤖 Optimized Model Recommendations\n');
        for (const [agentType, model] of Object.entries(modelMap)) {
            console.log(`   ${agentType.padEnd(20)} → ${model}`);
        }
        console.log('\nTo use these recommendations, pass:');
        console.log('   `--auto-route` to the execute command, or');
        console.log('   Configure them in your workflow template\'s recommendedModels.');
    }
    showStatus() {
        const improver = getSelfImprover();
        console.log(improver.getStatus());
        // Also show feedback stats if available
        const feedbackStore = getFeedbackStore();
        const feedbackStats = feedbackStore.getStats();
        if (feedbackStats.totalRatings > 0) {
            console.log('');
            console.log('── User Feedback ──');
            console.log(`   Total ratings: ${feedbackStats.totalRatings}`);
            console.log(`   Positive: ${(feedbackStats.positiveRatio * 100).toFixed(0)}%`);
            console.log(`   Negative: ${(feedbackStats.negativeRatio * 100).toFixed(0)}%`);
            console.log(`   Trend: ${feedbackStats.recentTrend}`);
        }
        // Show pattern quality stats
        const patternStore = getPatternStore();
        const allPatterns = patternStore.getAll();
        if (allPatterns.length > 0) {
            const qualityReport = patternStore.getQualityReport();
            const lowQuality = qualityReport.filter((q) => q.decayScore < 0.5);
            if (lowQuality.length > 0) {
                console.log('');
                console.log('── Pattern Quality ──');
                console.log(`   ${lowQuality.length}/${allPatterns.length} patterns below 0.5 decay score`);
                console.log('   Run `buff learn gc` to clean up low-quality patterns.');
            }
        }
    }
    clearData(opts) {
        if (!opts.force) {
            logger.warn('Use `--force` to confirm clearing all learning data.');
            logger.warn('This will reset agent stats, patterns, feedback, and trajectory memory.');
            return;
        }
        getAgentStats().clear();
        getPatternStore().clear();
        getFeedbackStore().clear();
        getSelfImprover().resetExtractionCounter();
        logger.success('All learning data cleared.');
    }
    // ── Phase 2.5: New handlers ──────────────────────────────────────────
    async compareModels(opts) {
        const runs = getBenchmarkRuns();
        if (runs.length < 2) {
            console.log('⚔️ Need at least 2 benchmark runs to compare models.');
            console.log('   Run `buff benchmark` against different models first.');
            return;
        }
        if (opts.last) {
            // Compare the last two runs
            const result = compareModelRuns(runs[0], runs[1]);
            console.log(formatComparisonResult(result));
            return;
        }
        if (opts.all) {
            // Show all benchmark-driven routing recommendations
            const agentTypes = ['planner', 'writer', 'reviewer', 'tester', 'debugger', 'context-gatherer'];
            const recommendations = agentTypes.map((type) => findBestModelForAgent(type));
            console.log(formatBenchmarkRecommendations(recommendations));
            return;
        }
        // Default: compare last two and show routing recommendations
        console.log('⚔️ Comparing last two benchmark runs...\n');
        const result = compareModelRuns(runs[0], runs[1]);
        console.log(formatComparisonResult(result));
        console.log('\n📊 Benchmark-driven routing recommendations:\n');
        const agentTypes = ['planner', 'writer', 'reviewer', 'tester', 'debugger', 'context-gatherer'];
        const recommendations = agentTypes.map((type) => findBestModelForAgent(type));
        console.log(formatBenchmarkRecommendations(recommendations));
    }
    async handleFeedback(opts) {
        const feedbackStore = getFeedbackStore();
        if (opts.stats) {
            const stats = feedbackStore.getStats();
            console.log('📊 User Feedback Statistics\n');
            console.log(`   Total ratings: ${stats.totalRatings}`);
            console.log(`   Positive:      ${(stats.positiveRatio * 100).toFixed(1)}%`);
            console.log(`   Negative:      ${(stats.negativeRatio * 100).toFixed(1)}%`);
            console.log(`   Neutral:       ${(stats.neutralRatio * 100).toFixed(1)}%`);
            console.log(`   Recent trend:  ${stats.recentTrend}`);
            if (stats.totalRatings > 0) {
                const recent = feedbackStore.getAll().slice(-5).reverse();
                console.log('\n   Recent ratings:');
                for (const entry of recent) {
                    const icon = entry.rating === 'positive' ? '👍' : entry.rating === 'negative' ? '👎' : '➖';
                    console.log(`     ${icon} ${entry.goal.slice(0, 50)} — ${entry.model}`);
                }
            }
            return;
        }
        // Rate a specific trajectory
        if (opts.trajectory && opts.rating) {
            const validRatings = ['positive', 'negative', 'neutral', 'skip'];
            if (!validRatings.includes(opts.rating)) {
                logger.error(`Invalid rating: ${opts.rating}. Use: positive, negative, neutral, or skip.`);
                return;
            }
            feedbackStore.record(opts.trajectory, opts.rating, {
                goal: opts.trajectory,
                provider: 'unknown',
                model: 'unknown',
                comment: opts.comment,
            });
            logger.success(`Rating recorded: ${opts.rating} for trajectory ${opts.trajectory.slice(0, 12)}...`);
            return;
        }
        // Show help
        console.log('📝 Feedback commands:\n');
        console.log('  buff learn feedback --stats              Show feedback statistics');
        console.log('  buff learn feedback --trajectory <id>    Rate a specific trajectory');
        console.log('             --rating positive             Set rating (positive/negative/neutral/skip)');
        console.log('             --comment "your notes"        Add optional comment');
        console.log('');
    }
    async showQuality(opts) {
        const patternStore = getPatternStore();
        const patterns = patternStore.getAll();
        if (patterns.length === 0) {
            console.log('📝 No patterns to evaluate.');
            return;
        }
        const qualityReport = patternStore.getQualityReport();
        const avgDecay = qualityReport.reduce((sum, q) => sum + q.decayScore, 0) / qualityReport.length;
        console.log('📊 Pattern Quality Report\n');
        console.log(`   Total patterns: ${patterns.length}`);
        console.log(`   Average decay score: ${(avgDecay * 100).toFixed(1)}%`);
        console.log(`   Healthy (≥ 0.5): ${qualityReport.filter((q) => q.decayScore >= 0.5).length}`);
        console.log(`   Needs attention (< 0.5): ${qualityReport.filter((q) => q.decayScore < 0.5).length}`);
        console.log(`   Candidates for removal (< ${0.2}): ${qualityReport.filter((q) => q.decayScore < 0.2).length}`);
        console.log('');
        if (opts.details) {
            console.log('   Per-pattern details:\n');
            for (const q of qualityReport.sort((a, b) => a.decayScore - b.decayScore)) {
                const bar = '█'.repeat(Math.round(q.decayScore * 20));
                const remaining = '░'.repeat(20 - Math.round(q.decayScore * 20));
                console.log(`   ${(q.decayScore * 100).toFixed(0).padStart(3)}% ${bar}${remaining}  ${q.title.slice(0, 40).padEnd(40)} used ${q.usageCount}x, ${q.ageDays}d old`);
            }
        }
        console.log('');
        console.log('   Run `buff learn gc` to remove low-quality patterns.');
    }
    async garbageCollect(opts) {
        const patternStore = getPatternStore();
        if (opts.dryRun) {
            const qualityReport = patternStore.getQualityReport();
            const candidates = qualityReport.filter((q) => q.decayScore < 0.2);
            if (candidates.length === 0) {
                console.log('✅ No patterns need garbage collection.');
                return;
            }
            console.log('🔍 Dry run: would remove these patterns:\n');
            for (const q of candidates) {
                console.log(`   ❌ ${q.title} (score: ${(q.decayScore * 100).toFixed(0)}%)`);
            }
            console.log(`\n   Total: ${candidates.length} pattern(s) would be removed.`);
            return;
        }
        const removed = patternStore.garbageCollect();
        if (removed === 0) {
            console.log('✅ All patterns have acceptable quality scores. No garbage collection needed.');
        }
        else {
            logger.success(`Garbage collection removed ${removed} low-quality pattern(s).`);
        }
    }
}
//# sourceMappingURL=learn.js.map