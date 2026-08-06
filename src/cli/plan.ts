import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { logger } from '../utils/logger.js';
import { showModelPicker } from './model-picker.js';
import { resolveProvider } from './router.js';
import { getAutoRouter } from '../learning/auto-router.js';
import { recordRegistrySuccess } from '../learning/provider-fallback.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import { runSingleShotAuto } from './failover-runner.js';
import { PIIPolicyError, GovernancePolicyError } from '../learning/auto-router.js';
import { estimateTokens } from '../learning/cost-tracker.js';

/**
 * Plan command — generate implementation plans for code changes
 * buff plan <directory> [--provider openrouter] [--task "add user auth"]
 */
export class PlanCommand extends BaseCommand {
  create(): Command {
    const command = new Command('plan')
      .description('Generate an implementation plan for a codebase task')
      .argument('[target]', 'File or directory to plan for', '.')
      .option('-t, --task <text>', 'Description of the task to plan')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use')
      .option('-v, --verbose', 'Show full context being sent to the model')
      .action(async (target: string, options?: { task?: string; provider?: string; model?: string; verbose?: boolean }) => {
        await this.execute(target, options || {});
      });

    return command;
  }

  private async execute(target: string, options?: { task?: string; provider?: string; model?: string; verbose?: boolean }): Promise<void> {
    let { type, provider } = await this.getProvider(options || {});

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      logger.info(`\nTip: Run \`agent-nuvira model switch\` to select a configured provider.`);

      // Offer interactive provider selection
      const picked = await showModelPicker(this.configManager);
      if (!picked) {
        logger.info('Cancelled. No plan generated.');
        return;
      }
      const resolved = resolveProvider(this.configManager, picked.provider);
      type = resolved.type;
      provider = resolved.provider;
      // Forward the picked model so provider.generate() uses it
      options = { ...options, model: picked.model };
      logger.success(`Switched to ${provider.name} / ${picked.model}\n`);
    }

    const task = options?.task || 'Analyze the codebase and suggest improvements';

    const parser = new ContextParser({
      maxTokens: 4096,
      priorityPatterns: ['package.json', 'tsconfig.json', 'index.ts', 'main.ts', 'README.md'],
    });

    let contextStr: string;

    const spinner = ora('Analyzing codebase...').start();

    try {
      if (existsSync(target) && statSync(target).isDirectory()) {
        const context = await parser.parseFromDirectory(target);
        contextStr = ContextParser.formatContext(context);
      } else if (existsSync(target)) {
        const context = parser.parseFromFiles([target]);
        contextStr = ContextParser.formatContext(context);
      } else {
        spinner.stop();
        logger.error(`Target not found: ${target}`);
        return;
      }

      if (options?.verbose) {
        spinner.stop();
        logger.highlight('\n--- Context Sent to Model ---\n');
        console.log(contextStr.slice(0, 2000) + (contextStr.length > 2000 ? '\n\n[...truncated...]' : ''));
        logger.highlight('\n--- End Context ---\n');
        spinner.start('Generating plan...');
      }

      const prompt = `You are a senior software engineer. Given the following codebase context, create a detailed implementation plan for this task:

## Task
${task}

## Codebase Context
${contextStr}

## Plan Requirements
Please provide:
1. **Summary** — Brief overview of the task
2. **Files to Modify** — List each file with specific changes needed
3. **Architecture Changes** — Any new files, modules, or structural changes
4. **Implementation Steps** — Ordered step-by-step guide
5. **Potential Risks** — Edge cases, breaking changes, or considerations
6. **Testing Strategy** — How to verify the changes work

Use clear markdown formatting.`;

      spinner.text = 'Generating plan...';

      // ── Generate with the SHARED single-shot auto-failover walk ────────
      // (Nuvira-Router M0.2 Stage C): plan now walks the auto-router's ranked
      // candidates for ANY failure class (auth/404/429/timeout) instead of
      // only retryable errors via the old callWithFallback chain, and every
      // attempt feeds the FULL shared bookkeeping (recordActionFailure: session
      // exclusion + quota-ledger park + registry write-through + timeline +
      // circuit breaker). The picked provider stays primary; the ranked list
      // is the auto-router's ranking (minus the primary), so a dead key/model
      // fails over to the router's best alternatives just like chat.
      const failureSession: FailureSessionState = {
        sessionFailedProviders: new Map(),
        sessionTransientFailedProviders: new Set(),
      };
      const result = await runSingleShotAuto({
        action: 'plan',
        task,
        configManager: this.configManager,
        // Primary = the picked provider (explicit or default). Ranked =
        // auto-router's ranked providers minus the primary + this-run
        // exclusions, so plan never re-tries a provider that already failed.
        route: async (excludeProviders) => {
          let ranked: string[] = [];
          let complexity = 'moderate';
          let score = 0;
          try {
            // M2.5 context-length preflight: pass the REAL prompt payload (task +
            // the codebase context parsed from the target) as the token hint so
            // plan routes toward big-window providers for large contexts — the
            // router falls back to the tiny task-description estimate otherwise.
            const decision = getAutoRouter().resolve('plan', task, { contextHintTokens: estimateTokens(prompt) }, this.configManager);
            ranked = decision.ranked
              .map((r) => r.provider)
              .filter((p) => p !== type && !excludeProviders.includes(p));
            complexity = decision.complexity;
            score = decision.score;
          } catch (err) {
            // A PII or governance policy block is NOT a router failure to
            // degrade around — the router refused to route to any provider
            // that meets the privacy bar / admin policy. Degrading to
            // primary-only could serve a provider the policy rules out,
            // defeating it. Rethrow so the plan surfaces the block honestly.
            if (err instanceof PIIPolicyError || err instanceof GovernancePolicyError) throw err;
            // Best-effort — a router failure must never break the plan walk;
            // primary-only is the graceful degradation.
          }
          return {
            type,
            provider,
            model: options?.model || 'default',
            ranked,
            complexity,
            score,
          };
        },
        generate: async (genProvider, genType, model, apiKey) => {
          const out = await genProvider.generate(prompt, { ...options, model, apiKey });
          // Success attribution: this plan call PROVED the provider × model
          // works — the per-action "learned from real usage" panel gains a
          // 'plan' verified row (mirror of the failure write in the runner).
          recordRegistrySuccess(genType, model, 'plan');
          return out;
        },
        recordFailure: (providerType, model, err, apiKey) =>
          recordActionFailure(failureSession, providerType, err, this.configManager, {
            model,
            action: 'plan',
            apiKey,
          }),
      });

      spinner.stop();

      console.log(`\n${'='.repeat(60)}`);
      logger.highlight(`📋 Implementation Plan`);
      console.log(`${'='.repeat(60)}\n`);
      console.log(result);
      console.log(`\n${'='.repeat(60)}`);
      logger.info(`Generated by ${provider.name}`);
    } catch (err) {
      spinner.fail('Planning failed');

      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAuthError =
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('api key') ||
        errorMessage.includes('Missing Authentication');

      if (isAuthError) {
        logger.error(`Authentication failed for ${provider.name}. The API key may be missing or invalid.`);
        logger.info('');
        logger.info('Options to fix this:');

        // Map provider type to the correct env var name
        const ENV_VAR_MAP: Record<string, string> = {
          groq: 'GROQ_API_KEY',
          nim: 'NVIDIA_NIM_API_KEY',
          gemini: 'GEMINI_API_KEY',
          openrouter: 'OPENROUTER_API_KEY',
          local: '(no API key needed)',
        };
        const envVar = ENV_VAR_MAP[type] || `${type.toUpperCase()}_API_KEY`;

        logger.info('  1. Set the correct API key for this provider:');
        if (envVar !== '(no API key needed)') {
          logger.info(`     export ${envVar}="your_key_here"`);
        } else {
          logger.info(`     Local providers don't need an API key — just run Ollama.`);
        }
        logger.info('  2. Switch to a different provider:');
        logger.info(`     agent-nuvira model switch`);
        logger.info('  3. Use a local model (no API key needed):');
        logger.info('     brew install ollama && ollama pull deepseek-coder');
        logger.info('');

        // Offer interactive provider selection
        const answer = await inquirer.prompt<{ action: string }>([
          {
            type: 'list',
            name: 'action',
            message: 'Would you like to select a different provider?',
            prefix: '⚡',
            choices: [
              { name: '🎯  Switch to a different provider/model', value: 'switch' },
              { name: '❌  Cancel', value: 'cancel' },
            ],
          },
        ]);
        console.log('');

        if (answer.action === 'switch') {
          const picked = await showModelPicker(this.configManager);
          if (picked) {
            logger.info('');
            logger.success(`Selected: ${picked.provider}/${picked.model}`);
            logger.info(`Run \`agent-nuvira plan ${target} --task "${task}" --provider ${picked.provider} --model ${picked.model}\` to retry with this provider.`);
            console.log('');
          }
        }
      } else {
        logger.error(errorMessage.split('\n')[0]);
        logger.info(`Run \`agent-nuvira model switch\` to try a different provider.`);
      }
    }
  }
}
