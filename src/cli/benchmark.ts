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
import { logger } from '../utils/logger.js';
import {
  runBenchmark,
  getBenchmarkTasks,
  getBenchmarkRuns,
  getLatestBenchmarkRun,
  formatBenchmarkReport,
  formatBenchmarkMarkdown,
  compareBenchmarks,
  clearBenchmarks,
} from '../learning/benchmark.js';
import type { BenchmarkTask } from '../learning/benchmark.js';

export class BenchmarkCommand extends BaseCommand {
  create(): Command {
    const command = new Command('benchmark')
      .description('Run standardized model benchmarks against coding tasks');

    // ── Run (default) ────────────────────────────────────────────────────
    command
      .command('run', { isDefault: true })
      .description('Run the benchmark suite')
      .option('-p, --provider <provider>', 'Provider to benchmark')
      .option('-m, --model <model>', 'Model to benchmark (required for non-default providers)')
      .option('--tasks <filter>', 'Task filter: task ID, or "quick"/"medium"/"slow" by time estimate')
      .option('--budget <amount>', 'Maximum cost in USD before stopping', parseFloat)
      .option('--format <format>', 'Output format: text (default), json, markdown', 'text')
      .action(async (options?: {
        provider?: string;
        model?: string;
        tasks?: string;
        budget?: number;
        format?: string;
      }) => {
        await this.runBenchmark(options || {});
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
      .action(async (options?: { last?: boolean; compare?: boolean; format?: string }) => {
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

  private async runBenchmark(options: {
    provider?: string;
    model?: string;
    tasks?: string;
    budget?: number;
    format?: string;
  }): Promise<void> {
    // Resolve provider
    const resolved = resolveProvider(this.configManager, options.provider);
    const provider = resolved.provider;
    const providerName = resolved.type;

    // Resolve model
    const model = options.model || this.configManager.getProviderConfig(providerName as any).config.model || 'default';

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
    let taskIds: string[] | undefined;
    let timeEstimate: 'quick' | 'medium' | 'slow' | undefined;

    if (options.tasks) {
      if (['quick', 'medium', 'slow'].includes(options.tasks)) {
        timeEstimate = options.tasks as 'quick' | 'medium' | 'slow';
      } else {
        taskIds = options.tasks.split(',').map((t) => t.trim());
      }
    }

    // Count matching tasks
    let tasks = getBenchmarkTasks();
    if (taskIds && taskIds.length > 0) {
      tasks = tasks.filter((t) => taskIds!.includes(t.id));
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
      const onProgress = (current: number, total: number, task: BenchmarkTask) => {
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
        } catch {
          // Non-critical
        }
      }

    } catch (err) {
      spinner.fail('Benchmark failed');
      logger.error(String(err));
    }
  }

  private listTasks(): void {
    const tasks = getBenchmarkTasks();

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  📋  Benchmark Tasks (${tasks.length})`);
    logger.highlight(`${'═'.repeat(60)}`);

    // Group by category
    const grouped: Record<string, BenchmarkTask[]> = {};
    for (const task of tasks) {
      if (!grouped[task.tag]) grouped[task.tag] = [];
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

  private async showResults(options: { last?: boolean; compare?: boolean; format?: string }): Promise<void> {
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
