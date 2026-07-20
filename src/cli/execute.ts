/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Usage:
 *   agent-baba-d execute "add JWT authentication to the Express app"
 *   agent-baba-d execute "create a CLI tool" --provider gemini --dry-run
 *   agent-baba-d execute "add tests" --verbose --memory
 *   agent-baba-d execute "fix bug" --memory --memory-stats
 *   agent-baba-d execute "run tests" --sandbox          # Run in Docker sandbox
 *   agent-baba-d execute "verify build" --sandbox --sandbox-image node:20-slim
 */

import { Command } from 'commander';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { applyActiveModel } from './model.js';
import { logger } from '../utils/logger.js';

/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export class ExecuteCommand extends BaseCommand {
  create(): Command {
    const command = new Command('execute')
      .description('Run a multi-agent pipeline to accomplish a goal')
      .argument('<goal>', 'The goal to accomplish (e.g., "add JWT auth to Express app")')
      .option('-p, --provider <provider>', 'Inference provider for all agents')
      .option('-m, --model <model>', 'Model override for all agents')
      .option('--planner-model <model>', 'Model for the Planner agent')
      .option('--gatherer-model <model>', 'Model for the Context Gatherer agent')
      .option('--writer-model <model>', 'Model for the Writer agent')
      .option('--reviewer-model <model>', 'Model for the Reviewer agent')
      .option('--dry-run', 'Preview changes without writing to disk', false)
      .option('-v, --verbose', 'Show detailed agent output', false)
      .option('--memory', 'Enable persistent memory (learn from past sessions)', false)
      .option('--memory-stats', 'Show memory statistics and exit', false)
      .option('--memory-clear', 'Clear all stored memory trajectories', false)
      .option('--context-limit <tokens>', 'Max context tokens before pruning (default: 128000). Set higher for Gemini (1000000)', parseInt)
      .option('--context-prune <mode>', 'Pruning aggressiveness: soft | medium | aggressive (default: soft)')
      .option('--review', 'Create a review bundle capturing proposed changes (view with `buff team review show <id>`)', false)
      .option('--sandbox', 'Execute runner commands and tests inside a Docker sandbox', false)
      .option('--max-repairs <number>', 'Max auto-repair attempts per failed task (default: 3, 0 = disabled)', parseInt)
      .option('--repair-mode <mode>', 'Repair mode: auto | prompt | off (default: auto)')
      .option('--repair-fallback-models <models>', 'Comma-separated fallback models for repair (e.g., groq/llama3,nim/mistral)')
      .action(async (goal: string, options?: {
        provider?: string;
        model?: string;
        plannerModel?: string;
        gathererModel?: string;
        writerModel?: string;
        reviewerModel?: string;
        dryRun?: boolean;
        verbose?: boolean;
        memory?: boolean;
        memoryStats?: boolean;
        memoryClear?: boolean;
        contextLimit?: number;contextPrune?: string;
      review?: boolean;
      sandbox?: boolean;
      maxRepairs?: number;
      repairMode?: string;
      repairFallbackModels?: string;
      }) => {
        await this.execute(goal, options || {});
      });

    return command;
  }

  private async execute(
    goal: string,
    options: {
      provider?: string;
      model?: string;
      plannerModel?: string;
      gathererModel?: string;
      writerModel?: string;
      reviewerModel?: string;
      dryRun?: boolean;
      verbose?: boolean;
      memory?: boolean;
      memoryStats?: boolean;
      memoryClear?: boolean;
      contextLimit?: number;
      contextPrune?: string;
      review?: boolean;
      sandbox?: boolean;
      maxRepairs?: number;
      repairMode?: string;
      repairFallbackModels?: string;
      },
  ): Promise<void> {
    // ── Handle memory management commands ─────────────────────────────────
    if (options.memoryStats) {
      await this.showMemoryStats();
      return;
    }

    if (options.memoryClear) {
      await this.clearMemory();
      return;
    }

    // ── Apply active model from `buff model switch` as defaults ────────────
    const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });
    const mergedProvider = activeOpts.provider;
    const mergedModel = activeOpts.model;

    // ── Setup ──────────────────────────────────────────────────────────────
    if (options.verbose || options.dryRun || options.review || options.sandbox) {
      logger.info(`Goal: ${goal}`);
      if (options.dryRun) logger.info('Mode: Dry run (files will not be modified)');
      if (options.review) logger.info('Mode: Review (changes captured as review bundle)');
      if (options.sandbox) logger.info('Mode: Sandbox (commands run in Docker containers)');
      // Show effective provider/model (CLI flags take priority)
      if (options.provider) logger.info(`Provider: ${options.provider} (from --provider flag)`);
      else if (activeOpts.provider !== options.provider && activeOpts.provider) logger.info(`Provider: ${activeOpts.provider} (from active model)`);
      if (options.model) logger.info(`Model: ${options.model} (from --model flag)`);
      else if (activeOpts.model !== options.model && activeOpts.model) logger.info(`Model: ${activeOpts.model} (from active model)`);
      if (options.memory) logger.info('Memory: Enabled');
      console.log('');
    }

    // ── Sandbox config ────────────────────────────────────────────────────
    const useDockerSandbox = options.sandbox === true;

    // ── Agent model overrides ──────────────────────────────────────────────
    const agentModels: Record<string, string> = {};
    if (options.plannerModel) agentModels['planner'] = options.plannerModel;
    if (options.gathererModel) agentModels['context-gatherer'] = options.gathererModel;
    if (options.writerModel) agentModels['writer'] = options.writerModel;
    if (options.reviewerModel) agentModels['reviewer'] = options.reviewerModel;

    // ── Execute ────────────────────────────────────────────────────────────
    const spinner = ora({
      text: 'Planning...',
      spinner: 'dots',
    }).start();

    try {
      const orchestrator = new Orchestrator(this.configManager);
      const result = await orchestrator.execute(goal, {
        provider: mergedProvider,
        model: mergedModel,
        agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
        dryRun: options.dryRun,
        verbose: options.verbose,
        useDockerSandbox: options.sandbox,
        useMemory: options.memory,
        reviewMode: options.review,
        contextLimit: options.contextLimit,
        contextPruneMode: options.contextPrune as 'soft' | 'medium' | 'aggressive' | undefined,
        maxRepairs: options.maxRepairs,
        repairMode: options.repairMode as 'auto' | 'prompt' | 'off' | undefined,
        repairFallbackModels: options.repairFallbackModels?.split(',').map((m: string) => m.trim()).filter(Boolean),
      });

      spinner.stop();

      // ── Display Results ──────────────────────────────────────────────────
      console.log('');
      printOrchestrationResult(result);

    } catch (err) {
      spinner.fail('Execution failed');
      logger.error(String(err));
    }
  }

  private async showMemoryStats(): Promise<void> {
    try {
      const { getMemoryStats } = await import('../memory/memory-integration.js');
      const stats = await getMemoryStats();

      logger.highlight(`${'═'.repeat(60)}`);
      logger.highlight(`  🧠  Memory Statistics`);
      logger.highlight(`${'═'.repeat(60)}`);

      console.log(`\n  Total trajectories: ${stats.total}`);
      console.log(`  Average quality score: ${stats.avgScore}`);

      if (Object.keys(stats.byProjectFingerprint).length > 0) {
        console.log(`\n  By project type:`);
        for (const [fp, count] of Object.entries(stats.byProjectFingerprint)) {
          console.log(`    ${fp}: ${count}`);
        }
      }

      console.log('');
      logger.highlight(`${'═'.repeat(60)}`);
      console.log('');
    } catch (err) {
      logger.error(`Failed to read memory stats: ${err}`);
    }
  }

  private async clearMemory(): Promise<void> {
    try {
      const { clearMemory } = await import('../memory/memory-integration.js');
      await clearMemory();
      logger.success('Memory cleared successfully');
    } catch (err) {
      logger.error(`Failed to clear memory: ${err}`);
    }
  }
}

/**
 * Pretty-print the orchestration result to the console.
 */
export function printOrchestrationResult(result: import('../agents/orchestrator.js').OrchestrationResult): void {
  // Header
  const statusIcon = result.success ? '✅' : '❌';
  logger.highlight(`${'═'.repeat(60)}`);
  logger.highlight(`  ${statusIcon}  Execution Result`);
  logger.highlight(`${'═'.repeat(60)}`);

  // Goal
  console.log(`\n  Goal: ${result.goal}`);

  // Summary
  console.log(`\n  ${result.summary}`);
  console.log(`  Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);

  // Trajectory ID
  if (result.trajectoryId) {
    console.log(`  Memory: Stored as ${result.trajectoryId}`);
  }

  // Agent results
  if (result.agentResults.length > 0) {
    console.log(`\n  Agents:`);
    for (const ar of result.agentResults) {
      const icon = ar.success ? '✅' : '❌';
      const truncatedSummary = ar.summary.length > 120
        ? ar.summary.slice(0, 120) + '...'
        : ar.summary;
      console.log(`    ${icon} ${ar.agent}: ${truncatedSummary}`);
    }
  }

  // File changes
  if (result.fileChanges && result.fileChanges !== 'No files changed.') {
    console.log(`\n  File Changes:`);
    for (const line of result.fileChanges.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  // Runner output
  if (result.runOutput) {
    console.log(`\n  Command Output:`);
    for (const line of result.runOutput.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  // Error
  if (result.error) {
    console.log(`\n  Error: ${result.error}`);
  }

  console.log('');
  logger.highlight(`${'═'.repeat(60)}`);
  console.log('');
}
