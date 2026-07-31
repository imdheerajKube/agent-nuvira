/**
 * Eval command — Run the Agent-Nuvira evaluation framework.
 *
 * Runs real end-to-end coding tasks through the full multi-agent pipeline
 * and grades them across 8 reliability metrics (completion, test pass,
 * time-to-fix, edit accuracy, token efficiency, rollbacks, dependency
 * installs, and recovery via new approaches).
 *
 * Usage:
 *   buff eval run                      — Run all eval tasks against default provider
 *   buff eval run --provider groq      — Run against a specific provider
 *   buff eval run --model llama-3.3    — Use a specific model
 *   buff eval run --tasks quick        — Run only quick tasks
 *   buff eval run --budget 0.50        — Stop if costs exceed $0.50
 *   buff eval list                     — List available eval tasks
 *   buff eval results                  — Show previous eval runs
 *   buff eval score                    — Show the scoring rules
 *   buff eval clear                    — Clear all eval data
 */

import { Command } from 'commander';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { logger } from '../utils/logger.js';
import {
  runEvalSuite,
  getEvalTasks,
  getEvalRuns,
  formatEvalReport,
  formatEvalMarkdown,
  formatEvalScoreRules,
  clearEvals,
} from '../learning/eval-framework.js';
import type { EvalRun, EvalTask } from '../learning/eval-framework.js';
import type { InferenceProvider } from '../inference/interface.js';

export class EvalCommand extends BaseCommand {
  create(): Command {
    const command = new Command('eval')
      .description('Run the Agent-Nuvira evaluation framework — measures if the agent is actually improving');

    // ── run (default) ─────────────────────────────────────────────────────
    command
      .command('run', { isDefault: true })
      .description('Run the evaluation suite')
      .option('-p, --provider <provider>', 'Provider to evaluate')
      .option('-m, --model <model>', 'Model to evaluate')
      .option('--tasks <filter>', 'Task filter: task ID, or "quick"/"medium"/"slow" by time estimate')
      .option('--budget <amount>', 'Maximum cost in USD before stopping', parseFloat)
      .option('--format <format>', 'Output format: text (default), json, markdown', 'text')
      .option('--keep-workspaces', 'Keep temp workspaces for debugging', false)
      .option('--routing', 'Evaluate the exact provider/model pairs the Auto router picks (closes the routing→quality loop)', false)
      .action(async (options?: {
        provider?: string;
        model?: string;
        tasks?: string;
        budget?: number;
        format?: string;
        keepWorkspaces?: boolean;
        routing?: boolean;
      }) => {
        if (options?.routing) {
          await this.runEvalRouting(options || {});
        } else {
          await this.runEval(options || {});
        }
      });

    // ── list ──────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List available eval tasks')
      .action(() => {
        this.listTasks();
      });

    // ── results ───────────────────────────────────────────────────────────
    command
      .command('results')
      .description('Show previous eval runs')
      .option('--last', 'Show only the most recent run', false)
      .option('--format <format>', 'Output format: text (default), json, markdown', 'text')
      .action(async (options?: { last?: boolean; format?: string }) => {
        await this.showResults(options || {});
      });

    // ── score ─────────────────────────────────────────────────────────────
    command
      .command('score')
      .description('Show the evaluation scoring rules')
      .action(() => {
        console.log(`\n${formatEvalScoreRules()}`);
      });

    // ── clear ─────────────────────────────────────────────────────────────
    command
      .command('clear')
      .description('Clear all eval data')
      .action(() => {
        clearEvals();
        logger.success('Eval data cleared.');
      });

    return command;
  }

  /**
   * Evaluate the exact provider/model pairs the Auto router would pick for the
   * eval tasks — closing the loop between routing decisions and measured
   * reliability. Each distinct pick runs the (filtered) task suite; a final
   * comparison ranks the picks by composite score. Decisions are also recorded
   * to the routing-history store (audit trail + dashboard usage stats).
   */
  private async runEvalRouting(options: {
    provider?: string;
    model?: string;
    tasks?: string;
    budget?: number;
    format?: string;
    keepWorkspaces?: boolean;
  }): Promise<void> {
    const router = getAutoRouter();

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

    let tasks = getEvalTasks();
    if (taskIds && taskIds.length > 0) tasks = tasks.filter((t) => taskIds!.includes(t.id));
    if (timeEstimate) tasks = tasks.filter((t) => t.timeEstimate === timeEstimate);

    if (tasks.length === 0) {
      logger.error('No eval tasks match the filter criteria.');
      return;
    }

    // Ask the Auto router which provider/model it would pick for each task
    const picks = new Map<string, { provider: string; model: string; tasks: number }>();
    for (const t of tasks) {
      const d = router.resolve('chat', t.goal, { useRuntimeStats: true }, this.configManager);
      // Record for the dashboard audit trail + usage stats
      recordRoutingDecision({
        source: 'eval',
        agentType: 'chat',
        task: t.goal,
        complexity: d.complexity,
        provider: d.provider,
        model: d.model,
        score: d.score,
      });
      const key = `${d.provider}/${d.model}`;
      const existing = picks.get(key);
      if (existing) {
        existing.tasks++;
      } else {
        picks.set(key, { provider: d.provider, model: d.model, tasks: 1 });
      }
    }

    logger.highlight(`${'═'.repeat(64)}`);
    logger.highlight('  🎯  Routing Eval — evaluates the Auto router\'s picks');
    logger.highlight(`${'═'.repeat(64)}`);
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

    const runs: EvalRun[] = [];

    for (const [key, pick] of picks) {
      let resolved: { type: string; provider: InferenceProvider } | null = null;
      try {
        resolved = resolveProvider(this.configManager, pick.provider);
      } catch {
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

      logger.highlight(`  ── Evaluating router pick: ${key} ──`);
      console.log('');

      const spinner = ora({ text: `Running ${tasks.length} eval tasks against ${key}...`, spinner: 'dots' }).start();
      try {
        const onProgress = (current: number, total: number, task: EvalTask) => {
          spinner.text = `[${current}/${total}] ${task.title} (${task.difficulty})`;
        };
        const run = await runEvalSuite(resolved.provider, resolved.type, pick.model, {
          taskIds,
          timeEstimate,
          budget: options.budget,
          onProgress,
          keepWorkspaces: options.keepWorkspaces,
        });
        spinner.stop();
        runs.push(run);
        console.log(formatEvalReport(run));
        console.log('');
      } catch (err) {
        spinner.fail(`Evaluation failed for ${key}`);
        logger.error(String(err));
      }
    }

    if (runs.length === 0) {
      logger.error('No router picks could be evaluated (all providers unavailable).');
      return;
    }

    // ── Routing pick comparison ────────────────────────────────────────────
    logger.highlight('  ── Routing Pick Comparison ──');
    console.log('');
    const sorted = [...runs].sort((a, b) => b.summary.avgCompositeScore - a.summary.avgCompositeScore);
    console.log(`  ${'Provider/Model'.padEnd(30)} ${'Pass'.padEnd(8)} ${'Composite'.padEnd(11)} ${'Recovery'.padEnd(10)} ${'Cost'}`);
    console.log(`  ${'─'.repeat(72)}`);
    for (const r of sorted) {
      const s = r.summary;
      const passRate = s.totalTasks > 0 ? `${(s.tasksPassed / s.totalTasks * 100).toFixed(0)}%` : '—';
      console.log(`  ${`${r.provider}/${r.model}`.padEnd(30)} ${passRate.padEnd(8)} ${`${(s.avgCompositeScore * 100).toFixed(1)}%`.padEnd(11)} ${`${(s.recoveryRate * 100).toFixed(0)}%`.padEnd(10)} $${s.totalCostUsd.toFixed(6)}`);
    }
    console.log('');
    const best = sorted[0];
    logger.success(`  🏆 Best router pick: ${best.provider}/${best.model} (composite ${(best.summary.avgCompositeScore * 100).toFixed(1)}%)`);
    logger.info('  These results feed the Auto router\'s runtime stats — rerun `buff model explain` to see adjusted scores.');
    console.log('');
  }

  private async runEval(options: {
    provider?: string;
    model?: string;
    tasks?: string;
    budget?: number;
    format?: string;
    keepWorkspaces?: boolean;
  }): Promise<void> {
    const resolved = resolveProvider(this.configManager, options.provider);
    const provider = resolved.provider;
    const providerName = resolved.type;
    const model = options.model || this.configManager.getProviderConfig(providerName as any).config.model || 'default';

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      return;
    }

    logger.highlight(`${'═'.repeat(64)}`);
    logger.highlight(`  🎯  Evaluation: ${providerName}/${model}`);
    logger.highlight(`${'═'.repeat(64)}`);
    console.log('');

    let taskIds: string[] | undefined;
    let timeEstimate: 'quick' | 'medium' | 'slow' | undefined;
    if (options.tasks) {
      if (['quick', 'medium', 'slow'].includes(options.tasks)) {
        timeEstimate = options.tasks as 'quick' | 'medium' | 'slow';
      } else {
        taskIds = options.tasks.split(',').map((t) => t.trim());
      }
    }

    let tasks = getEvalTasks();
    if (taskIds && taskIds.length > 0) tasks = tasks.filter((t) => taskIds!.includes(t.id));
    if (timeEstimate) tasks = tasks.filter((t) => t.timeEstimate === timeEstimate);

    if (tasks.length === 0) {
      logger.error('No eval tasks match the filter criteria.');
      return;
    }

    logger.info(`  Tasks: ${tasks.length}`);
    if (options.budget) logger.info(`  Budget: $${options.budget.toFixed(2)}`);
    console.log('');

    const spinner = ora({ text: `Running ${tasks.length} evaluation tasks...`, spinner: 'dots' }).start();

    try {
      const onProgress = (current: number, total: number, task: EvalTask) => {
        spinner.text = `[${current}/${total}] ${task.title} (${task.difficulty})`;
      };

      const run = await runEvalSuite(provider, providerName, model, {
        taskIds,
        timeEstimate,
        budget: options.budget,
        onProgress,
        keepWorkspaces: options.keepWorkspaces,
      });

      spinner.stop();
      console.log('');

      switch (options.format) {
        case 'json':
          console.log(JSON.stringify(run, null, 2));
          break;
        case 'markdown':
          console.log(formatEvalMarkdown(run));
          break;
        default:
          console.log(formatEvalReport(run));
          break;
      }

      if (options.format && options.format !== 'text') {
        const ext = options.format === 'json' ? 'json' : 'md';
        const filePath = `eval-${run.provider}-${run.model.replace(/[/:]/g, '-')}.${ext}`;
        const content = options.format === 'json'
          ? JSON.stringify(run, null, 2)
          : formatEvalMarkdown(run);
        try {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(filePath, content, 'utf-8');
          logger.success(`Report saved: ${filePath}`);
        } catch {
          // Non-critical
        }
      }
    } catch (err) {
      spinner.fail('Evaluation failed');
      logger.error(String(err));
    }
  }

  private listTasks(): void {
    const tasks = getEvalTasks();
    logger.highlight(`${'═'.repeat(64)}`);
    logger.highlight(`  🎯  Evaluation Tasks (${tasks.length})`);
    logger.highlight(`${'═'.repeat(64)}`);

    const grouped: Record<string, EvalTask[]> = {};
    for (const task of tasks) {
      if (!grouped[task.category]) grouped[task.category] = [];
      grouped[task.category].push(task);
    }

    for (const [category, catTasks] of Object.entries(grouped)) {
      console.log(`\n  📂 ${category}`);
      console.log(`  ${'─'.repeat(44)}`);
      for (const t of catTasks) {
        const difficulty = t.difficulty === 'easy' ? '🟢' : t.difficulty === 'medium' ? '🟡' : '🔴';
        const timeBadge = t.timeEstimate === 'quick' ? '⚡' : t.timeEstimate === 'medium' ? '⏳' : '🐢';
        console.log(`    ${difficulty} ${t.id.padEnd(24)} ${t.title.padEnd(34)} ${timeBadge}`);
      }
    }

    console.log(`\n  Usage: buff eval run --tasks <id1,id2>   (specific tasks)`);
    console.log(`         buff eval run --tasks quick        (by time estimate)`);
    console.log('');
  }

  private async showResults(options: { last?: boolean; format?: string }): Promise<void> {
    const runs = getEvalRuns();
    if (runs.length === 0) {
      logger.info('No eval results found. Run `buff eval run` first.');
      return;
    }

    if (options.last) {
      const format = options.format || 'text';
      switch (format) {
        case 'json':
          console.log(JSON.stringify(runs[0], null, 2));
          break;
        case 'markdown':
          console.log(formatEvalMarkdown(runs[0]));
          break;
        default:
          console.log(formatEvalReport(runs[0]));
          break;
      }
      return;
    }

    logger.highlight(`${'═'.repeat(64)}`);
    logger.highlight(`  🎯  Eval Results (${runs.length} runs)`);
    logger.highlight(`${'═'.repeat(64)}`);

    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const date = new Date(r.startedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const s = r.summary;
      console.log(`\n  ${i + 1}. ${date} — ${r.provider}/${r.model}`);
      console.log(
        `     Score: ${(s.avgCompositeScore * 100).toFixed(1)}%  |  Completion: ${(s.completionRate * 100).toFixed(0)}%  |  Tests: ${(s.testPassRate * 100).toFixed(0)}%  |  Recovery: ${(s.recoveryRate * 100).toFixed(0)}%  |  Cost: $${s.totalCostUsd.toFixed(6)}`,
      );
    }

    console.log(`\n  Show details: buff eval results --last`);
    console.log(`  Compare improvement: run ` + '`buff eval run` again and compare scores across runs.');
    console.log('');
  }
}
