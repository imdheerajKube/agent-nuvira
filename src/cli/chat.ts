import { createInterface } from 'node:readline';

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { showModelPicker } from './model-picker.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { getChatHistory } from '../context/history.js';
import { logger } from '../utils/logger.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { printOrchestrationResult } from './execute.js';
import { applyActiveModel } from './model.js';
import { ConfigManager } from '../config/manager.js';
import { InferenceProvider } from '../inference/interface.js';
import type { ProviderType } from '../config/types.js';
import { getProviderFallback, classifyFallbackError, isRetryableError } from '../learning/provider-fallback.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { recordRoutingDecision } from '../learning/routing-history.js';

// ─── Error Recovery Types ───────────────────────────────────────────────────

type ErrorRecoveryAction = 'retry' | 'switch' | 'cancel' | 'exit';

interface ErrorRecoveryResult {
  action: ErrorRecoveryAction;
  newType?: string;
  newProvider?: InferenceProvider;
  newModel?: string;
  /** When true, re-enable auto routing for subsequent messages */
  auto?: boolean;
}

/**
 * Detect error type and prompt the user for a recovery action.
 * This is a standalone function (not a method) for clarity.
 */
async function handleInferenceError(
  err: unknown,
  providerName: string,
  configManager: ConfigManager,
): Promise<ErrorRecoveryResult> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorStr = errorMessage.toLowerCase();

  // ── Detect error type ────────────────────────────────────────────────
  const isRateLimit =
    errorStr.includes('429') ||
    errorStr.includes('rate limit') ||
    errorStr.includes('too many requests') ||
    errorStr.includes('quota exceeded') ||
    errorStr.includes('rate_limit');

  const isAuthError =
    errorStr.includes('401') ||
    errorStr.includes('403') ||
    errorStr.includes('unauthorized') ||
    errorStr.includes('forbidden') ||
    errorStr.includes('api key');

  const isServerError =
    errorStr.includes('500') ||
    errorStr.includes('502') ||
    errorStr.includes('503') ||
    errorStr.includes('server error') ||
    errorStr.includes('internal server');

  const isNetworkError =
    errorStr.includes('fetch failed') ||
    errorStr.includes('econnrefused') ||
    errorStr.includes('enotfound') ||
    errorStr.includes('econnreset') ||
    errorStr.includes('network') && !errorStr.includes('network policy');

  const errorType = isRateLimit
    ? '🚦 Rate limit'
    : isAuthError
      ? '🔑 Authentication'
      : isServerError
        ? '🔴 Server'
        : isNetworkError
          ? '🌐 Network'
          : '⚠️  API';

  // ── Show error summary ───────────────────────────────────────────────
  console.log('');
  logger.error(`${errorType} error from ${providerName}:`);
  const firstLine = errorMessage.split('\n')[0];
  logger.info(`  ${firstLine.slice(0, 200)}`);
  console.log('');

  // ── Build recovery choices ───────────────────────────────────────────
  const choices: Array<{ name: string; value: string }> = [];

  if (isRateLimit) {
    choices.push({ name: '⏳  Wait a moment and retry', value: 'retry' });
  }

  choices.push({ name: '🔄  Switch to a different provider/model', value: 'switch' });

  if (!isAuthError) {
    choices.push({ name: '🔁  Retry with same provider', value: 'retry' });
  }

  choices.push({ name: '❌  Cancel this message', value: 'cancel' });
  choices.push({ name: '🚪  Exit chat', value: 'exit' });

  const answer = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to proceed?',
      prefix: '⚡',
      choices,
    },
  ]);

  console.log('');

  if (answer.action === 'switch') {
    const picked = await showModelPicker(configManager);
    if (picked) {
      // ── Auto selected — re-enable auto routing instead of switching ──
      if (picked.provider === 'auto' || isAutoModel(picked.model)) {
        return { action: 'switch', auto: true };
      }
      const resolved = resolveProvider(configManager, picked.provider);
      return {
        action: 'switch',
        newType: resolved.type,
        newProvider: resolved.provider,
        newModel: picked.model,
      };
    }
    // Picker cancelled — fall through to cancel
    return { action: 'cancel' };
  }

  if (answer.action === 'retry' && isRateLimit) {
    logger.info('⏳  Waiting 3 seconds before retry...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return { action: answer.action as ErrorRecoveryAction };
}

/**
 * Patterns that indicate a user wants to CREATE or MODIFY files on disk
 * (as opposed to just asking a conversational question).
 */
const CREATION_PATTERNS = [
  /\b(?:create|write|make|build|generate|implement|scaffold)\b.*\b(?:file|program|script|app|function|class|module|component|page|route|api|endpoint|service|cli|tool|package|library|project)\b/i,
  /\b(?:add|create|write|make)\b.*\b(?:new)\b.*\b(?:file|function|class|feature)\b/i,
  /\b(?:set\s*up|scaffold|bootstrap|init|start)\b.*\b(?:project|app|module|package)\b/i,
  /\b(?:create|write)\b.*\bpython|javascript|typescript|go|rust|java|ruby|bash|shell|node\b.*\b(?:program|script|file)\b/i,
  /^\s*(?:create|write|make|build|generate)\s+(?:a|an|the)\s+/i,
];

function hasCreationIntent(message: string): boolean {
  return CREATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Prompt the user whether they want to switch to developer mode.
 */
async function promptDeveloperMode(message: string): Promise<boolean> {
  console.log('');
  logger.info('💡 I noticed you\'re asking me to create something!');
  logger.info('   I can either:');
  logger.info('     1. 💬  Just show you the code as text (chat mode)');
  logger.info('     2. 🏗️  Actually create the files in your project (developer mode)');
  console.log('');

  const answer = await inquirer.prompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message: 'How would you like me to handle this?',
      prefix: '🔧',
      choices: [
        { name: '🏗️  Developer mode — Create the files in my project directory', value: 'dev' },
        { name: '💬  Chat mode — Just show me the code as text', value: 'chat' },
      ],
    },
  ]);

  console.log('');
  return answer.choice === 'dev';
}

/**
 * Execute the multi-agent pipeline for a user's goal.
 */
export async function runDeveloperMode(
  goal: string,
  configManager: any,
  options?: { provider?: string; model?: string },
): Promise<void> {
  // Guard: never hand a literal 'auto' provider/model to the orchestrator.
  // Resolve via the AutoModelRouter so developer mode uses a real model.
  let provider = options?.provider;
  let model = options?.model;
  if (isAutoProvider(provider) || isAutoModel(model)) {
    const decision = getAutoRouter().resolve(
      'chat',
      goal,
      { verbose: true, useRuntimeStats: true },
      configManager,
    );
    const resolved = resolveProvider(configManager, decision.provider);
    provider = resolved.type;
    // Model health: the router resolves the provider's PINNED model, which can
    // be stale (e.g. deprecated gemini-2.0-flash-exp → 404). Validate against
    // the provider's live list and repair to a verified-working model first.
    model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
  }

  const spinner = ora({
    text: '📋 Planning...',
    spinner: 'dots',
  }).start();

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider,
      model,
      verbose: true,
      spinner: {
        stop: () => spinner.stop(),
        start: (text?: string) => spinner.start(text),
      },
    });

    spinner.stop();
    console.log('');
    printOrchestrationResult(result);
  } catch (err) {
    spinner.fail('Developer mode execution failed');
    logger.error(String(err));
  }
}



// ─── ChatCommand ────────────────────────────────────────────────────────────

export class ChatCommand extends BaseCommand {
  private devModeAuto = false;

  create(): Command {
    const command = new Command('chat')
      .description('Start an interactive chat session with AI')
      .argument('[prompt]', 'Optional initial prompt')
      .option('-f, --file <path>', 'Include file content as context')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use (if omitted, an interactive picker will appear)')
      .option('--no-cache', 'Disable response caching')
      .option('-d, --dev', 'Skip the prompt and always use developer mode for creation requests', false)
      .action(async (prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean }) => {
        await this.execute(prompt, options || {});
      });

    return command;
  }

  private async execute(prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean }): Promise<void> {
    // Apply the active model state from `buff model switch` as defaults
    const activeOpts = applyActiveModel({ provider: options?.provider, model: options?.model });
    const mergedOpts = { ...options, provider: activeOpts.provider, model: activeOpts.model };

    // ── Auto routing mode: agent decides the best provider/model per message ──
    let autoMode = isAutoModel(mergedOpts.model) || isAutoProvider(mergedOpts.provider);
    let { type, provider } = autoMode
      ? await this.getProvider({})
      : await this.getProvider(mergedOpts);
    let model = mergedOpts.model;

    // In interactive mode (no prompt), show the model picker if no --model was specified
    if (!model && !prompt) {
      const picked = await this.showModelPicker();
      if (!picked) return;

      // ── Auto picked — enable per-message routing ──────────────────────────
      // NEVER hand 'auto' to resolveProvider(): it would hit the "Unknown
      // provider 'auto'" fallback and silently pick the default provider
      // (e.g. OpenRouter with no key → 401). Auto is a routing directive, so
      // we set autoMode and resolve a concrete route below instead.
      if (picked.provider === 'auto' || isAutoModel(picked.model)) {
        autoMode = true;
      } else {
        if (picked.provider !== type) {
          const resolved = resolveProvider(this.configManager, picked.provider);
          type = resolved.type;
          provider = resolved.provider;
        }
        model = picked.model;
      }
    }

    // ── Auto mode: resolve a concrete initial route for the header + gate ──
    // (Each real message re-routes via routeMessageAuto before generating.)
    if (autoMode) {
      const routed = await this.routeMessageAuto('chat session');
      type = routed.type;
      provider = routed.provider;
      model = routed.model;
    }

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      logger.info(`Run: agent-baba-d config --help`);
      return;
    }

    // ── Setup SIGINT (Ctrl+C) handler for graceful exit ──────────────
    // When readline is active (user is typing), Ctrl+C byte is consumed by readline's
    // raw mode — the process-level SIGINT never fires. So we put the double-press
    // logic inside readline's SIGINT handler instead (see readMultiLineInput).
    //
    // This process-level handler fires when the user is NOT in readline (e.g., during
    // API calls). A single Ctrl+C during an API call aborts it immediately.
    const sigintHandler = () => {
      console.log('\n');
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    const cacheEnabled = options?.cache !== false;

    if (prompt) {
      // ── Auto routing for single-shot prompts ────────────────────────────
      if (autoMode) {
        const routed = await this.routeMessageAuto(prompt);
        type = routed.type;
        provider = routed.provider;
        model = routed.model;
      }

      if (options?.dev || hasCreationIntent(prompt)) {
        const proceed = options?.dev || await promptDeveloperMode(prompt);
        if (proceed) {
          await runDeveloperMode(prompt, this.configManager, { provider: type, model });
          return;
        }
      }

      // Auto mode fails over across the ranked candidates so a broken provider
      // (deprecated model, exhausted quota) never crashes the CLI — the next
      // working candidate answers instead. Non-auto uses the pinned provider.
      const result = autoMode
        ? await this.generateAutoWithFailover(prompt, prompt, options, cacheEnabled)
        : await this.generateWithContext(provider, prompt, type, { ...options, model }, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    logger.highlight(`\n🧠 Buff Chat — ${autoMode ? '🤖 Auto routing' : provider.name}`);
    if (autoMode) {
      logger.info('Model: auto (best provider/model picked per message)');
    } else if (model) {
      logger.info(`Model: ${model}`);
    }
    logger.info(`Type your messages, or /help for commands, /exit to quit.`);
    logger.info(`💡 Tip: Ask me to "create" something and I'll offer to switch to developer mode!\n`);

    const history: Array<{ role: string; content: string }> = [];
    let effectiveModelForHistory = model || this.configManager.getProviderConfig(type as ProviderType).config.model || 'default';
    let effectiveModel = effectiveModelForHistory;
    this.devModeAuto = false;

    while (true) {
      const message = await this.readMultiLineInput('You:');
      if (!message) continue;

      if (message.startsWith('/')) {
        const result = await this.handleCommand(message, provider, model, type);
        if (result.exit) break;
        if (result.auto) {
          autoMode = true;
          logger.success('🤖 Auto routing enabled — agent picks the best model per message');
          console.log('');
        } else if (result.newProvider) {
          type = result.newType!;
          provider = result.newProvider;
          model = result.newModel;
          effectiveModel = result.newModel || effectiveModelForHistory;
          effectiveModelForHistory = effectiveModel;
          autoMode = false; // explicit picker choice overrides auto routing
          logger.success(`✅ Switched to ${provider.name} / ${model}`);
          console.log('');
        }
        continue;
      }

      // ── Auto routing: pick the best provider/model for this message ──────
      // Runs BEFORE the dev-mode check so a creation request in auto mode uses
      // the routed provider/model — never a literal 'auto' or a stale default.
      if (autoMode) {
        const routed = await this.routeMessageAuto(message);
        type = routed.type;
        provider = routed.provider;
        effectiveModel = routed.model;
        effectiveModelForHistory = effectiveModel;
        model = effectiveModel;
      }

      if (hasCreationIntent(message) || this.devModeAuto) {
        const proceed = this.devModeAuto || await promptDeveloperMode(message);
        if (proceed) {
          await runDeveloperMode(message, this.configManager, { provider: type, model });
          const continueAnswer = await inquirer.prompt<{ cont: string }>([
            {
              type: 'input',
              name: 'cont',
              message: 'Press Enter to continue chatting, or type /exit to quit:',
              prefix: '',
            },
          ]);
          if (continueAnswer.cont.trim().toLowerCase() === '/exit' || continueAnswer.cont.trim().toLowerCase() === '/quit') {
            console.log('Goodbye!');
            break;
          }
          continue;
        }
      }

      history.push({ role: 'user', content: message });

      const contextStr = history.map((h) => `${h.role}: ${h.content}`).join('\n');
      const cache = getCache();

      if (cacheEnabled) {
        const cachedResult = await cache.get(message, effectiveModel, type);
        if (cachedResult) {
          console.log(`\n${cachedResult}\n`);
          history.push({ role: 'assistant', content: cachedResult });
          continue;
        }
      }

      const context = new ContextParser().parseFromString(contextStr, 'chat');
      const fullPrompt = ContextParser.formatContext(context);

      // ── Generation retry loop ────────────────────────────────────
      // Wraps both streaming and non-streaming paths with error recovery.
      // On error, the user can retry, switch provider, cancel, or exit.
      // History is preserved so switching providers is seamless.
      let generationComplete = false;
      let recovery: ErrorRecoveryResult | null = null;
      // Auto mode tracks providers that already failed for THIS message so
      // failover walks forward through the ranked candidates, never repeating
      // a provider that just errored.
      const autoFailedProviders = new Set<string>();

      while (!generationComplete) {
        if (typeof provider.generateStream === 'function') {
          // ── Streaming path ───────────────────────────────────────
          console.log();
          try {
            const result = await provider.generateStream(
              fullPrompt,
              { ...options, model: effectiveModel },
              (token: string) => {
                process.stdout.write(token);
              },
            );
            console.log('\n');

            if (cacheEnabled) {
              await cache.set(message, result, effectiveModel, type);
            }

            history.push({ role: 'assistant', content: result });
            generationComplete = true;
          } catch (err) {
            console.log();
            // ── Auto mode: transparently fail over to the next candidate ──
            if (autoMode) {
              const failedProviderName = provider.name;
              autoFailedProviders.add(type);
              const next = await this.routeMessageAuto(message, [...autoFailedProviders]);
              // Only switch to a provider that hasn't already failed this
              // message — otherwise we'd re-enter a known-broken provider
              // (e.g. the router's fallback returns the original winner).
              if (next.type !== type && !autoFailedProviders.has(next.type)) {
                type = next.type;
                provider = next.provider;
                effectiveModel = next.model;
                model = effectiveModel;
                logger.warn(`   ⚠️ ${failedProviderName} failed — automatically switching to ${provider.name} (${effectiveModel})`);
                console.log('');
                continue;
              }
            }
            // Try automatic fallback before prompting user
            const errorType = classifyFallbackError(err);
            if (isRetryableError(errorType)) {
              try {
                const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
                logger.warn(`🔄 Attempting automatic failover to next provider...`);
                console.log('');
                const fallbackResult = await fallback.callWithFallback(
                  type,
                  async (fbProvider, fbType) => {
                    const fbOpts = { ...options, model: effectiveModel };
                    let result = '';
                    if (typeof fbProvider.generateStream === 'function') {
                      const chunks: string[] = [];
                      await fbProvider.generateStream(fullPrompt, fbOpts, (t: string) => { chunks.push(t); process.stdout.write(t); });
                      result = chunks.join('');
                    } else {
                      result = await fbProvider.generate(fullPrompt, fbOpts);
                    }
                    return result;
                  },
                  { context: 'chat', label: 'Chat response' },
                );

                console.log('\n');
                if (cacheEnabled) {
                  await cache.set(message, fallbackResult.response, effectiveModel, fallbackResult.provider);
                }
                history.push({ role: 'assistant', content: fallbackResult.response });

                // Update current provider/model to the successful fallback
                const resolved = resolveProvider(this.configManager, fallbackResult.provider);
                type = resolved.type;
                provider = resolved.provider;
                // Don't update effectiveModel since we want to keep the original model
                if (fallbackResult.attempts > 1) {
                  logger.success(`✅ Auto-fallback: switched to ${fallbackResult.provider} (attempt ${fallbackResult.attempts})`);
                  console.log('');
                }

                generationComplete = true;
                continue;
              } catch {
                // Auto-fallback exhausted — fall through to interactive recovery
              }
            }
            recovery = await handleInferenceError(
              err,
              provider.name,
              this.configManager,
            );
          }
        } else {
          // ── Non-streaming path ───────────────────────────────────
          const spinner = ora('Thinking...').start();
          try {
            const result = await provider.generate(fullPrompt, { ...options, model: effectiveModel });
            spinner.stop();
            console.log(`\n${result}\n`);

            if (cacheEnabled) {
              await cache.set(message, result, effectiveModel, type);
            }

            history.push({ role: 'assistant', content: result });
            generationComplete = true;
          } catch (err) {
            spinner.stop();
            // ── Auto mode: transparently fail over to the next candidate ──
            if (autoMode) {
              const failedProviderName = provider.name;
              autoFailedProviders.add(type);
              const next = await this.routeMessageAuto(message, [...autoFailedProviders]);
              // Only switch to a provider that hasn't already failed this
              // message — otherwise we'd re-enter a known-broken provider
              // (e.g. the router's fallback returns the original winner).
              if (next.type !== type && !autoFailedProviders.has(next.type)) {
                type = next.type;
                provider = next.provider;
                effectiveModel = next.model;
                model = effectiveModel;
                logger.warn(`   ⚠️ ${failedProviderName} failed — automatically switching to ${provider.name} (${effectiveModel})`);
                console.log('');
                continue;
              }
            }
            // Try automatic fallback before prompting user
            const errorType = classifyFallbackError(err);
            if (isRetryableError(errorType)) {
              try {
                const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
                const fallbackResult = await fallback.callWithFallback(
                  type,
                  async (fbProvider, fbType) => {
                    return await fbProvider.generate(fullPrompt, { ...options, model: effectiveModel });
                  },
                  { context: 'chat', label: 'Chat response' },
                );

                spinner.stop();
                console.log(`\n${fallbackResult.response}\n`);

                if (cacheEnabled) {
                  await cache.set(message, fallbackResult.response, effectiveModel, fallbackResult.provider);
                }
                history.push({ role: 'assistant', content: fallbackResult.response });

                const resolved = resolveProvider(this.configManager, fallbackResult.provider);
                type = resolved.type;
                provider = resolved.provider;
                if (fallbackResult.attempts > 1) {
                  logger.success(`✅ Auto-fallback: switched to ${fallbackResult.provider} (attempt ${fallbackResult.attempts})`);
                  console.log('');
                }

                generationComplete = true;
                continue;
              } catch {
                spinner.stop();
                // Auto-fallback exhausted — fall through to interactive recovery
              }
            }
            recovery = await handleInferenceError(
              err,
              provider.name,
              this.configManager,
            );
          }
        }

        // ── Handle recovery action ────────────────────────────────
        if (!recovery) {
          // No recovery needed — generation succeeded or wasn't attempted
          continue;
        }

        if (recovery.action === 'retry') {
          continue; // retry with the same provider/model
        }

        if (recovery.action === 'switch' && recovery.auto) {
          // Auto routing re-enabled via the picker's Auto option.
          // Resolve the route inline (the per-message block already ran) so
          // this message retries with the routed provider, not the failed one.
          autoMode = true;
          const routed = await this.routeMessageAuto(message);
          type = routed.type;
          provider = routed.provider;
          effectiveModel = routed.model;
          model = effectiveModel;
          logger.success('🤖 Auto routing enabled — agent picks the best model per message');
          console.log('');
          continue; // retry this message with auto routing
        }

        if (recovery.action === 'switch' && recovery.newProvider) {
          type = recovery.newType!;
          provider = recovery.newProvider;
          effectiveModel = recovery.newModel || effectiveModelForHistory;
          model = effectiveModel; // keep model in sync for /info command
          autoMode = false; // explicit picker choice overrides auto routing
          logger.success(`✅ Switched to ${provider.name} / ${effectiveModel}`);
          console.log('');
          continue; // retry with the new provider
        }

        if (recovery.action === 'exit') {
          // Clean exit — outer return handles history storage
          generationComplete = true;
          break;
        }

        // Cancel: remove the unanswered user message from history
        history.pop();
        console.log('');
        logger.info('Message cancelled. You can type a new one.');
        console.log('');
        generationComplete = true;
      }

      if (recovery?.action === 'exit') {
        console.log('Goodbye!');
        break;
      }
    }

    // Cleanup SIGINT handler
    process.off('SIGINT', sigintHandler);

    // Store chat session in history when exiting
    if (history.length > 0) {
      try {
        const historyMessages = history.map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
          timestamp: Date.now(),
        }));
        const chatHistory = getChatHistory();
        const sessionId = chatHistory.storeSession(historyMessages, type, effectiveModelForHistory);
        logger.debug(`Chat session stored: ${sessionId}`);
      } catch (err) {
        // Non-critical — history storage failure shouldn't affect user experience
        logger.debug(`Failed to store chat session: ${err}`);
      }
    }

    // Actually exit the process — Commander keeps the event loop alive otherwise
    process.exit(0);
  }

  /**
   * Show a categorized model picker that groups models by capability.
   *
   * Example output:
   *
   *   🎯  Available Models
   *
   *   💬 Chat (General conversation)
   *    1. 🟢  llama-3.3-70b-versatile  ⭐ Best all-rounder — strong at...
   *    2. 🟢  gemma2-9b-it
   *
   *   💻 Code (Code generation, programming)
   *    3. 🔷  gemini-2.0-flash-exp  ⭐ Latest Gemini — fast, multimodal...
   *
   *   Enter a number (0-8):
   */
  private async showModelPicker(): Promise<{ provider: string; model: string } | null> {
    return showModelPicker(this.configManager);
  }

  /**
   * Resolve the best provider/model for a message via the AutoModelRouter.
   * Returns the routed type/provider/model; the caller applies them to the
   * active session state.
   */
  /**
   * Resolve the best provider/model for a message via the AutoModelRouter.
   *
   * ONLY AVAILABLE providers are returned: the router itself already excludes
   * unconfigured providers (no API key), and this method additionally walks
   * the ranked candidates and picks the first one whose isAvailable() passes —
   * so Auto routing never sends a request to a provider that would 401.
   */
  private async routeMessageAuto(
    message: string,
    excludeProviders: string[] = [],
  ): Promise<{ type: string; provider: InferenceProvider; model: string; ranked: string[]; complexity: string; score: number }> {
    const routing = this.configManager.getAll().routing || {};
    const decision = getAutoRouter().resolve(
      'chat',
      message,
      {
        verbose: process.env.BUFF_DEBUG === 'true',
        useRuntimeStats: true,
        useBandit: routing.bandit === true,
        maxCostUsd: routing.maxCostUsd,
        minSpeed: routing.minSpeed,
        minReasoning: routing.minReasoning,
        escalationMinSamples: routing.escalationMinSamples,
      },
      this.configManager,
    );

    // Walk the ranked candidates (winner first) and return the first available
    // provider — never a provider that lacks a key or endpoint. Providers that
    // already failed this message (excludeProviders) are skipped so runtime
    // failover walks forward instead of repeating the failing provider.
    const candidates = [
      decision.provider,
      ...decision.ranked
        .filter((r) => r.provider !== decision.provider)
        .map((r) => r.provider),
    ].filter((p) => !excludeProviders.includes(p));

    for (const candidate of candidates) {
      try {
        const resolved = resolveProvider(this.configManager, candidate);
        if (await resolved.provider.isAvailable()) {
          const desired = candidate === decision.provider
            ? decision.model
            : getAutoRouter().resolveModel(candidate, 'chat', this.configManager);
          // Model health: only use models that actually exist on the provider.
          // A provider's pinned config.model can be deprecated or a placeholder
          // (e.g. gemini-2.0-flash-exp → 404) — repair to a live model.
          const model = await resolveWorkingModel(resolved.provider, candidate, desired);
          // Record the actually-used route for the dashboard audit trail
          recordRoutingDecision({
            source: 'chat',
            agentType: 'chat',
            task: message,
            complexity: decision.complexity,
            provider: candidate,
            model,
            score: decision.score,
          });
          return {
            type: resolved.type,
            provider: resolved.provider,
            model,
            ranked: candidates,
            complexity: decision.complexity,
            score: decision.score,
          };
        }
      } catch {
        // Unresolvable candidate — try the next one
      }
    }

    // Nothing available — surface the router's pick so the caller's
    // isAvailable() gate shows a clear, actionable error.
    recordRoutingDecision({
      source: 'chat',
      agentType: 'chat',
      task: message,
      complexity: decision.complexity,
      provider: decision.provider,
      model: decision.model,
      score: decision.score,
    });
    const resolved = resolveProvider(this.configManager, decision.provider);
    const model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
    return {
      type: resolved.type,
      provider: resolved.provider,
      model,
      ranked: candidates,
      complexity: decision.complexity,
      score: decision.score,
    };
  }

  /**
   * Generate a single-shot response in auto mode with runtime failover.
   *
   * The auto router picks the best provider, but a provider's key/model can
   * still fail at generation time (quota exhausted → 429, deprecated model →
   * 404 — Gemini's listModels() lists models the key can't actually use).
   * This walks the ranked candidates and returns the first successful response,
   * so Auto routing NEVER crashes the CLI — it always answers from a working
   * provider.
   */
  private async generateAutoWithFailover(
    message: string,
    prompt: string,
    options?: { file?: string; model?: string },
    cacheEnabled: boolean = true,
  ): Promise<string> {
    const first = await this.routeMessageAuto(message);
    const attempted = new Set<string>();
    let lastError: unknown = new Error(`No auto-routed provider succeeded for: ${message.slice(0, 80)}`);

    for (const candidateType of [first.type, ...first.ranked]) {
      if (attempted.has(candidateType)) continue;
      attempted.add(candidateType);
      try {
        const resolved = resolveProvider(this.configManager, candidateType);
        if (!(await resolved.provider.isAvailable())) {
          logger.warn(`   ⚠️ ${candidateType} is not available — trying the next auto candidate...`);
          continue;
        }
        const desired = candidateType === first.type
          ? first.model
          : getAutoRouter().resolveModel(candidateType, 'chat', this.configManager);
        const model = await resolveWorkingModel(resolved.provider, candidateType, desired);
        const result = await this.generateWithContext(resolved.provider, prompt, resolved.type, { ...options, model }, cacheEnabled);
        if (candidateType !== first.type) {
          logger.success(`✅ Auto failover: answered from ${resolved.provider.name} (${model}) after ${first.type} failed`);
          // Keep the dashboard audit trail accurate: the winner's route was
          // recorded by the initial routeMessageAuto, but the actual answer
          // came from this candidate.
          recordRoutingDecision({
            source: 'chat',
            agentType: 'chat',
            task: message,
            complexity: first.complexity,
            provider: candidateType,
            model,
            score: first.score,
          });
        }
        return result;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`   ⚠️ ${candidateType} failed (${msg.slice(0, 160)}) — trying the next auto candidate...`);
      }
    }

    throw lastError;
  }

  /**
   * Read multi-line input from stdin using readline.
   *
   * - First line prompt: "You: "
   * - Continuation lines prompt: "  > "
   * - Pressing Enter with no text on the first line re-prompts
   * - An empty line after non-empty input submits the message
   * - This allows pasting multi-line text (each line collected), then Enter to submit
   */
  private readMultiLineInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: prompt + ' ',
        // Don't let readline handle SIGINT — we handle it at process level
        terminal: true,
      });

      const lines: string[] = [];
      let isFirstLine = true;

      // Handle SIGINT on readline:
      // - If user was typing: cancel input and re-prompt
      // - If on empty line: first press shows warning, second press within 2s exits
      let rlSigintCount = 0;
      let rlSigintTimer: ReturnType<typeof setTimeout> | null = null;
      rl.on('SIGINT', () => {
        if (lines.length > 0 || !isFirstLine) {
          // User was typing something — cancel input and re-prompt
          lines.length = 0;
          isFirstLine = true;
          if (rlSigintTimer) clearTimeout(rlSigintTimer);
          rlSigintCount = 0;
          rl.setPrompt(prompt + ' ');
          rl.prompt();
          return;
        }
        // No input yet — handle double-press
        rlSigintCount++;
        if (rlSigintCount >= 2) {
          // Second press — exit cleanly
          console.log('');
          lines.push('/exit');
          rl.close();
          return;
        }
        // First press — show warning
        console.log('\n\n⚠️  Press Ctrl+C again to exit, or type /exit to quit.\n');
        rl.prompt(true);
        if (rlSigintTimer) clearTimeout(rlSigintTimer);
        rlSigintTimer = setTimeout(() => {
          rlSigintCount = 0;
        }, 2000);
      });

      rl.on('line', (line) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line === '') {
            // Just pressed Enter on first line with no text — re-prompt
            rl.prompt();
            isFirstLine = true;
            return;
          }
          lines.push(line);
          // Commands (starting with '/') should submit immediately — no continuation needed
          if (line.startsWith('/')) {
            rl.close();
            return;
          }
          rl.setPrompt('  > ');
          rl.prompt();
        } else {
          if (line === '') {
            // Empty line on continuation — submit the full message
            rl.close();
          } else {
            lines.push(line);
            rl.prompt();
          }
        }
      });

      rl.on('close', () => {
        resolve(lines.join('\n'));
      });

      rl.prompt();
    });
  }

  private async handleCommand(
    cmd: string,
    provider: any,
    model: string | undefined,
    currentType: string,
  ): Promise<{ exit: boolean; newType?: string; newProvider?: any; newModel?: string; auto?: boolean }> {
    switch (cmd.toLowerCase()) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return { exit: true };
      case '/help':
        console.log(`
Commands:
  /exit, /quit          Exit the chat
  /clear                Clear conversation history
  /info                 Show provider & model info
  /help                 Show this help
  /dev                  Toggle developer mode (auto-create files)
  /search <query>       Search past conversations by keyword
  /model                Switch providers/models mid-session
        `.trim());
        return { exit: false };
      case '/clear':
        console.log('Conversation history cleared.');
        return { exit: false };
      case '/info':
        console.log(`\n${provider.getInfo()}${model ? `\n  Model: ${model}` : ''}\n`);
        return { exit: false };
      case '/dev':
        this.devModeAuto = !this.devModeAuto;
        if (this.devModeAuto) {
          logger.success('✅ Developer mode ACTIVATED — all messages will auto-create files.');
        } else {
          logger.info('ℹ️  Developer mode DEACTIVATED — creation requests will ask for confirmation.');
        }
        return { exit: false };
      case '/model': {
        const picked = await showModelPicker(this.configManager);
        if (!picked) {
          logger.info('Model selection cancelled.');
          return { exit: false };
        }
        // ── Auto selected — enable auto routing ──────────────────────
        if (picked.provider === 'auto' || isAutoModel(picked.model)) {
          return { exit: false, auto: true };
        }
        const resolved = resolveProvider(this.configManager, picked.provider);
        if (resolved.type !== currentType || picked.model !== model) {
          return {
            exit: false,
            newType: resolved.type,
            newProvider: resolved.provider,
            newModel: picked.model,
          };
        }
        return { exit: false };
      }
      case '/search': {
        let searchQuery = cmd.slice(8).trim();
        let useSemantic = false;

        if (searchQuery.startsWith('--semantic ')) {
          useSemantic = true;
          searchQuery = searchQuery.slice(11).trim();
        }

        if (!searchQuery) {
          console.log('Usage:');
          console.log('  /search <query>               Keyword search (default)');
          console.log('  /search --semantic <query>    Semantic search (using local embeddings)');
          console.log('');
          console.log('Examples:');
          console.log('  /search authentication');
          console.log('  /search --semantic how to add JWT auth to Express');
          return { exit: false };
        }

        const chatHistory = getChatHistory();
        const results = useSemantic
          ? await chatHistory.searchSemantic(searchQuery, 5)
          : chatHistory.search(searchQuery, 5);

        if (results.length === 0) {
          logger.info(`No past conversations found matching "${searchQuery}".`);
        } else {
          const mode = useSemantic ? '🧠' : '🔍';
          const modeLabel = useSemantic ? ' (semantic)' : '';
          logger.highlight(`${mode} Past conversations matching "${searchQuery}"${modeLabel}:`);
          console.log('');
          for (const session of results) {
            console.log(chatHistory.formatSessionSummary(session));
          }
          console.log('');
          logger.info('Use `buff history show <session-id>` to view a full conversation.');
        }
        return { exit: false };
      }
      default:
        console.log(`Unknown command: ${cmd}. Type /help`);
        return { exit: false };
    }
  }

  private async generateWithContext(
    provider: any,
    prompt: string,
    providerType: string,
    options?: { file?: string; model?: string },
    cacheEnabled: boolean = true,
  ): Promise<string> {
    let fullPrompt = prompt;

    if (options?.file) {
      const parser = new ContextParser();
      const context = parser.parseFromFiles([options.file]);
      const contextStr = ContextParser.formatContext(context);
      fullPrompt = `${contextStr}\n\n## User Query\n${prompt}`;
    }

    if (typeof provider.generateStream === 'function') {
      const chunks: string[] = [];
      await provider.generateStream(
        fullPrompt,
        options,
        (token: string) => {
          chunks.push(token);
        },
      );
      return chunks.join('');
    }

    const spinner = ora(`Generating with ${provider.name}...`).start();

    try {
      const result = await provider.generate(fullPrompt, options);
      spinner.stop();
      return result;
    } catch (err) {
      spinner.fail('Generation failed');
      throw err;
    }
  }
}
