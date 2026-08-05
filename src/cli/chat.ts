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
import { assembleContext, retrievalOptionsFromConfig, recordRetrievalStats } from '../learning/retrieval.js';
import { getChatHistory } from '../context/history.js';
import { logger } from '../utils/logger.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { printOrchestrationResult } from './execute.js';
import { PipelineBoard } from './pipeline-board.js';
import { applyActiveModel } from './model.js';
import { ConfigManager } from '../config/manager.js';
import { InferenceProvider } from '../inference/interface.js';
import type { ProviderType } from '../config/types.js';
import { getProviderFallback, classifyFallbackError, isRetryableError, recordRegistrySuccess } from '../learning/provider-fallback.js';
import { recordActionFailure, RATE_LIMIT_EXCLUSION_MS, TRANSIENT_FAILURE_EXCLUSION_MS } from '../learning/failure-bookkeeping.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { refreshModelRegistry, spotCheckModel } from '../inference/model-probe.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { shouldConfirmFailover, promptFailoverChoice } from './failover-prompt.js';
import { runSingleShotAuto } from './failover-runner.js';

// ─── Error Recovery Types ───────────────────────────────────────────────────

type ErrorRecoveryAction = 'retry' | 'switch' | 'cancel' | 'exit';

/** The resolved-route shape returned by ChatCommand.routeMessageAuto(). */
type AutoRoutedMessage = {
  type: string;
  provider: InferenceProvider;
  model: string;
  ranked: string[];
  complexity: string;
  score: number;
};

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
    errorStr.includes('rate_limit') ||
    // Keep in sync with classifyFallbackError(): mid-session quota/limit
    // exhaustion (Gemini-style) must also offer "wait and retry".
    errorStr.includes('token limit') ||
    errorStr.includes('resource has been exhausted') ||
    errorStr.includes('insufficient_quota');

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

  // Live pipeline board — replaces the single spinner so the user sees every
  // step, parallel lanes, and the agent's "thinking" updates in real time.
  const board = new PipelineBoard();
  board.start(goal);

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider,
      model,
      // The board now supplies the live detail (task statuses, agent updates,
      // routing decisions) — no need for raw verbose log interleaving.
      verbose: false,
      // The board implements the spinner interface so interactive prompts
      // (rate limits, model pickers) can pause/resume the live view.
      spinner: board,
    });

    board.finish(result.success);
    console.log('');
    printOrchestrationResult(result);
  } catch (err) {
    board.finish(false);
    logger.error(String(err));
  }
}



// ─── ChatCommand ────────────────────────────────────────────────────────────

export class ChatCommand extends BaseCommand {
  private devModeAuto = false;

  /**
   * Providers that failed MID-SESSION in auto mode, with the expiry of their
   * exclusion (ms epoch):
   * - AUTH failures (expired token/key) are definitive → excluded for the whole
   *   session (Number.MAX_SAFE_INTEGER), so a provider whose key died mid-session
   *   is never re-picked (and re-failed) on a later message.
   * - RATE-LIMIT failures (429 / exhausted quota / "token limit exceeded") are
   *   usually TRANSIENT (a 1-minute quota window) → excluded only for a short
   *   cooldown, then re-admitted, so a throttled-but-working provider isn't
   *   blacklisted for the entire chat.
   * - 5xx/network errors are NOT session-excluded at all — they flow through
   *   the circuit breaker (which needs repeated failures before opening).
   * Cleared when the chat exits.
   */
  private sessionFailedProviders = new Map<string, number>();

  // RATE_LIMIT_EXCLUSION_MS + TRANSIENT_FAILURE_EXCLUSION_MS now live in
  // src/learning/failure-bookkeeping.ts (shared with every action) — see
  // recordActionFailure. Behavior is identical: same values, same semantics.

  /**
   * Providers that failed TRANSIENTLY this session (server/network/timeout/
   * unknown). Tracked separately from the exclusion map so that when a
   * transient exclusion EXPIRES, the provider is only re-admitted to routing
   * after a quick on-demand spot-check confirms it's actually back — recovery
   * is discovered in seconds, not by blindly failing into it again.
   */
  private sessionTransientFailedProviders = new Set<string>();

  /**
   * Whether the cold-start probe has fired this session. On a fresh registry
   * (no verified models yet) the FIRST auto pick fires a background
   * probe + spot-check so routing learns from real API data instead of
   * failing into dead ends — the fire-and-forget keeps the first message fast.
   */
  private coldStartProbeFired = false;

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
            // Success telemetry: verified models accumulate from real usage so
            // the registry's getUsableProviders() reflects what actually works.
            // Goes through the shared helper so the BUFF_TELEMETRY_ACTION env
            // override (VS Code extension spawns) re-tags IDE usage as
            // ide-chat instead of blending into terminal chat.
            recordRegistrySuccess(type, effectiveModel, 'chat');
            generationComplete = true;
          } catch (err) {
            console.log();
            // ── Auto mode: transparently fail over to the next candidate ──
            // failoverDeclined records that the user opted out of the automatic
            // swap (routing.promptOnFailover + 'manual') so the retryable-error
            // fallback chain below is skipped too — 'manual' must land on the
            // interactive recovery (handleInferenceError), never silently
            // auto-switch behind the user's back.
            let failoverDeclined = false;
            if (autoMode) {
              const failedProviderName = provider.name;
              autoFailedProviders.add(type);
              this.recordAutoProviderFailure(type, err, effectiveModel);
              // Failover routing itself can throw (e.g. an unresolvable plugin
              // provider) — never let that escape the catch and crash the
              // interactive loop; fall through to interactive recovery instead.
              let next: AutoRoutedMessage | null = null;
              try {
                next = await this.routeMessageAuto(message, [...autoFailedProviders]);
              } catch {
                next = null;
              }
              // Only switch to a provider that hasn't already failed this
              // message — otherwise we'd re-enter a known-broken provider
              // (e.g. the router's fallback returns the original winner).
              if (next && next.type !== type && !autoFailedProviders.has(next.type)) {
                // Opt-in confirmation (routing.promptOnFailover): when the
                // user wants control over failover, ask before switching.
                // 'manual' falls through to the standard interactive recovery
                // (picker etc.); 'switch' (or the silent default) adopts the
                // next-ranked candidate so auto mode never gets stuck.
                const declined =
                  shouldConfirmFailover(this.configManager.getAll()) &&
                  (await promptFailoverChoice(failedProviderName, next.provider.name, next.model)) === 'manual';
                if (declined) failoverDeclined = true;
                if (!declined) {
                  type = next.type;
                  provider = next.provider;
                  effectiveModel = next.model;
                  model = effectiveModel;
                  logger.warn(`   ⚠️ ${failedProviderName} failed — automatically switching to ${provider.name} (${effectiveModel})`);
                  console.log('');
                  continue;
                }
              }
            }
            // Try automatic fallback before prompting user
            const errorType = classifyFallbackError(err);
            if (!failoverDeclined && isRetryableError(errorType)) {
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
            // Success telemetry: verified models accumulate from real usage so
            // the registry's getUsableProviders() reflects what actually works.
            // Goes through the shared helper so the BUFF_TELEMETRY_ACTION env
            // override (VS Code extension spawns) re-tags IDE usage as
            // ide-chat instead of blending into terminal chat.
            recordRegistrySuccess(type, effectiveModel, 'chat');
            generationComplete = true;
          } catch (err) {
            spinner.stop();
            // ── Auto mode: transparently fail over to the next candidate ──
            // failoverDeclined records that the user opted out of the automatic
            // swap (routing.promptOnFailover + 'manual') so the retryable-error
            // fallback chain below is skipped too — 'manual' must land on the
            // interactive recovery (handleInferenceError), never silently
            // auto-switch behind the user's back.
            let failoverDeclined = false;
            if (autoMode) {
              const failedProviderName = provider.name;
              autoFailedProviders.add(type);
              this.recordAutoProviderFailure(type, err, effectiveModel);
              // Failover routing itself can throw (e.g. an unresolvable plugin
              // provider) — never let that escape the catch and crash the
              // interactive loop; fall through to interactive recovery instead.
              let next: AutoRoutedMessage | null = null;
              try {
                next = await this.routeMessageAuto(message, [...autoFailedProviders]);
              } catch {
                next = null;
              }
              // Only switch to a provider that hasn't already failed this
              // message — otherwise we'd re-enter a known-broken provider
              // (e.g. the router's fallback returns the original winner).
              if (next && next.type !== type && !autoFailedProviders.has(next.type)) {
                // Opt-in confirmation (routing.promptOnFailover): when the
                // user wants control over failover, ask before switching.
                // 'manual' falls through to the standard interactive recovery
                // (picker etc.); 'switch' (or the silent default) adopts the
                // next-ranked candidate so auto mode never gets stuck.
                const declined =
                  shouldConfirmFailover(this.configManager.getAll()) &&
                  (await promptFailoverChoice(failedProviderName, next.provider.name, next.model)) === 'manual';
                if (declined) failoverDeclined = true;
                if (!declined) {
                  type = next.type;
                  provider = next.provider;
                  effectiveModel = next.model;
                  model = effectiveModel;
                  logger.warn(`   ⚠️ ${failedProviderName} failed — automatically switching to ${provider.name} (${effectiveModel})`);
                  console.log('');
                  continue;
                }
              }
            }
            // Try automatic fallback before prompting user
            const errorType = classifyFallbackError(err);
            if (!failoverDeclined && isRetryableError(errorType)) {
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
  /**
   * Record an auto-mode provider failure so the session fails over instead of
   * getting stuck on a broken provider (the core of "auto routing should pick
   * another provider when the current one dies mid-session").
   *
   * Delegates to the SHARED failure-bookkeeping helper (Nuvira-Router M0.2
   * Stage A) so every action composes the exact same bookkeeping: session
   * exclusion (auth = whole session, rate-limit = short cooldown, transient =
   * short cooldown + re-verify marker), quota-ledger parking on rate-limit,
   * registry write-through (per-action telemetry), quota-timeline event, and
   * the shared circuit breaker. Best-effort: never throws.
   */
  private recordAutoProviderFailure(providerType: string, err: unknown, model?: string, apiKey?: string): void {
    recordActionFailure(
      {
        sessionFailedProviders: this.sessionFailedProviders,
        sessionTransientFailedProviders: this.sessionTransientFailedProviders,
      },
      providerType,
      err,
      this.configManager,
      { model, action: 'chat', apiKey },
    );
  }

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
  ): Promise<AutoRoutedMessage> {
    const routing = this.configManager.getAll().routing || {};
    // Feed the SHARED circuit breaker into the router so a provider that has
    // failed repeatedly (recorded by recordFailure below) is deprioritized by
    // scoring, not just skipped by the candidate walk.
    let circuitBreakerStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
    try {
      circuitBreakerStatus = getProviderFallback(this.configManager).getCircuitBreakerStatus();
    } catch {
      // Best-effort — routing must never crash on circuit-breaker bookkeeping
    }
    // Feed the QUOTA state too: a provider whose free-tier window is exhausted
    // (or was parked by a mid-session failure) sinks below healthy candidates
    // predictively, matching the orchestrator path. Read through the Model
    // Availability Registry's UNIFIED store — the registry mirrors the ledger's
    // parks + full token/reset telemetry, so the pick path reads ONE primary
    // sub-ms store (the ledger stays the writer, the registry the read model).
    let quotaStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
    try {
      quotaStatus = getModelRegistry().getRouterQuotaStatus(this.configManager);
    } catch {
      // Best-effort — routing must never crash on ledger bookkeeping
    }
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
        circuitBreakerStatus,
        quotaStatus,
        allowPaid: routing.allowPaid,
      },
      this.configManager,
    );

    // Walk the ranked candidates (winner first) and return the first available
    // provider — never a provider that lacks a key or endpoint. Providers that
    // already failed this message (excludeProviders) OR earlier in this session
    // with an ACTIVE exclusion (sessionFailedProviders, time-based) are skipped
    // so runtime failover walks forward instead of repeating a known-broken
    // provider. Expired rate-limit exclusions re-admit the provider.
    const exclusionTime = Date.now();
    const isActiveExclusion = (p: string) => {
      const expiresAt = this.sessionFailedProviders.get(p);
      return expiresAt !== undefined && expiresAt > exclusionTime;
    };
    // ── Cold-start probe (suggestion 3) ─────────────────────────────────────
    // A fresh registry has zero verified models → routing would fall back to
    // credential-based defaults and possibly fail into dead ends. Fire ONE
    // background probe+spot-check so the registry learns from real API data.
    if (!this.coldStartProbeFired) {
      this.coldStartProbeFired = true;
      try {
        const registry = getModelRegistry();
        if (registry.getUsableProviders().length === 0) {
          // Fire-and-forget: never block the first message on probe network I/O.
          void refreshModelRegistry(this.configManager, { spotCheck: true }).catch(() => {
            // Best-effort — cold-start probing must never break chat.
          });
        }
      } catch {
        // Best-effort.
      }
    }
    // ── Re-verify before re-admit (suggestion 2) ───────────────────────────
    // A provider whose TRANSIENT exclusion just expired is only re-admitted
    // after a quick on-demand spot-check confirms it's actually back — the
    // registry may still mark it unavailable (learned from the failure), and
    // blindly re-admitting would fail again on the very next message. Recovery
    // is discovered in SECONDS (a 1-token spot-check), not by re-failing.
    // NOTE: iterate a SNAPSHOT — the loop mutates the set (delete + re-add),
    // and Set iteration can revisit a re-added key, double-spot-checking.
    // Bounded: at most one spot-check per provider per 60s (the exclusion is
    // re-armed on failure), and only for registry-blocked providers.
    for (const providerType of [...this.sessionTransientFailedProviders]) {
      const expiresAt = this.sessionFailedProviders.get(providerType);
      // Skip still-active exclusions and already-cleared providers.
      if (expiresAt !== undefined && expiresAt > exclusionTime) continue;
      this.sessionTransientFailedProviders.delete(providerType);
      this.sessionFailedProviders.delete(providerType);
      try {
        const registry = getModelRegistry();
        // Only re-verify when the registry still believes the provider is dead
        // (unavailable/parked) — a healthy entry means it recovered already.
        if (!registry.getBlockedProviders().includes(providerType)) continue;
        const desired = getAutoRouter().resolveModel(providerType, 'chat', this.configManager);
        const outcome = await spotCheckModel(providerType, desired, this.configManager);
        // 'skipped' = the model was VERIFIED recently (within the spot-check
        // throttle) — that's healthy, so treat it as a pass too.
        if (outcome !== 'verified' && outcome !== 'skipped') {
          // Still down — keep it excluded for another transient window.
          this.sessionFailedProviders.set(
            providerType,
            Date.now() + TRANSIENT_FAILURE_EXCLUSION_MS,
          );
          this.sessionTransientFailedProviders.add(providerType);
        }
      } catch {
        // Best-effort — re-verification must never break routing.
      }
    }
    const excluded = new Set([
      ...excludeProviders,
      ...[...this.sessionFailedProviders.keys()].filter((p) => isActiveExclusion(p)),
    ]);
    // Predictive skip from the Model Availability Registry: providers whose
    // every tracked model the registry marks unavailable/quota-parked (learned
    // from real usage telemetry) are never even attempted — sub-ms, no
    // network, no failing call. This is what turns "fail gemini → fail nim →
    // local" on every message into "straight to local" after the first learn.
    let registryBlocked = new Set<string>();
    try {
      registryBlocked = new Set(getModelRegistry().getBlockedProviders());
    } catch {
      // Best-effort — registry bookkeeping must never break routing
    }
    const candidates = [
      decision.provider,
      ...decision.ranked
        .filter((r) => r.provider !== decision.provider)
        .map((r) => r.provider),
    ].filter((p) => !excluded.has(p) && !registryBlocked.has(p));

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

    // Nothing available — surface a usable pick so the caller's isAvailable()
    // gate shows a clear, actionable error. Prefer the best-ranked provider
    // that has NOT failed this session and is NOT registry-blocked (the
    // literal router winner could be a provider whose key just died —
    // re-surfacing it would re-fail and confuse the user instead of failing
    // over).
    const usableProvider =
      [decision.provider, ...decision.ranked.map((r) => r.provider)]
        .find((p) => !isActiveExclusion(p) && !registryBlocked.has(p)) || decision.provider;
    recordRoutingDecision({
      source: 'chat',
      agentType: 'chat',
      task: message,
      complexity: decision.complexity,
      provider: usableProvider,
      model: decision.model,
      score: decision.score,
    });
    const resolved = resolveProvider(this.configManager, usableProvider);
    const model = await resolveWorkingModel(resolved.provider, usableProvider, decision.model);
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
   *
   * Delegates to the SHARED single-shot runner (Nuvira-Router M0.2 Stage B) so
   * every action walks candidates identically — behavior-identical to the
   * previous inline walk (same order, same telemetry, same confirmation
   * semantics).
   */
  private async generateAutoWithFailover(
    message: string,
    prompt: string,
    options?: { file?: string; model?: string },
    cacheEnabled: boolean = true,
  ): Promise<string> {
    return runSingleShotAuto({
      action: 'chat',
      task: message,
      configManager: this.configManager,
      route: (excludeProviders) => this.routeMessageAuto(message, excludeProviders),
      generate: (provider, type, model, apiKey) =>
        this.generateWithContext(provider, prompt, type, { ...options, model, apiKey }, cacheEnabled),
      recordFailure: (type, model, err, apiKey) => this.recordAutoProviderFailure(type, err, model, apiKey),
    });
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
    options?: { file?: string; model?: string; apiKey?: string },
    cacheEnabled: boolean = true,
  ): Promise<string> {
    let fullPrompt = prompt;

    if (options?.file) {
      const parser = new ContextParser();
      const context = parser.parseFromFiles([options.file]);
      const contextStr = ContextParser.formatContext(context);
      // Retrieval hook: if the file is large, reduce it to the top-k
      // semantically-relevant chunks (saves tokens / stretches quotas).
      // Small files pass through untouched — zero overhead.
      const retrievalOpts = retrievalOptionsFromConfig(this.configManager);
      const { context: reduced, stats } = await assembleContext(prompt, [options.file], contextStr, retrievalOpts);
      recordRetrievalStats(stats);
      fullPrompt = `${reduced}\n\n## User Query\n${prompt}`;
    }

    let result: string;
    if (typeof provider.generateStream === 'function') {
      const chunks: string[] = [];
      await provider.generateStream(
        fullPrompt,
        options,
        (token: string) => {
          chunks.push(token);
        },
      );
      result = chunks.join('');
    } else {
      const spinner = ora(`Generating with ${provider.name}...`).start();
      try {
        result = await provider.generate(fullPrompt, options);
        spinner.stop();
      } catch (err) {
        spinner.fail('Generation failed');
        throw err;
      }
    }

    // Record telemetry success in the Model Availability Registry so verified
    // models accumulate from real usage — this is what populates
    // getUsableProviders() over time and lets the router restrict Auto picks
    // to providers we've actually seen work (no more routing into 404s).
    // Goes through the shared helper so the BUFF_TELEMETRY_ACTION env override
    // (VS Code extension spawns) re-tags IDE usage as ide-chat.
    recordRegistrySuccess(providerType, options?.model, 'chat');
    return result;
  }
}
