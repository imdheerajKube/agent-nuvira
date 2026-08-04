import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { logger } from '../utils/logger.js';
import { getProviderFallback, classifyFallbackError, isRetryableError, recordRegistryFailure, recordRegistrySuccess } from '../learning/provider-fallback.js';
/**
 * Edit command — edit files using AI assistance
 * buff edit <file> [--provider nim] [--instruction "add error handling"]
 */
export class EditCommand extends BaseCommand {
    create() {
        const command = new Command('edit')
            .description('Edit a file using AI assistance')
            .argument('<file>', 'File to edit')
            .option('-i, --instruction <text>', 'Edit instruction')
            .option('-p, --provider <provider>', 'Inference provider')
            .option('-m, --model <model>', 'Model to use')
            .option('--dry-run', 'Show proposed changes without modifying the file')
            .option('--review', 'Create a review bundle capturing proposed changes instead of writing directly')
            .action(async (file, options) => {
            await this.execute(file, options || {});
        });
        return command;
    }
    async execute(file, options) {
        if (!existsSync(file)) {
            logger.error(`File not found: ${file}`);
            return;
        }
        const { type, provider } = await this.getProvider(options || {});
        const available = await provider.isAvailable();
        if (!available) {
            logger.error(`${provider.name} is not available. Check your configuration.`);
            return;
        }
        const content = readFileSync(file, 'utf-8');
        const instruction = options?.instruction || 'Review and improve this code. Fix bugs, improve readability, and add error handling where appropriate.';
        const parser = new ContextParser({ maxTokens: 2048 });
        const context = parser.parseFromString(content, file);
        const contextStr = ContextParser.formatContext(context);
        const prompt = `I have the following code in ${file}:\n\n${contextStr}\n\nInstruction: ${instruction}\n\nPlease provide the complete updated file content. Return ONLY the code, no explanations.`;
        const spinner = ora(`Editing ${file} with ${provider.name}...`).start();
        try {
            let result;
            try {
                result = await provider.generate(prompt, options);
                // Success attribution: this edit call PROVED the provider × model
                // works — the per-action "learned from real usage" panel gains an
                // 'edit' verified row (mirror of the failure write in the catch).
                recordRegistrySuccess(type, options?.model, 'edit');
            }
            catch (err) {
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
                        const fallbackResult = await fallback.callWithFallback(type, async (fbProvider) => fbProvider.generate(prompt, options), { context: 'edit', label: `Edit ${file}` });
                        result = fallbackResult.response;
                        if (fallbackResult.attempts > 1) {
                            logger.success(`✅ Auto-fallback: switched to ${fallbackResult.provider}`);
                        }
                    }
                    catch (fallbackErr) {
                        throw err; // Throw the original error
                    }
                }
                else {
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
                const review = createReviewFromResult(options.instruction || `Edit ${file}`, [{
                        path: file,
                        originalContent: content,
                        newContent: codeResult,
                        status: 'modified',
                    }], `Edit: ${options.instruction || 'Code improvement'}\n\nModified: ${file}`, {
                    provider: type,
                    model: options.model,
                    author: process.env.USER || 'agent-baba-d',
                });
                logger.highlight(`\n📋 Created review bundle: ${review.id}`);
                logger.info(`   Run \`buff team review show ${review.id}\` to view`);
                logger.info(`   Run \`buff team review approve ${review.id}\` then \`buff team review merge ${review.id}\` to apply`);
                return;
            }
            writeFileSync(file, codeResult, 'utf-8');
            spinner.succeed(`Updated ${file}`);
        }
        catch (err) {
            spinner.fail('Edit failed');
            logger.error(String(err));
        }
    }
}
//# sourceMappingURL=edit.js.map