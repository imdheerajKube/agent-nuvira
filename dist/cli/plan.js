import { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { logger } from '../utils/logger.js';
import { showModelPicker } from './model-picker.js';
import { resolveProvider } from './router.js';
import { getProviderFallback, classifyFallbackError, isRetryableError } from '../learning/provider-fallback.js';
/**
 * Plan command — generate implementation plans for code changes
 * buff plan <directory> [--provider openrouter] [--task "add user auth"]
 */
export class PlanCommand extends BaseCommand {
    create() {
        const command = new Command('plan')
            .description('Generate an implementation plan for a codebase task')
            .argument('[target]', 'File or directory to plan for', '.')
            .option('-t, --task <text>', 'Description of the task to plan')
            .option('-p, --provider <provider>', 'Inference provider')
            .option('-m, --model <model>', 'Model to use')
            .option('-v, --verbose', 'Show full context being sent to the model')
            .action(async (target, options) => {
            await this.execute(target, options || {});
        });
        return command;
    }
    async execute(target, options) {
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
        let contextStr;
        const spinner = ora('Analyzing codebase...').start();
        try {
            if (existsSync(target) && statSync(target).isDirectory()) {
                const context = await parser.parseFromDirectory(target);
                contextStr = ContextParser.formatContext(context);
            }
            else if (existsSync(target)) {
                const context = parser.parseFromFiles([target]);
                contextStr = ContextParser.formatContext(context);
            }
            else {
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
            // ── Generate with auto-fallback ─────────────────────────────────
            let result;
            try {
                result = await provider.generate(prompt, options);
            }
            catch (err) {
                // Try automatic fallback to another provider before giving up
                const errorType = classifyFallbackError(err);
                if (isRetryableError(errorType)) {
                    try {
                        const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
                        logger.warn(`🔄 ${provider.name} failed — attempting automatic failover...`);
                        const fallbackResult = await fallback.callWithFallback(type, async (fbProvider) => fbProvider.generate(prompt, options), { context: 'plan', label: `Plan: ${task.slice(0, 60)}` });
                        result = fallbackResult.response;
                        if (fallbackResult.attempts > 1) {
                            logger.success(`✅ Auto-fallback: switched to ${fallbackResult.provider}`);
                        }
                    }
                    catch {
                        throw err; // Throw the original error — fallback exhausted
                    }
                }
                else {
                    throw err; // Not retryable — throw immediately
                }
            }
            spinner.stop();
            console.log(`\n${'='.repeat(60)}`);
            logger.highlight(`📋 Implementation Plan`);
            console.log(`${'='.repeat(60)}\n`);
            console.log(result);
            console.log(`\n${'='.repeat(60)}`);
            logger.info(`Generated by ${provider.name}`);
        }
        catch (err) {
            spinner.fail('Planning failed');
            const errorMessage = err instanceof Error ? err.message : String(err);
            const isAuthError = errorMessage.includes('401') ||
                errorMessage.includes('403') ||
                errorMessage.includes('unauthorized') ||
                errorMessage.includes('api key') ||
                errorMessage.includes('Missing Authentication');
            if (isAuthError) {
                logger.error(`Authentication failed for ${provider.name}. The API key may be missing or invalid.`);
                logger.info('');
                logger.info('Options to fix this:');
                // Map provider type to the correct env var name
                const ENV_VAR_MAP = {
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
                }
                else {
                    logger.info(`     Local providers don't need an API key — just run Ollama.`);
                }
                logger.info('  2. Switch to a different provider:');
                logger.info(`     agent-nuvira model switch`);
                logger.info('  3. Use a local model (no API key needed):');
                logger.info('     brew install ollama && ollama pull deepseek-coder');
                logger.info('');
                // Offer interactive provider selection
                const answer = await inquirer.prompt([
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
            }
            else {
                logger.error(errorMessage.split('\n')[0]);
                logger.info(`Run \`agent-nuvira model switch\` to try a different provider.`);
            }
        }
    }
}
//# sourceMappingURL=plan.js.map