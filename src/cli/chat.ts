import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { logger } from '../utils/logger.js';

/**
 * Chat command — interactive conversation with AI
 * buff chat [--provider local] [--model llama2]
 */
export class ChatCommand extends BaseCommand {
  create(): Command {
    const command = new Command('chat')
      .description('Start an interactive chat session with AI')
      .argument('[prompt]', 'Optional initial prompt')
      .option('-f, --file <path>', 'Include file content as context')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use')
      .option('--no-cache', 'Disable response caching')
      .action(async (prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean }) => {
        await this.execute(prompt, options || {});
      });

    return command;
  }

  private async execute(prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean }): Promise<void> {
    const { type, provider } = this.getProvider(options || {});

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      logger.info(`Run: buff config --help`);
      return;
    }

    // Determine if caching is enabled (default: enabled, disabled with --no-cache)
    const cacheEnabled = options?.cache !== false;

    // If prompt is provided directly, run one-shot
    if (prompt) {
      const result = await this.generateWithContext(provider, prompt, type, options, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    // Interactive mode
    logger.highlight(`\n🧠 Buff Chat — ${provider.name}`);
    logger.info(`Type your messages, or /help for commands, /exit to quit.\n`);

    const history: Array<{ role: string; content: string }> = [];

    while (true) {
      const answers = await inquirer.prompt<{ message: string }>([
        {
          type: 'input',
          name: 'message',
          message: 'You:',
          prefix: '',
        },
      ]);

      const message = answers.message.trim();

      if (!message) continue;

      if (message.startsWith('/')) {
        if (this.handleCommand(message, provider)) break;
        continue;
      }

      history.push({ role: 'user', content: message });

      // Build context from history
      const contextStr = history.map((h) => `${h.role}: ${h.content}`).join('\n');

      const spinner = ora('Thinking...').start();

      try {
        const cache = getCache();
        const model = options?.model || this.configManager.getProviderConfig(type).config.model || 'default';
        let result: string | null = null;

        // Check cache if enabled
        if (cacheEnabled) {
          result = await cache.get(message, model, type);
        }

        if (!result) {
          const context = new ContextParser().parseFromString(contextStr, 'chat');
          const fullPrompt = ContextParser.formatContext(context);

          result = await provider.generate(fullPrompt, options);

          // Cache the result if caching is enabled
          if (cacheEnabled) {
            await cache.set(message, result, model, type);
          }
        }

        spinner.stop();
        console.log(`\n${result}\n`);
        history.push({ role: 'assistant', content: result });
      } catch (err) {
        spinner.fail('Failed to generate response');
        logger.error(String(err));
      }
    }
  }

  /**
   * Handle interactive commands
   */
  private handleCommand(cmd: string, provider: any): boolean {
    switch (cmd.toLowerCase()) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return true;
      case '/help':
        console.log(`
Commands:
  /exit, /quit  Exit the chat
  /clear        Clear conversation history
  /info         Show provider info
  /help         Show this help
        `.trim());
        break;
      case '/clear':
        console.log('Conversation history cleared.');
        break;
      case '/info':
        console.log(`\n${provider.getInfo()}\n`);
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type /help`);
    }
    return false;
  }

  /**
   * Generate response with file context if needed
   */
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
