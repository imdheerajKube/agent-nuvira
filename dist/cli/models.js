import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { refreshModelRegistry, startRegistryWatcher, PROBE_PROVIDERS } from '../inference/model-probe.js';
/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   buff models refresh [provider]  — probe + spot-check, update the registry
 *   buff models status [--json]     — show the Model Availability Registry
 *   buff models watch [--interval N]— background daemon keeping the registry fresh
 */
export class ModelsCommand extends BaseCommand {
    create() {
        const command = new Command('models')
            .description('List available models from inference providers')
            .option('-p, --provider <provider>', 'Only show models from this provider (nim, gemini, openrouter, groq, local)')
            .option('-s, --search <keyword>', 'Search/filter models by keyword')
            .option('--all', 'Show all models (including unconfigured providers)', false)
            .option('--verify', 'Verify API keys and show configuration status for all providers', false)
            .option('-j, --json', 'Output as JSON (for scripting and IDE integration)', false)
            .action(async (options) => {
            await this.execute(options || {});
        });
        // ── Subcommand: models refresh — probe + spot-check the registry ──────
        command
            .command('refresh')
            .description('Probe providers and spot-check models, updating the Model Availability Registry')
            .argument('[provider]', 'Only refresh this provider')
            .option('--no-spot-check', 'Only run listModels probes (skip 1-token spot-checks)')
            .option('-j, --json', 'Output as JSON', false)
            .action(async (provider, opts) => {
            const providers = provider ? [provider] : PROBE_PROVIDERS;
            logger.highlight('\n📡 Refreshing Model Registry…\n');
            const result = await refreshModelRegistry(this.configManager, {
                providers,
                spotCheck: opts?.spotCheck !== false,
                onProgress: (label, detail) => console.log(`  ${label} — ${detail}`),
            });
            if (opts?.json) {
                console.log(JSON.stringify(result, null, 2));
                return;
            }
            console.log('');
            logger.success(`Registry refreshed — ${result.providersProbed.length} provider(s), ${result.modelsListed} models listed, ` +
                `${result.verified} verified, ${result.unavailable} unavailable, ${result.skipped} skipped`);
            console.log('');
            console.log(await getModelRegistry().formatStatus());
        });
        // ── Subcommand: models status — show the registry ────────────────────
        command
            .command('status')
            .description('Show the Model Availability Registry (verified / unavailable / quota-parked models)')
            .option('-j, --json', 'Output as JSON', false)
            .action(async (opts) => {
            if (opts?.json) {
                console.log(JSON.stringify(await getModelRegistry().getStatus(), null, 2));
                return;
            }
            console.log('');
            console.log(await getModelRegistry().formatStatus());
            console.log('');
            logger.info('  Registry updates automatically from real usage. Run `buff models refresh` to probe now,');
            logger.info('  or `buff models watch` to run a background maintenance daemon.');
        });
        // ── Subcommand: models watch — background maintenance daemon ──────────
        command
            .command('watch')
            .description('Run the model-registry maintenance daemon: probe + spot-check on a schedule')
            .option('--interval <seconds>', 'Refresh interval in seconds (default: 600)', '600')
            .option('--no-spot-check', 'Only run listModels probes (skip spot-checks)', false)
            .action(async (opts) => {
            const intervalMs = Math.max(60, parseInt(opts?.interval || '600', 10) || 600) * 1000;
            logger.highlight('\n👁️  Model Registry Watch started — keeping availability fresh…');
            logger.info(`  Interval: ${Math.round(intervalMs / 1000)}s · Ctrl+C to stop\n`);
            startRegistryWatcher(this.configManager, {
                spotCheck: opts?.spotCheck !== false,
                intervalMs,
                onProgress: (label, detail) => console.log(`  ${label} — ${detail}`),
            });
            // Hold until the user stops the daemon.
            await new Promise((resolve) => {
                const stop = () => {
                    console.log('\nWatch stopped.');
                    resolve();
                };
                process.once('SIGINT', stop);
                process.once('SIGTERM', stop);
            });
        });
        return command;
    }
    async execute(options) {
        const providersToCheck = options?.provider
            ? [options.provider]
            : (() => {
                const builtin = ['nim', 'gemini', 'openrouter', 'groq', 'local'];
                const registry = getPluginRegistry();
                const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
                return Array.from(new Set([...builtin, ...pluginTypes]));
            })();
        // If --verify, show API key/configuration status and then list models
        if (options?.verify && !options?.json) {
            console.log();
            logger.highlight('🔑 Provider Configuration Status\n');
            for (const providerType of providersToCheck) {
                const { provider } = resolveProvider(this.configManager, providerType);
                const available = await provider.isAvailable();
                const config = this.configManager.getProviderConfig(providerType).config;
                const hasKey = !!config.apiKey;
                const keyPreview = hasKey
                    ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`
                    : 'Not set';
                if (available) {
                    logger.success(`  ✅ ${provider.name}`);
                }
                else {
                    logger.info(`  ⛔ ${provider.name}`);
                }
                console.log(`       API Key: ${keyPreview}`);
                console.log(`       Model: ${config.model || 'default'}`);
                console.log();
            }
        }
        const allResults = [];
        for (const providerType of providersToCheck) {
            const resolved = resolveProvider(this.configManager, providerType);
            const provider = resolved.provider;
            const available = await provider.isAvailable();
            if (!available && !options?.all) {
                logger.debug(`${provider.name} not configured — skipping`);
                continue;
            }
            const s = options?.json ? null : ora(`Fetching models from ${provider.name}...`).start();
            try {
                const models = await provider.listModels();
                s?.stop();
                if (models.length === 0) {
                    if (!options?.json) {
                        if (available) {
                            logger.info(`${provider.name}: No models found or API not reachable`);
                        }
                        else {
                            logger.info(`${provider.name}: Not configured`);
                        }
                    }
                    continue;
                }
                for (const model of models) {
                    allResults.push({
                        provider: provider.name,
                        providerType: resolved.type,
                        name: model.name,
                        id: model.id,
                        owner: model.owner,
                        description: model.description,
                    });
                }
                if (!options?.json) {
                    logger.success(`${provider.name}: ${models.length} models found`);
                }
            }
            catch (err) {
                s?.stop();
                if (!options?.json) {
                    logger.error(`${provider.name}: Failed to fetch models — ${String(err)}`);
                }
            }
        }
        // Filter by search keyword if provided
        const filtered = options?.search
            ? allResults.filter((m) => m.name.toLowerCase().includes(options.search.toLowerCase()) ||
                m.id.toLowerCase().includes(options.search.toLowerCase()) ||
                (m.owner || '').toLowerCase().includes(options.search.toLowerCase()))
            : allResults;
        // ── JSON output (for scripting / IDE integration) ───────────────
        if (options?.json) {
            console.log(JSON.stringify({ models: filtered }, null, 2));
            return;
        }
        if (filtered.length === 0) {
            if (options?.search) {
                logger.info(`No models found matching "${options.search}"`);
            }
            else {
                logger.info('No models found. Configure a provider first with: agent-baba-d config set');
            }
            return;
        }
        // Display results
        console.log(`\n${'='.repeat(60)}`);
        logger.highlight(`📋 Available Models (${filtered.length})`);
        console.log(`${'='.repeat(60)}`);
        const grouped = {};
        for (const m of filtered) {
            if (!grouped[m.provider])
                grouped[m.provider] = [];
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
//# sourceMappingURL=models.js.map