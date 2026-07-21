/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Single-shot mode:
 *   buff execute "add JWT authentication to the Express app"
 *   buff execute "create a CLI tool" --provider gemini --dry-run
 *   buff execute "add tests" --verbose --memory
 *   buff execute "fix bug" --memory --memory-stats
 *   buff execute "run tests" --sandbox
 *
 * Interactive development mode (no goal argument):
 *   buff execute
 *     → Model picker (if no --model flag)
 *     → Interactive loop: goal → orchestrator → results → next goal
 *     → Type /exit to quit
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import type { ConfigManager } from '../config/manager.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { applyActiveModel } from './model.js';
import { showModelPicker } from './model-picker.js';
import { resolveProvider } from './router.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { logger } from '../utils/logger.js';

// ─── Shared Options Type ────────────────────────────────────────────────────

/** Options shared between single-shot and interactive execution */
interface ExecuteOptions {
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
  skipTests?: boolean;
  maxRepairs?: number;
  repairMode?: string;
  repairFallbackModels?: string;
}

// ─── Session Types ──────────────────────────────────────────────────────────

/** A single goal execution entry in the session history */
export interface SessionEntry {
  goal: string;
  success: boolean;
  summary: string;
  timestamp: number;
}

/** Context passed to dev-mode commands that need it */
interface DevCommandContext {
  activeModel: string;
  activeProvider: string | undefined;
  sessionHistory: SessionEntry[];
  configManager: ConfigManager;
}

/** Result of handling a dev-mode slash command */
interface DevCommandResult {
  exit: boolean;
  newModel?: boolean;
  /** When set, the interactive loop should restore this session state */
  restore?: { provider: string; model: string; history: SessionEntry[] };
}

/** Result of a single goal execution */
interface SingleGoalResult {
  success: boolean;
}

// ─── Pure Helpers ───────────────────────────────────────────────────────────

/**
 * Parse multi-line goal input into a single goal string.
 *
 * Used by readGoal() which collects lines from readline; extracted as a
 * pure function so it can be unit-tested without mocking stdin/stdout.
 *
 * @param lines       Lines collected from user input
 * @returns           The joined goal string (blank lines collapsed)
 */
export function parseGoalLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n');
}

// ─── ExecuteCommand ─────────────────────────────────────────────────────────

/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export class ExecuteCommand extends BaseCommand {
  create(): Command {
    const command = new Command('execute')
      .description('Run a multi-agent pipeline to accomplish a goal')
      .argument('[goal]', 'The goal to accomplish (omit for interactive development mode)')
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
      .option('--skip-tests', 'Skip tester and debugger steps (code generation only)', false)
      .option('--max-repairs <number>', 'Max auto-repair attempts per failed task (default: 3, 0 = disabled)', parseInt)
      .option('--repair-mode <mode>', 'Repair mode: auto | prompt | off (default: auto)')
      .option('--repair-fallback-models <models>', 'Comma-separated fallback models for repair (e.g., groq/llama3,nim/mistral)')
      .action(async (goal: string | undefined, options?: {
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
      skipTests?: boolean;
      maxRepairs?: number;
      repairMode?: string;
      repairFallbackModels?: string;
      }) => {
        await this.execute(goal, options || {});
      });

    return command;
  }

  private async execute(
    goal: string | undefined,
    options: ExecuteOptions,
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
    let mergedProvider = activeOpts.provider;
    let mergedModel = activeOpts.model;

    // ── If no goal provided, enter interactive development mode ────────────
    if (!goal) {
      await this.runInteractiveDevMode(mergedProvider, mergedModel, options);
      return;
    }

    if (options.skipTests) {
      logger.info('   🧪 Tests skipped (--skip-tests flag set)');
    }

    // ── Single-shot execution (goal was provided on command line) ──────────
    await this.runSingleGoal(goal, mergedProvider, mergedModel, options);
  }

  // ─── Interactive Development Mode ─────────────────────────────────────────

  /**
   * Interactive development mode — model picker → goal prompt → orchestrator → loop until exit.
   */
  private async runInteractiveDevMode(
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<void> {
    // ── Pick a model if not already specified ──────────────────────────────
    let activeProvider = provider;
    let activeModel = model;

    if (!activeModel) {
      logger.highlight('\n🎯  Welcome to Development Mode!');
      logger.info("   First, let's pick a model to work with.\n");

      const picked = await showModelPicker(this.configManager);
      if (!picked) {
        logger.info('\nNo model selected. Exiting development mode.\n');
        return;
      }

      if (picked.provider !== activeProvider) {
        const resolved = resolveProvider(this.configManager, picked.provider);
        activeProvider = resolved.type;
      }
      activeModel = picked.model;
    }

    // ── SIGINT handler for graceful exit ───────────────────────────────────
    const sigintHandler = () => {
      console.log('\n');
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    // ── Welcome banner ────────────────────────────────────────────────────
    console.log('');
    logger.highlight('═'.repeat(60));
    logger.highlight('  🚀  Development Mode');
    logger.highlight('═'.repeat(60));
    console.log(`\n  Model: ${activeModel}`);
    console.log('');
    logger.info('  Enter a goal for the AI to accomplish (or type /exit to quit).');
    logger.info('  Each goal runs the full multi-agent pipeline: Plan → Gather → Write → Review → Test.');
    console.log('');

    // ── Session tracking ──────────────────────────────────────────────────
    const sessionHistory: SessionEntry[] = [];

    // ── Interactive loop ───────────────────────────────────────────────────
    while (true) {
      const goal = await this.readGoal();
      if (!goal) continue;

      if (goal.startsWith('/')) {
        const handled = await this.handleDevCommand(goal, {
          activeModel,
          activeProvider,
          sessionHistory,
          configManager: this.configManager,
        });
        if (handled.exit) break;
        if (handled.newModel) {
          const picked = await showModelPicker(this.configManager);
          if (picked) {
            if (picked.provider !== activeProvider) {
              const resolved = resolveProvider(this.configManager, picked.provider);
              activeProvider = resolved.type;
            }
            activeModel = picked.model;
            logger.success(`\n✅ Switched to ${activeModel}`);
            console.log('');
          }
        }
        if (handled.restore) {
          activeProvider = handled.restore.provider;
          activeModel = handled.restore.model;
          // Add restored history into the current session
          for (const entry of handled.restore.history) {
            sessionHistory.push(entry);
          }
          logger.success(`\n✅ Restored ${handled.restore.history.length} goal(s) from session`);
          console.log('');
        }
        continue;
      }

      const result = await this.runSingleGoal(goal, activeProvider, activeModel, options);

      // Track executed goal with actual success/failure
      sessionHistory.push({
        goal,
        success: result.success,
        summary: result.success ? `Completed: ${goal.slice(0, 80)}` : `Failed: ${goal.slice(0, 80)}`,
        timestamp: Date.now(),
      });

      // Ask if they want to continue
      console.log('');
      const answer = await inquirer.prompt<{ action: string }>([
        {
          type: 'list',
          name: 'action',
          message: 'What next?',
          prefix: '🚀',
          choices: [
            { name: '💡  Enter another goal', value: 'continue' },
            { name: '🔄  Switch model', value: 'switch-model' },
            { name: '📜  Show session history', value: 'history' },
            { name: '🚪  Exit development mode', value: 'exit' },
          ],
        },
      ]);
      console.log('');

      if (answer.action === 'switch-model') {
        const picked = await showModelPicker(this.configManager);
        if (picked) {
          if (picked.provider !== activeProvider) {
            const resolved = resolveProvider(this.configManager, picked.provider);
            activeProvider = resolved.type;
          }
          activeModel = picked.model;
          logger.success(`✅ Switched to ${activeModel}\n`);
        }
      } else if (answer.action === 'history') {
        this.showSessionHistory(sessionHistory);
      } else if (answer.action === 'exit') {
        break;
      }
    }

    // Cleanup
    process.off('SIGINT', sigintHandler);
    logger.success('\nDevelopment mode ended. Happy coding! 🚀\n');
    process.exit(0);
  }

  /**
   * Display the session goal history.
   */
  private showSessionHistory(history: SessionEntry[]): void {
    if (history.length === 0) {
      logger.info('No goals have been executed yet in this session.');
      return;
    }

    logger.highlight('═'.repeat(60));
    logger.highlight('  📜  Session History');
    logger.highlight('═'.repeat(60));
    console.log('');

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const icon = entry.success ? '✅' : '❌';
      const date = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`  ${i + 1}. ${icon} [${date}] ${entry.goal.slice(0, 100)}`);
    }
    console.log('');
  }

  // ─── Goal Input ───────────────────────────────────────────────────────────

  /**
   * Prompt the user for a goal using readline (supports multi-line input).
   * Delegates to parseGoalLines() for the actual line-joining logic.
   */
  private readGoal(): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '🎯  Goal > ',
        terminal: true,
      });

      const lines: string[] = [];
      let isFirstLine = true;

      // Handle SIGINT during input
      rl.on('SIGINT', () => {
        console.log('');
        lines.push('/exit');
        rl.close();
      });

      rl.on('line', (line) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line === '') {
            rl.prompt();
            isFirstLine = true;
            return;
          }
          lines.push(line);
          if (line.startsWith('/')) {
            rl.close();
            return;
          }
          rl.setPrompt('  ...  > ');
          rl.prompt();
        } else {
          if (line === '') {
            rl.close();
          } else {
            lines.push(line);
            rl.prompt();
          }
        }
      });

      rl.on('close', () => {
        resolve(parseGoalLines(lines));
      });

      rl.prompt();
    });
  }

  // ─── Dev Commands ─────────────────────────────────────────────────────────

  /**
   * Handle slash-commands in development mode.
   */
  private async handleDevCommand(
    cmd: string,
    context?: DevCommandContext,
  ): Promise<DevCommandResult> {
    const lower = cmd.toLowerCase().trim();
    const spaceIdx = lower.indexOf(' ');
    const baseCmd = spaceIdx > 0 ? lower.slice(0, spaceIdx) : lower;
    const arg = spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : '';

    switch (baseCmd) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return { exit: true };

      case '/help': {
        const lines = [
          'Commands:',
          '  /exit, /quit           Exit development mode',
          '  /model                 Switch to a different model',
          '  /suggest [query]       Show similar past goals from memory',
          '  /save <name>           Save current session for later resumption',
          '  /resume <name>         Resume a saved session',
          '  /history               Show goals executed in this session',
          '  /help                  Show this help',
          '',
          'Enter any goal to run the AI pipeline.',
          'Type on multiple lines, end with an empty line.',
        ];
        console.log('');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log('');
        return { exit: false };
      }

      case '/model':
        return { exit: false, newModel: true };

      case '/history': {
        if (context?.sessionHistory) {
          this.showSessionHistory(context.sessionHistory);
        } else {
          logger.info('No session history available.');
        }
        return { exit: false };
      }

      case '/suggest': {
        await this.handleSuggest(arg, context);
        return { exit: false };
      }

      case '/save': {
        await this.handleSave(arg, context);
        return { exit: false };
      }

      case '/resume': {
        const loaded = await this.handleResume(arg);
        if (loaded) {
          logger.success(`\n✅ Resumed session: ${arg}`);
          console.log(`   Provider: ${loaded.provider}`);
          console.log(`   Model: ${loaded.model}`);
          console.log(`   Goals in session: ${loaded.history?.length || 0}`);
          console.log('');
          // Return restore data so the interactive loop can update its state
          return {
            exit: false,
            restore: {
              provider: loaded.provider || '',
              model: loaded.model || '',
              history: loaded.history || [],
            },
          };
        }
        return { exit: false };
      }

      default:
        logger.warn(`Unknown command: ${baseCmd}. Type /help`);
        return { exit: false };
    }
  }

  // ─── Session Save/Resume ──────────────────────────────────────────────────

  /**
   * Save the current development session to disk.
   */
  private async handleSave(name: string, context?: DevCommandContext): Promise<void> {
    if (!name) {
      logger.error('Usage: /save <session-name>');
      return;
    }

    if (!context) {
      logger.error('No session state to save.');
      return;
    }

    const sessionsDir = join(homedir(), '.buff', 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) {
      logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
      return;
    }

    const sessionData = {
      name,
      provider: context.activeProvider,
      model: context.activeModel,
      history: context.sessionHistory,
      savedAt: Date.now(),
    };

    const filePath = join(sessionsDir, `${safeName}.json`);
    writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');

    logger.success(`Session saved as "${name}"`);
    logger.info(`  Path: ${filePath}`);
    logger.info(`  Goals: ${context.sessionHistory.length}`);
    logger.info(`  Model: ${context.activeModel}`);
    console.log('');
    logger.info('Run /resume <name> to restore this session later.');
    console.log('');
  }

  /**
   * Resume a saved development session.
   */
  private async handleResume(
    name: string,
  ): Promise<{ provider?: string; model?: string; history?: SessionEntry[] } | null> {
    if (!name) {
      logger.error('Usage: /resume <session-name>');
      return null;
    }

    const sessionsDir = join(homedir(), '.buff', 'sessions');
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) {
      logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
      return null;
    }
    const filePath = join(sessionsDir, `${safeName}.json`);

    if (!existsSync(filePath)) {
      logger.error(`Session "${name}" not found.`);
      logger.info(`  Available sessions in: ${sessionsDir}`);

      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
        if (files.length > 0) {
          console.log('');
          logger.info('  Available sessions:');
          for (const f of files) {
            console.log(`    • ${f.replace('.json', '')}`);
          }
          console.log('');
        }
      }

      return null;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);

      const date = new Date(data.savedAt).toLocaleString();
      logger.highlight('═'.repeat(60));
      logger.highlight(`  📂  Session: ${name}`);
      logger.highlight('═'.repeat(60));
      console.log(`\n  Saved: ${date}`);
      console.log(`  Provider: ${data.provider || 'default'}`);
      console.log(`  Model: ${data.model || 'default'}`);
      if (data.history && data.history.length > 0) {
        console.log(`  Goals (${data.history.length}):`);
        for (const h of data.history) {
          const icon = h.success ? '✅' : '❌';
          console.log(`    ${icon} ${h.goal.slice(0, 100)}`);
        }
      }
      console.log('');

      return {
        provider: data.provider,
        model: data.model,
        history: data.history,
      };
    } catch (err) {
      logger.error(`Failed to load session: ${err}`);
      return null;
    }
  }

  // ─── Goal Suggestions ─────────────────────────────────────────────────────

  /**
   * Show suggestions from past trajectories (auto-completion via /suggest).
   */
  private async handleSuggest(query: string, context?: DevCommandContext): Promise<void> {
    const searchQuery = query || context?.sessionHistory?.[context.sessionHistory.length - 1]?.goal;

    if (!searchQuery) {
      logger.info('Usage: /suggest <goal description>');
      logger.info('  Shows similar past goals from memory to inspire your next task.');
      console.log('');
      logger.info('Examples:');
      logger.info('  /suggest authentication');
      logger.info('  /suggest add database');
      return;
    }

    logger.highlight('🔍  Searching memory for similar past goals...');
    console.log('');

    try {
      const store = getTrajectoryStore();
      const allTrajectories = store.getAll();

      if (allTrajectories.length === 0) {
        logger.info('No past trajectories found in memory.');
        logger.info('  Run goals with --memory enabled to build up a trajectory history.');
        return;
      }

      const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

      const scored = allTrajectories
        .map((t) => {
          const goalLower = t.goal.toLowerCase();
          const matchCount = queryWords.filter((w) => goalLower.includes(w)).length;
          return { trajectory: t, score: matchCount / Math.max(1, queryWords.length) };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (scored.length === 0) {
        logger.info(`No past goals found matching "${searchQuery}".`);
        logger.info('  Try running goals with --memory to build up a trajectory history.');
        return;
      }

      logger.success(`Found ${scored.length} similar past goal(s):`);
      console.log('');

      for (let i = 0; i < scored.length; i++) {
        const { trajectory, score } = scored[i];
        const pct = Math.round(score * 100);
        const date = new Date(trajectory.timestamp).toLocaleDateString();
        console.log(`  ${i + 1}. [${pct}% match] ${trajectory.goal.slice(0, 120)}`);
        console.log(`     📁 ${trajectory.projectFingerprint || 'N/A'}  |  ${date}  |  ${trajectory.tasksCompleted}/${trajectory.tasksTotal} tasks`);
        console.log('');
      }
    } catch (err) {
      logger.error(`Failed to search memory: ${err}`);
    }
  }

  // ─── Single Goal Execution ────────────────────────────────────────────────

  /**
   * Run the orchestrator for a single goal and display results.
   * Returns the outcome so the caller can record it in session history.
   */
  private async runSingleGoal(
    goal: string,
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<SingleGoalResult> {
    if (options.verbose || options.dryRun || options.review || options.sandbox) {
      logger.info(`Goal: ${goal}`);
      if (options.dryRun) logger.info('Mode: Dry run (files will not be modified)');
      if (options.review) logger.info('Mode: Review (changes captured as review bundle)');
      if (options.sandbox) logger.info('Mode: Sandbox (commands run in Docker containers)');
      if (options.provider) logger.info(`Provider: ${options.provider} (from --provider flag)`);
      else if (provider) logger.info(`Provider: ${provider}`);
      if (options.model) logger.info(`Model: ${options.model} (from --model flag)`);
      else if (model) logger.info(`Model: ${model}`);
      if (options.memory) logger.info('Memory: Enabled');
      console.log('');
    }

    const agentModels: Record<string, string> = {};
    if (options.plannerModel) agentModels['planner'] = options.plannerModel;
    if (options.gathererModel) agentModels['context-gatherer'] = options.gathererModel;
    if (options.writerModel) agentModels['writer'] = options.writerModel;
    if (options.reviewerModel) agentModels['reviewer'] = options.reviewerModel;

    const spinner = ora({
      text: 'Planning...',
      spinner: 'dots',
    }).start();

    try {
      const orchestrator = new Orchestrator(this.configManager);
      const result = await orchestrator.execute(goal, {
        provider,
        model,
        agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
        dryRun: options.dryRun,
        verbose: options.verbose,
        useDockerSandbox: options.sandbox,
        skipTests: options.skipTests,
        useMemory: options.memory,
        reviewMode: options.review,
        contextLimit: options.contextLimit,
        contextPruneMode: options.contextPrune as 'soft' | 'medium' | 'aggressive' | undefined,
        maxRepairs: options.maxRepairs,
        repairMode: options.repairMode as 'auto' | 'prompt' | 'off' | undefined,
        repairFallbackModels: options.repairFallbackModels?.split(',').map((m: string) => m.trim()).filter(Boolean),
      });

      spinner.stop();
      console.log('');
      printOrchestrationResult(result);
      return { success: result.success };
    } catch (err) {
      spinner.fail('Execution failed');
      logger.error(String(err));
      return { success: false };
    }
  }

  // ─── Memory Management ─────────────────────────────────────────────────

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

// ─── Pretty Printer ─────────────────────────────────────────────────────────

/**
 * Pretty-print the orchestration result to the console.
 */
export function printOrchestrationResult(result: import('../agents/orchestrator.js').OrchestrationResult): void {
  const statusIcon = result.success ? '✅' : '❌';
  logger.highlight(`${'═'.repeat(60)}`);
  logger.highlight(`  ${statusIcon}  Execution Result`);
  logger.highlight(`${'═'.repeat(60)}`);

  console.log(`\n  Goal: ${result.goal}`);
  console.log(`\n  ${result.summary}`);
  console.log(`  Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);

  if (result.trajectoryId) {
    console.log(`  Memory: Stored as ${result.trajectoryId}`);
  }

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

  if (result.fileChanges && result.fileChanges !== 'No files changed.') {
    console.log(`\n  File Changes:`);
    for (const line of result.fileChanges.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  if (result.runOutput) {
    console.log(`\n  Command Output:`);
    for (const line of result.runOutput.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  if (result.error) {
    console.log(`\n  Error: ${result.error}`);
  }

  console.log('');
  logger.highlight(`${'═'.repeat(60)}`);
  console.log('');
}
