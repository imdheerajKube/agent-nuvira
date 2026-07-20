import { createInterface } from 'node:readline';

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
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

// ─── Error Recovery Types ───────────────────────────────────────────────────

type ErrorRecoveryAction = 'retry' | 'switch' | 'cancel' | 'exit';

interface ErrorRecoveryResult {
  action: ErrorRecoveryAction;
  newType?: string;
  newProvider?: InferenceProvider;
  newModel?: string;
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
async function runDeveloperMode(
  goal: string,
  configManager: any,
  options?: { provider?: string; model?: string },
): Promise<void> {
  const spinner = ora({
    text: '📋 Planning...',
    spinner: 'dots',
  }).start();

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider: options?.provider,
      model: options?.model,
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

    let { type, provider } = await this.getProvider(mergedOpts);
    let model = mergedOpts.model;

    // In interactive mode (no prompt), show the model picker if no --model was specified
    if (!model && !prompt) {
      const picked = await this.showModelPicker();
      if (!picked) return;

      if (picked.provider !== type) {
        const resolved = resolveProvider(this.configManager, picked.provider);
        type = resolved.type;
        provider = resolved.provider;
      }
      model = picked.model;
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
      if (options?.dev || hasCreationIntent(prompt)) {
        const proceed = options?.dev || await promptDeveloperMode(prompt);
        if (proceed) {
          await runDeveloperMode(prompt, this.configManager, { provider: type, model });
          return;
        }
      }

      const result = await this.generateWithContext(provider, prompt, type, { ...options, model }, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    logger.highlight(`\n🧠 Buff Chat — ${provider.name}`);
    if (model) {
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
        if (result.newProvider) {
          type = result.newType!;
          provider = result.newProvider;
          model = result.newModel;
          effectiveModel = result.newModel || effectiveModelForHistory;
          effectiveModelForHistory = effectiveModel;
          logger.success(`✅ Switched to ${provider.name} / ${model}`);
          console.log('');
        }
        continue;
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

        if (recovery.action === 'switch' && recovery.newProvider) {
          type = recovery.newType!;
          provider = recovery.newProvider;
          effectiveModel = recovery.newModel || effectiveModelForHistory;
          model = effectiveModel; // keep model in sync for /info command
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
  ): Promise<{ exit: boolean; newType?: string; newProvider?: any; newModel?: string }> {
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
