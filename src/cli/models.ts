import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { logger } from '../utils/logger.js';
import { ProviderType } from '../config/types.js';

/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 */
export class ModelsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('models')
      .description('List available models from inference providers')
      .option('-p, --provider <provider>', 'Only show models from this provider (nim, gemini, openrouter, groq, local)')
      .option('-s, --search <keyword>', 'Search/filter models by keyword')
      .option('--all', 'Show all models (including unconfigured providers)', false)
      .option('--verify', 'Verify API keys and show configuration status for all providers', false)
      .action(async (options?: { provider?: string; search?: string; all?: boolean; verify?: boolean }) => {
        await this.execute(options || {});
      });

    return command;
  }

  private async execute(options?: { provider?: string; search?: string; all?: boolean; verify?: boolean }): Promise<void> {
    const providersToCheck: ProviderType[] = options?.provider
      ? [options.provider as ProviderType]
      : ['nim', 'gemini', 'openrouter', 'groq', 'local'];

    // If --verify, show API key/configuration status and then list models
    if (options?.verify) {
      console.log();
      logger.highlight('🔑 Provider Configuration Status\n');
      for (const providerType of providersToCheck) {
        const { provider } = resolveProvider(this.configManager, providerType);
        const available = await provider.isAvailable();
        const config = this.configManager.getProviderConfig(providerType).config;
        const hasKey = !!config.apiKey;
        const keyPreview = hasKey
          ? `${config.apiKey!.slice(0, 8)}...${config.apiKey!.slice(-4)}`
          : 'Not set';

        if (available) {
          logger.success(`  ✅ ${provider.name}`);
        } else {
          logger.info(`  ⛔ ${provider.name}`);
        }
        console.log(`       API Key: ${keyPreview}`);
        console.log(`       Model: ${config.model || 'default'}`);
        console.log();
      }
    }

    const allResults: Array<{ provider: string; name: string; id: string; owner?: string; description?: string }> = [];

    for (const providerType of providersToCheck) {
      const { provider } = resolveProvider(this.configManager, providerType);
      const available = await provider.isAvailable();

      if (!available && !options?.all) {
        logger.debug(`${provider.name} not configured — skipping`);
        continue;
      }

      const s = ora(`Fetching models from ${provider.name}...`).start();

      try {
        const models = await provider.listModels();
        s.stop();

        if (models.length === 0) {
          if (available) {
            logger.info(`${provider.name}: No models found or API not reachable`);
          } else {
            logger.info(`${provider.name}: Not configured`);
          }
          continue;
        }

        for (const model of models) {
          allResults.push({
            provider: provider.name,
            name: model.name,
            id: model.id,
            owner: model.owner,
            description: model.description,
          });
        }

        logger.success(`${provider.name}: ${models.length} models found`);
      } catch (err) {
        s.stop();
        logger.error(`${provider.name}: Failed to fetch models — ${String(err)}`);
      }
    }

    // Filter by search keyword if provided
    const filtered = options?.search
      ? allResults.filter((m) =>
          m.name.toLowerCase().includes(options.search!.toLowerCase()) ||
          m.id.toLowerCase().includes(options.search!.toLowerCase()) ||
          (m.owner || '').toLowerCase().includes(options.search!.toLowerCase())
        )
      : allResults;

    if (filtered.length === 0) {
      if (options?.search) {
        logger.info(`No models found matching "${options.search}"`);
      } else {
        logger.info('No models found. Configure a provider first with: agent-baba-d config set');
      }
      return;
    }

    // Display results
    console.log(`\n${'='.repeat(60)}`);
    logger.highlight(`📋 Available Models (${filtered.length})`);
    console.log(`${'='.repeat(60)}`);

    const grouped: Record<string, typeof filtered> = {};
    for (const m of filtered) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m);
    }

    for (const [providerName, models] of Object.entries(grouped)) {
      console.log(`\n${providerName}:`);
      console.log('-'.repeat(40));
      for (const m of models.slice(0, 30)) { // show max 30 per provider
        const owner = m.owner ? ` [${m.owner}]` : '';
        const desc = m.description ? ` — ${m.description.slice(0, 60)}` : '';
        console.log(`  ${m.name}${owner}${desc}`);
      }
      if (models.length > 30) {
        console.log(`  ... and ${models.length - 30} more`);
      }
    }
    console.log(`\n${'='.repeat(60)}`);

    if (allResults.length > 0) {
      logger.info('\nUse a model by specifying it with --model:');
      console.log('  agent-baba-d chat --provider nim --model <model-id>');
      console.log('  agent-baba-d edit file.js --provider openrouter --model <model-id>');
    }
  }
}
