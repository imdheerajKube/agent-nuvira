/**
 * Phase command — Phase-wise project scope execution.
 *
 * Manages multi-goal project execution where each phase is a self-contained
 * goal that gets executed via the Orchestrator. Supports create, execute,
 * resume, status, and list operations.
 *
 * Usage:
 *   buff phase create "v2.0 Release" "Add auth" "Add API" "Publish"
 *   buff phase execute "v2.0 Release"
 *   buff phase resume "v2.0 Release"
 *   buff phase status "v2.0 Release"
 *   buff phase list
 */

import { Command } from 'commander';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { PhaseExecutionEngine, type PhaseDefinition } from '../agents/phase-engine.js';
import { logger } from '../utils/logger.js';

export class PhaseCommand extends BaseCommand {
  create(): Command {
    const command = new Command('phase')
      .description('Phase-wise project scope execution — multi-goal pipelines');

    // ── create ──────────────────────────────────────────────────────────
    command
      .command('create')
      .description('Create a new phase scope with ordered goals')
      .argument('<name>', 'Scope name (e.g., "v2.0 Release", "Security Audit")')
      .argument('<goals...>', 'Phase goals in execution order (one per phase)')
      .option('-o, --output <file>', 'Save scope definition to file')
      .action(async (name: string, goals: string[], options?: { output?: string }) => {
        await this.createScope(name, goals, options);
      });

    // ── execute ─────────────────────────────────────────────────────────
    command
      .command('execute')
      .description('Execute a phase scope from start to finish')
      .argument('<name>', 'Scope name')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('--dry-run', 'Preview phases without executing', false)
      .option('-v, --verbose', 'Show detailed agent output', false)
      .option('--skip-tests', 'Skip test phases', false)
      .option('--non-interactive', 'Run all phases without pausing (stop on failure)', false)
      .action(async (name: string, options: {
        provider?: string;
        model?: string;
        dryRun?: boolean;
        verbose?: boolean;
        skipTests?: boolean;
        nonInteractive?: boolean;
      }) => {
        await this.executeScope(name, options);
      });

    // ── resume ──────────────────────────────────────────────────────────
    command
      .command('resume')
      .description('Resume a saved phase scope from where it left off')
      .argument('<name>', 'Scope name')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('-v, --verbose', 'Show detailed agent output', false)
      .option('--skip-tests', 'Skip test phases', false)
      .action(async (name: string, options: {
        provider?: string;
        model?: string;
        verbose?: boolean;
        skipTests?: boolean;
      }) => {
        await this.resumeScope(name, options);
      });

    // ── status ──────────────────────────────────────────────────────────
    command
      .command('status')
      .description('Show progress of a phase scope')
      .argument('[name]', 'Scope name (lists all scopes if omitted)')
      .action(async (name?: string) => {
        await this.showStatus(name);
      });

    // ── delete ──────────────────────────────────────────────────────────
    command
      .command('delete')
      .description('Delete a saved phase scope')
      .argument('<name>', 'Scope name')
      .action(async (name: string) => {
        await this.deleteScope(name);
      });

    // ── list ────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List all saved phase scopes')
      .action(async () => {
        await this.listScopes();
      });

    return command;
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  private async createScope(
    name: string,
    goals: string[],
    options?: { output?: string },
  ): Promise<void> {
    const phases: PhaseDefinition[] = goals.map((goal, i) => ({
      id: `phase-${i + 1}`,
      goal,
      description: `Phase ${i + 1}: ${goal.slice(0, 60)}`,
    }));

    console.log('');
    logger.highlight(`${'═'.repeat(50)}`);
    logger.highlight('  📋  Phase Scope Created');
    logger.highlight(`${'═'.repeat(50)}`);
    console.log(`  Name: ${name}`);
    console.log(`  Phases: ${phases.length}`);
    console.log('');

    for (let i = 0; i < phases.length; i++) {
      console.log(`  Phase ${i + 1}: ${phases[i].goal}`);
    }

    console.log('');
    logger.info('  Save scope and execute:');
    logger.info(`    buff phase execute "${name}"`);
    console.log('');

    // Save to disk for later execution
    const engine = new PhaseExecutionEngine();
    const scope = engine.createScope({ name, phases });
    engine.saveScope(scope);

    logger.success(`  Scope saved to ~/.buff/phases/`);

    // Ask if user wants to execute now
    const { execute } = await inquirer.prompt<{ execute: boolean }>([
      {
        type: 'confirm',
        name: 'execute',
        message: 'Execute this scope now?',
        default: true,
      },
    ]);

    if (execute) {
      await this.executeScope(name, {});
    }
  }

  // ─── Execute ────────────────────────────────────────────────────────────

  private async executeScope(
    name: string,
    options: {
      provider?: string;
      model?: string;
      dryRun?: boolean;
      verbose?: boolean;
      skipTests?: boolean;
      nonInteractive?: boolean;
    },
  ): Promise<void> {
    const engine = new PhaseExecutionEngine();
    const scope = engine.loadScope(name);

    if (!scope) {
      logger.error(`No phase scope found: "${name}"`);
      logger.info('Create one: buff phase create <name> <goal1> <goal2> ...');
      return;
    }

    if (scope.completed) {
      logger.success(`Scope "${name}" is already completed!`);
      logger.info(engine.getProgress(scope));
      return;
    }

    if (options.dryRun) {
      console.log('');
      logger.highlight(`${'═'.repeat(50)}`);
      logger.highlight(`  📋  DRY RUN: ${scope.name}`);
      logger.highlight(`${'═'.repeat(50)}`);
      console.log('');
      logger.info(engine.getProgress(scope));
      return;
    }

    const orchestrator = new Orchestrator(this.configManager);

    const executeFn = async (goal: string, _phaseId: string, _phaseDescription: string) => {
      const result = await orchestrator.execute(goal, {
        provider: options.provider,
        model: options.model,
        verbose: options.verbose,
        skipTests: options.skipTests,
      });
      return {
        success: result.success,
        summary: result.summary,
        error: result.error,
      };
    };

    await engine.executeScope(scope, executeFn, {
      interactive: !options.nonInteractive,
    });

    // Show final progress
    console.log('');
    logger.info(engine.getProgress(scope));
  }

  // ─── Resume ────────────────────────────────────────────────────────────

  private async resumeScope(
    name: string,
    options: {
      provider?: string;
      model?: string;
      verbose?: boolean;
      skipTests?: boolean;
    },
  ): Promise<void> {
    const engine = new PhaseExecutionEngine();
    const scope = engine.loadScope(name);

    if (!scope) {
      logger.error(`No phase scope found: "${name}"`);
      return;
    }

    if (scope.completed) {
      logger.success(`Scope "${name}" is already completed!`);
      return;
    }

    logger.info(`Resuming scope: ${scope.name}`);
    logger.info(engine.getProgress(scope));

    const { resume } = await inquirer.prompt<{ resume: boolean }>([
      {
        type: 'confirm',
        name: 'resume',
        message: 'Continue execution from the next pending phase?',
        default: true,
      },
    ]);

    if (!resume) {
      logger.info('Resume cancelled.');
      return;
    }

    const orchestrator = new Orchestrator(this.configManager);

    const executeFn = async (goal: string, _phaseId: string, _phaseDescription: string) => {
      const result = await orchestrator.execute(goal, {
        provider: options.provider,
        model: options.model,
        verbose: options.verbose,
        skipTests: options.skipTests,
      });
      return {
        success: result.success,
        summary: result.summary,
        error: result.error,
      };
    };

    await engine.executeScope(scope, executeFn);

    console.log('');
    logger.info(engine.getProgress(scope));
  }

  // ─── Status ────────────────────────────────────────────────────────────

  private async showStatus(name?: string): Promise<void> {
    const engine = new PhaseExecutionEngine();

    if (!name) {
      // List all scopes
      const scopes = engine.listSavedScopes();
      if (scopes.length === 0) {
        logger.info('No saved phase scopes found.');
        logger.info('Create one: buff phase create <name> <goal1> <goal2> ...');
        return;
      }

      console.log('');
      logger.highlight(`${'═'.repeat(50)}`);
      logger.highlight('  📋  Saved Phase Scopes');
      logger.highlight(`${'═'.repeat(50)}`);
      console.log('');

      for (const scopeName of scopes) {
        const scope = engine.loadScope(scopeName);
        if (!scope) continue;

        const completed = scope.phases.filter((p) => p.status === 'completed').length;
        const total = scope.phases.length;
        const status = scope.completed ? '✅ Complete' : '🔄 In progress';
        console.log(`  ${status} ${scopeName}`);
        console.log(`     ${completed}/${total} phases`);
        console.log('');
      }
      return;
    }

    // Show detailed status for a specific scope
    const scope = engine.loadScope(name);
    if (!scope) {
      logger.error(`No phase scope found: "${name}"`);
      return;
    }

    console.log('');
    logger.info(engine.getProgress(scope));
  }

  // ─── Delete ────────────────────────────────────────────────────────────

  private async deleteScope(name: string): Promise<void> {
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Delete phase scope "${name}"? This cannot be undone.`,
        default: false,
      },
    ]);

    if (!confirm) {
      logger.info('Delete cancelled.');
      return;
    }

    const engine = new PhaseExecutionEngine();
    const scope = engine.loadScope(name);
    if (!scope) {
      logger.error(`No phase scope found: "${name}"`);
      return;
    }

    engine.deleteScope(name);
    logger.success(`Deleted scope: ${name}`);
  }

  // ─── List ──────────────────────────────────────────────────────────────

  private async listScopes(): Promise<void> {
    await this.showStatus(undefined);
  }
}
