/**
 * Benchmark command — Run standardized model benchmarks against coding tasks.
 *
 * Usage:
 *   buff benchmark                      — Run all tasks against default provider
 *   buff benchmark --provider groq      — Run against a specific provider
 *   buff benchmark --model llama-3.3    — Use a specific model
 *   buff benchmark --tasks quick        — Run only quick tasks
 *   buff benchmark --budget 0.50        — Stop if costs exceed $0.50
 *   buff benchmark list                 — List available benchmark tasks
 *   buff benchmark results              — Show previous benchmark results
 *   buff benchmark results --last       — Show last run only
 *   buff benchmark results --compare    — Compare last two runs
 *   buff benchmark clear                — Clear all benchmark data
 */
import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { logger } from '../utils/logger.js';
import { runBenchmark, getBenchmarkTasks, getBenchmarkRuns, formatBenchmarkReport, formatBenchmarkMarkdown, compareBenchmarks, clearBenchmarks, } from '../learning/benchmark.js';
export class BenchmarkCommand extends BaseCommand {
    create() {
        const command = new Command('benchmark')
            .description('Run standardized model benchmarks against coding tasks');
        // ── Run (default) ────────────────────────────────────────────────────
        command
            .command('run', { isDefault: true })
            .description('Run the benchmark suite')
            .option('-p, --provider <provider>', 'Provider to benchmark')
            .option('-m, --model <model>', 'Model to benchmark (required for non-default providers)')
            .option('--tasks <filter>', 'Task filter: task ID, or "quick"/"medium"/"slow" by time estimate')
            .option('--budget <amount>', 'Maximum cost in USD before stopping (applies per pick in --routing mode)', parseFloat)
            .option('--format <format>', 'Output format: text (default), json, markdown', 'text')
            .option('--routing', 'Benchmark the exact provider/model pairs the Auto router picks (closes the routing→quality loop)', false)
            .action(async (options) => {
            if (options?.routing) {
                await this.runRoutingBenchmark(options || {});
            }
            else {
                await this.runBenchmark(options || {});
            }
        });
        // ── list ─────────────────────────────────────────────────────────────
        command
            .command('list')
            .description('List available benchmark tasks')
            .action(() => {
            this.listTasks();
        });
        // ── results ──────────────────────────────────────────────────────────
        command
            .command('results')
            .description('Show previous benchmark results')
            .option('--last', 'Show only the most recent run', false)
            .option('--compare', 'Compare the last two runs', false)
            .option('--format <format>', 'Output format: text (default), json, markdown', 'text')
            .action(async (options) => {
            await this.showResults(options || {});
        });
        // ── clear ────────────────────────────────────────────────────────────
        command
            .command('clear')
            .description('Clear all benchmark data')
            .action(() => {
            clearBenchmarks();
            logger.success('Benchmark data cleared.');
        });
        return command;
    }
    async runBenchmark(options) {
        // Resolve provider
        const resolved = resolveProvider(this.configManager, options.provider);
        const provider = resolved.provider;
        const providerName = resolved.type;
        // Resolve model
        const model = options.model || this.configManager.getProviderConfig(providerName).config.model || 'default';
        const available = await provider.isAvailable();
        if (!available) {
            logger.error(`${provider.name} is not available. Check your configuration.`);
            return;
        }
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight(`  📊  Benchmark: ${providerName}/${model}`);
        logger.highlight(`${'═'.repeat(60)}`);
        console.log('');
        // Parse task filter
        let taskIds;
        let timeEstimate;
        if (options.tasks) {
            if (['quick', 'medium', 'slow'].includes(options.tasks)) {
                timeEstimate = options.tasks;
            }
            else {
                taskIds = options.tasks.split(',').map((t) => t.trim());
            }
        }
        // Count matching tasks
        let tasks = getBenchmarkTasks();
        if (taskIds && taskIds.length > 0) {
            tasks = tasks.filter((t) => taskIds.includes(t.id));
        }
        if (timeEstimate) {
            tasks = tasks.filter((t) => t.timeEstimate === timeEstimate);
        }
        if (tasks.length === 0) {
            logger.error('No benchmark tasks match the filter criteria.');
            return;
        }
        const budget = options.budget;
        if (budget) {
            logger.info(`  Budget: $${budget.toFixed(2)}`);
        }
        logger.info(`  Tasks: ${tasks.length} (${tasks.filter((t) => t.timeEstimate === 'quick').length} quick, ${tasks.filter((t) => t.timeEstimate === 'medium').length} medium, ${tasks.filter((t) => t.timeEstimate === 'slow').length} slow)`);
        console.log('');
        // Spinner-based progress (fallback when no onProgress callback)
        const spinner = ora({
            text: `Running ${tasks.length} benchmark tasks...`,
            spinner: 'dots',
        }).start();
        try {
            const onProgress = (current, total, task) => {
                spinner.text = `[${current}/${total}] ${task.title} (${task.difficulty}/${task.timeEstimate})`;
            };
            const run = await runBenchmark(provider, providerName, model, {
                taskIds,
                timeEstimate,
                budget,
                onProgress,
            });
            spinner.stop();
            // Display results
            console.log('');
            switch (options.format) {
                case 'json':
                    console.log(JSON.stringify(run, null, 2));
                    break;
                case 'markdown':
                    console.log(formatBenchmarkMarkdown(run));
                    break;
                default:
                    console.log(formatBenchmarkReport(run));
                    break;
            }
            // Save to file if requested
            const outputFormat = options.format || 'text';
            if (outputFormat !== 'text') {
                const ext = outputFormat === 'json' ? 'json' : 'md';
                const filePath = `benchmark-${run.provider}-${run.model.replace(/[/:]/g, '-')}.${ext}`;
                const content = outputFormat === 'json'
                    ? JSON.stringify(run, null, 2)
                    : formatBenchmarkMarkdown(run);
                try {
                    const { writeFileSync } = await import('node:fs');
                    writeFileSync(filePath, content, 'utf-8');
                    logger.success(`Report saved: ${filePath}`);
                }
                catch {
                    // Non-critical
                }
            }
        }
        catch (err) {
            spinner.fail('Benchmark failed');
            logger.error(String(err));
        }
    }
    /**
     * Benchmark the exact provider/model pairs the Auto router would pick for the
     * benchmark tasks — closing the loop between routing decisions and measured
     * quality. Each distinct pick runs the (filtered) task suite; a final
     * comparison ranks the picks by quality score.
     */
    async runRoutingBenchmark(options) {
        const router = getAutoRouter();
        // Parse task filter
        let taskIds;
        let timeEstimate;
        if (options.tasks) {
            if (['quick', 'medium', 'slow'].includes(options.tasks)) {
                timeEstimate = options.tasks;
            }
            else {
                taskIds = options.tasks.split(',').map((t) => t.trim());
            }
        }
        let tasks = getBenchmarkTasks();
        if (taskIds && taskIds.length > 0)
            tasks = tasks.filter((t) => taskIds.includes(t.id));
        if (timeEstimate)
            tasks = tasks.filter((t) => t.timeEstimate === timeEstimate);
        if (tasks.length === 0) {
            logger.error('No benchmark tasks match the filter criteria.');
            return;
        }
        // Ask the Auto router which provider/model it would pick for each task
        const picks = new Map();
        for (const t of tasks) {
            const d = router.resolve('chat', t.prompt, { useRuntimeStats: true }, this.configManager);
            // Record for the dashboard usage stats + audit trail
            recordRoutingDecision({
                source: 'benchmark',
                agentType: 'chat',
                task: t.prompt,
                complexity: d.complexity,
                provider: d.provider,
                model: d.model,
                score: d.score,
            });
            const key = `${d.provider}/${d.model}`;
            const existing = picks.get(key);
            if (existing) {
                existing.tasks++;
            }
            else {
                picks.set(key, { provider: d.provider, model: d.model, tasks: 1 });
            }
        }
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight('  🎯  Routing Benchmark — benchmarks the Auto router\'s picks');
        logger.highlight(`${'═'.repeat(60)}`);
        console.log('');
        if (options.provider || options.model) {
            logger.warn('  ⚠️  --provider/--model are ignored in --routing mode (the router decides).');
            console.log('');
        }
        if (options.format && options.format !== 'text') {
            logger.warn('  ⚠️  --format is not applied in --routing mode — reports are always printed as text.');
            console.log('');
        }
        for (const [key, pick] of picks) {
            console.log(`   🤖 ${pick.provider.padEnd(12)} → ${pick.model.padEnd(28)} (${pick.tasks} task${pick.tasks !== 1 ? 's' : ''})`);
        }
        console.log('');
        const budget = options.budget;
        const runs = [];
        for (const [key, pick] of picks) {
            let resolved = null;
            try {
                resolved = resolveProvider(this.configManager, pick.provider);
            }
            catch {
                logger.warn(`  Skipping ${key} — provider unavailable.`);
                continue;
            }
            if (!resolved) {
                continue;
            }
            const available = await resolved.provider.isAvailable();
            if (!available) {
                logger.warn(`  ⚠️  ${key} is not available — skipping (configure it with \`buff model switch <provider>\`).`);
                continue;
            }
            logger.highlight(`  ── Benchmarking router pick: ${key} ──`);
            console.log('');
            const spinner = ora({ text: `Running ${tasks.length} tasks against ${key}...`, spinner: 'dots' }).start();
            try {
                const onProgress = (current, total, task) => {
                    spinner.text = `[${current}/${total}] ${task.title}`;
                };
                const run = await runBenchmark(resolved.provider, resolved.type, pick.model, {
                    taskIds,
                    timeEstimate,
                    budget,
                    onProgress,
                });
                spinner.stop();
                runs.push(run);
                console.log(formatBenchmarkReport(run));
                console.log('');
            }
            catch (err) {
                spinner.fail(`Benchmark failed for ${key}`);
                logger.error(String(err));
            }
        }
        if (runs.length === 0) {
            logger.error('No router picks could be benchmarked (all providers unavailable).');
            return;
        }
        // ── Routing pick comparison ────────────────────────────────────────────
        logger.highlight('  ── Routing Pick Comparison ──');
        console.log('');
        const sorted = [...runs].sort((a, b) => b.summary.avgQualityScore - a.summary.avgQualityScore);
        console.log(`  ${'Provider/Model'.padEnd(30)} ${'Pass'.padEnd(8)} ${'Quality'.padEnd(10)} ${'Latency'.padEnd(10)} ${'Cost'}`);
        console.log(`  ${'─'.repeat(72)}`);
        for (const r of sorted) {
            const s = r.summary;
            const passRate = s.totalTasks > 0 ? `${(s.tasksPassed / s.totalTasks * 100).toFixed(0)}%` : '—';
            console.log(`  ${`${r.provider}/${r.model}`.padEnd(30)} ${passRate.padEnd(8)} ${`${(s.avgQualityScore * 100).toFixed(1)}%`.padEnd(10)} ${`${s.medianLatencyMs}ms`.padEnd(10)} $${s.totalCostUsd.toFixed(6)}`);
        }
        console.log('');
        const best = sorted[0];
        logger.success(`  🏆 Best router pick: ${best.provider}/${best.model} (quality ${(best.summary.avgQualityScore * 100).toFixed(1)}%)`);
        logger.info('  These results feed the Auto router\'s runtime stats — rerun `buff model explain` to see adjusted scores.');
        console.log('');
    }
    listTasks() {
        const tasks = getBenchmarkTasks();
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight(`  📋  Benchmark Tasks (${tasks.length})`);
        logger.highlight(`${'═'.repeat(60)}`);
        // Group by category
        const grouped = {};
        for (const task of tasks) {
            if (!grouped[task.tag])
                grouped[task.tag] = [];
            grouped[task.tag].push(task);
        }
        for (const [tag, tagTasks] of Object.entries(grouped)) {
            console.log(`\n  📂 ${tag}`);
            console.log(`  ${'─'.repeat(40)}`);
            for (const t of tagTasks) {
                const difficulty = t.difficulty === 'easy' ? '🟢' : t.difficulty === 'medium' ? '🟡' : t.difficulty === 'hard' ? '🔴' : '⚫';
                const timeBadge = t.timeEstimate === 'quick' ? '⚡' : t.timeEstimate === 'medium' ? '⏳' : '🐢';
                console.log(`    ${difficulty} ${t.id.padEnd(25)} ${t.title.padEnd(35)} ${timeBadge}`);
            }
        }
        console.log(`\n  Usage: buff benchmark --tasks <id1,id2>   (specific tasks)`);
        console.log(`         buff benchmark --tasks quick        (by time estimate)`);
        console.log('');
    }
    async showResults(options) {
        const runs = getBenchmarkRuns();
        if (runs.length === 0) {
            logger.info('No benchmark results found. Run `buff benchmark` first.');
            return;
        }
        if (options.compare && runs.length >= 2) {
            const comparison = compareBenchmarks(runs[0], runs[1]);
            console.log(`\n${comparison}`);
            return;
        }
        if (options.last) {
            const format = options.format || 'text';
            switch (format) {
                case 'json':
                    console.log(JSON.stringify(runs[0], null, 2));
                    break;
                case 'markdown':
                    console.log(formatBenchmarkMarkdown(runs[0]));
                    break;
                default:
                    console.log(formatBenchmarkReport(runs[0]));
                    break;
            }
            return;
        }
        // List all runs
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight(`  📊  Benchmark Results (${runs.length} runs)`);
        logger.highlight(`${'═'.repeat(60)}`);
        for (let i = 0; i < runs.length; i++) {
            const r = runs[i];
            const date = new Date(r.startedAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
            const s = r.summary;
            const passRate = s.totalTasks > 0 ? (s.tasksPassed / s.totalTasks * 100).toFixed(0) : '0';
            console.log(`\n  ${i + 1}. ${date} — ${r.provider}/${r.model}`);
            console.log(`     ${s.tasksPassed}/${s.totalTasks} passed (${passRate}%)  |  Quality: ${(s.avgQualityScore * 100).toFixed(1)}%  |  Latency: ${s.medianLatencyMs}ms  |  Cost: $${s.totalCostUsd.toFixed(6)}`);
        }
        console.log(`\n  Show details: buff benchmark results --last`);
        console.log(`  Compare: buff benchmark results --compare`);
        console.log('');
    }
}
//# sourceMappingURL=benchmark.js.map