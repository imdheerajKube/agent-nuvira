import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { logger } from '../utils/logger.js';
import { getProviderFallback, classifyFallbackError, isRetryableError, recordRegistryFailure, recordRegistrySuccess } from '../learning/provider-fallback.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { buildAutoResolveOptions } from '../learning/resolve-options.js';
import { runSingleShotAuto } from './failover-runner.js';
import { parseRequestSync } from '../nlu/parser.js';
import { resolveDispatch } from '../nlu/actions.js';
import { contractFromParsed, renderContractCard } from '../nlu/contract.js';
import { maybeAutoRecall, recallCard, recallContextBlock, recallPolicy } from '../context/session-recall.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import { sweepTransientFailures, sessionRevivalStore } from '../learning/provider-revival.js';
import { resolveProvider } from './router.js';

/**
 * Edit command — edit files using AI assistance
 * nuvira edit <file> [--provider nim] [--instruction "add error handling"]
 * nuvira edit <file> --auto-route -i "add error handling"   (router-ranked walk)
 */
export class EditCommand extends BaseCommand {
  create(): Command {
    const command = new Command('edit')
      .description('Edit a file using AI assistance')
      .argument('<file>', 'File to edit')
      .option('-i, --instruction <text>', 'Edit instruction')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use')
      .option('--auto-route', 'Auto-route the edit to the best provider/model (Auto model)', false)
      .option('--dry-run', 'Show proposed changes without modifying the file')
      .option('--review', 'Create a review bundle capturing proposed changes instead of writing directly')
      .action(async (file: string, options?: { instruction?: string; provider?: string; model?: string; autoRoute?: boolean; dryRun?: boolean; review?: boolean }) => {
        await this.execute(file, options || {});
      });

    return command;
  }

  private async execute(file: string, options?: { instruction?: string; provider?: string; model?: string; autoRoute?: boolean; dryRun?: boolean; review?: boolean }): Promise<void> {
    if (!existsSync(file)) {
      logger.error(`File not found: ${file}`);
      return;
    }

    const content = readFileSync(file, 'utf-8');
    const instruction = options?.instruction || 'Review and improve this code. Fix bugs, improve readability, and add error handling where appropriate.';

    const parser = new ContextParser({ maxTokens: 2048 });
    const context = parser.parseFromString(content, file);
    const contextStr = ContextParser.formatContext(context);

    const prompt = `I have the following code in ${file}:\n\n${contextStr}\n\nInstruction: ${instruction}\n\nPlease provide the complete updated file content. Return ONLY the code, no explanations.`;

    // Session 22: cross-command parity card — the user sees what the agent
    // understood before the edit runs, just like execute/plan/chat do. Edit
    // is a direct file edit (no pipeline), so the footer states the boundary.
    const parsedEdit = parseRequestSync(instruction);
    const contract = contractFromParsed(instruction, parsedEdit);
    console.log('\n' + renderContractCard(contract, {
      footer: '→ Editing the file directly — no pipeline run.',
    }) + '\n');

    // ISSUE-003: edit supports the SAME auto routing as chat/execute/plan —
    // either via an explicit --auto-route flag or an 'auto' provider/model.
    // The router-ranked walk (runSingleShotAuto) handles the primary pick,
    // ranked failover for ALL failure classes, key rotation, and full shared
    // bookkeeping — never the degraded single-provider path of the past.
    if (options?.autoRoute || isAutoProvider(options?.provider) || isAutoModel(options?.model)) {
      await this.executeAutoRouted(file, options, prompt, content, instruction);
    } else {
      await this.executeDirect(file, options, prompt, content);
    }
  }

  /** Legacy single-provider path (explicit --provider/--model, no auto). */
  private async executeDirect(file: string, options: { instruction?: string; provider?: string; model?: string; autoRoute?: boolean; dryRun?: boolean; review?: boolean } | undefined, prompt: string, content: string): Promise<void> {
    const { type, provider } = await this.getProvider(options || {});

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      return;
    }

    const spinner = ora(`Editing ${file} with ${provider.name}...`).start();

    try {
      let result: string;

      try {
        result = await provider.generate(prompt, options);
        // Success attribution: this edit call PROVED the provider × model
        // works — the per-action "learned from real usage" panel gains an
        // 'edit' verified row (mirror of the failure write in the catch).
        recordRegistrySuccess(type, options?.model, 'edit');
      } catch (err) {
        // Try automatic fallback before failing
        const errorType = classifyFallbackError(err);
        // Feed the SHARED registry telemetry path: an auth/404 failure on this
        // FIRST direct call would otherwise never be learned (non-retryable
        // errors skip the fallback loop entirely), so edit now routes around
        // the dead provider on the next pick like chat/execute do.
        recordRegistryFailure(type, options?.model, err, errorType, 'edit');
        if (isRetryableError(errorType)) {
          try {
            const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
            const fallbackResult = await fallback.callWithFallback(
              type,
              async (fbProvider) => fbProvider.generate(prompt, options),
              { context: 'edit', label: `Edit ${file}` },
            );
            result = fallbackResult.response;
            if (fallbackResult.attempts > 1) {
              logger.success(`✅ Auto-fallback: switched to ${fallbackResult.provider}`);
            }
          } catch (fallbackErr) {
            throw err; // Throw the original error
          }
        } else {
          throw err;
        }
      }

      if (options?.dryRun) {
        spinner.stop();
        logger.highlight('\n--- Proposed Changes ---\n');
        console.log(result);
        logger.highlight('\n--- End ---\n');
        return;
      }

      // Extract code block if present
      let codeResult = result;
      const codeBlockMatch = result.match(/```[\w]*\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        codeResult = codeBlockMatch[1];
      }

      if (options?.review) {
        spinner.stop();

        const { createReviewFromResult } = await import('../team/review.js');
        const review = createReviewFromResult(
          options.instruction || `Edit ${file}`,
          [{
            path: file,
            originalContent: content,
            newContent: codeResult,
            status: 'modified',
          }],
          `Edit: ${options.instruction || 'Code improvement'}\n\nModified: ${file}`,
          {
            provider: type,
            model: options.model,
            author: process.env.USER || 'agent-baba-d',
          },
        );

        logger.highlight(`\n📋 Created review bundle: ${review.id}`);
        logger.info(`   Run \`nuvira team review show ${review.id}\` to view`);
        logger.info(`   Run \`nuvira team review approve ${review.id}\` then \`nuvira team review merge ${review.id}\` to apply`);
        return;
      }

      writeFileSync(file, codeResult, 'utf-8');
      spinner.succeed(`Updated ${file}`);
    } catch (err) {
      spinner.fail('Edit failed');
      logger.error(String(err));
    }
  }

  /**
   * ISSUE-003: router-ranked edit walk. Resolves the PRIMARY through the auto
   * router (full feature set: bandit, quota, runtime stats, floors, paid gate)
   * and fails over through the router's ranked candidates via the SHARED
   * single-shot walk — identical to plan/chat/execute so a dead provider is
   * never retried and every failure feeds the shared bookkeeping.
   */
  private async executeAutoRouted(file: string, options: { instruction?: string; provider?: string; model?: string; autoRoute?: boolean; dryRun?: boolean; review?: boolean } | undefined, prompt: string, content: string, instruction: string): Promise<void> {
    const failureSession: FailureSessionState = {
      sessionFailedProviders: new Map(),
      sessionTransientFailedProviders: new Set(),
    };
    // Captured by generate() so the review bundle attributes the ACTUAL winner
    // provider × model (the walk may fail over away from the primary).
    let winner: { provider: string; model: string } = { provider: 'auto', model: 'default' };

    const spinner = ora(`Auto-routing edit for ${file}...`).start();
    try {
      // D1: agent-driven auto-recall — continue/resume instructions recall the
      // project's prior work into the edit prompt (cross-command parity with
      // chat/execute/plan). Best-effort — never breaks edit.
      try {
        const parsedEdit = parseRequestSync(instruction);
        // Ambient recall (see recallPolicy): an edit no longer has to be phrased
        // as a continuation to learn what this project already did.
        const recallPolicyDecision = recallPolicy({ intent: parsedEdit.intent });
        if (recallPolicyDecision.recall) {
          const recall = await maybeAutoRecall(process.cwd(), this.configManager.getWorkspaceStore());
          if (recall) {
            if (recallPolicyDecision.announce) console.log(recallCard(recall));
            prompt = `${recallContextBlock(recall)}\n\n${prompt}`;
          }
        }
      } catch { /* recall must never break edit */ }

      const result = await runSingleShotAuto({
        action: 'edit',
        task: instruction,
        configManager: this.configManager,
        // Re-admit any provider that recovered from a transient failure before
        // the route is computed. Without this the marker armed by
        // recordActionFailure was written and never read on this path — an
        // exclusion stayed in force for the whole edit even after the provider
        // came back.
        revive: async () => {
          await sweepTransientFailures(sessionRevivalStore(failureSession), this.configManager, {
            agentType: 'edit',
          });
        },
        route: async (excludeProviders) => {
          // C3: the NLU parser seeds the router task-intent (cross-command
          // parity — same choke point as chat/execute/plan).
          const dispatch = resolveDispatch(parseRequestSync(instruction));
          const decision = getAutoRouter().resolve(
            'edit',
            instruction,
            {
              ...buildAutoResolveOptions(this.configManager),
              ...(dispatch.taskIntentHint ? { taskIntentHint: dispatch.taskIntentHint } : {}),
            },
            this.configManager,
          );
          // ISSUE-003: an explicit --provider stays PRIMARY (user intent wins,
          // mirroring plan.ts); the router supplies the ranked fallback. Only
          // when no provider is pinned does the router's pick lead the walk.
          const primaryType = options?.provider && !isAutoProvider(options.provider)
            ? options.provider
            : decision.provider;
          const primary = resolveProvider(this.configManager, primaryType);
          const model = options?.model && !isAutoModel(options.model)
            ? options.model
            : decision.model;
          const ranked = decision.ranked
            .map((r) => r.provider)
            .filter((p) => p !== primaryType && !excludeProviders.includes(p));
          return {
            type: primaryType,
            provider: primary.provider,
            model,
            ranked,
            complexity: decision.complexity,
            score: decision.score,
          };
        },
        generate: async (genProvider, genType, model, apiKey) => {
          winner = { provider: genType, model: model || 'default' };
          const out = await genProvider.generate(prompt, { ...options, model, apiKey });
          // Success attribution: this edit call PROVED the provider × model
          // works — per-action "learned from real usage" panel gains an
          // 'edit' verified row.
          recordRegistrySuccess(genType, model, 'edit');
          return out;
        },
        recordFailure: (providerType, model, err, apiKey) =>
          recordActionFailure(failureSession, providerType, err, this.configManager, {
            model,
            action: 'edit',
            apiKey,
          }),
      });

      spinner.stop();

      if (options?.dryRun) {
        logger.highlight('\n--- Proposed Changes ---\n');
        console.log(result);
        logger.highlight('\n--- End ---\n');
        return;
      }

      // Extract code block if present
      let codeResult = result;
      const codeBlockMatch = result.match(/```[\w]*\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        codeResult = codeBlockMatch[1];
      }

      if (options?.review) {
        const { createReviewFromResult } = await import('../team/review.js');
        const review = createReviewFromResult(
          instruction,
          [{
            path: file,
            originalContent: content,
            newContent: codeResult,
            status: 'modified',
          }],
          `Edit: ${instruction}\n\nModified: ${file}`,
          {
            provider: winner.provider,
            model: winner.model,
            author: process.env.USER || 'agent-baba-d',
          },
        );

        logger.highlight(`\n📋 Created review bundle: ${review.id}`);
        logger.info(`   Run \`nuvira team review show ${review.id}\` to view`);
        logger.info(`   Run \`nuvira team review approve ${review.id}\` then \`nuvira team review merge ${review.id}\` to apply`);
        return;
      }

      writeFileSync(file, codeResult, 'utf-8');
      logger.success(`✅ Updated ${file}`);
    } catch (err) {
      spinner.fail('Edit failed');
      logger.error(String(err));
    }
  }
}
