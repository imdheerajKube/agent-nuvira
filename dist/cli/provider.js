/**
 * Provider command — List and check health of all inference providers.
 *
 * Usage:
 *   buff provider list              — Show all providers with color-coded status table
 *   buff provider health            — Show detailed health checks for all providers
 *   buff provider health <name>     — Show detailed health for a specific provider
 *   buff provider health --watch    — Continuous monitoring mode (refreshes every 30s)
 *   buff provider health --verbose  — Show detailed diagnostic info
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
// ─── Provider Display Metadata ──────────────────────────────────────────────
const PROVIDER_DISPLAY = {
    local: { icon: '💻', label: 'Local (Ollama)', color: (s) => chalk.hex('#5dade2')(s) },
    groq: { icon: '⚡', label: 'Groq', color: (s) => chalk.hex('#00c853')(s) },
    nim: { icon: '🎮', label: 'NVIDIA NIM', color: (s) => chalk.hex('#76b900')(s) },
    gemini: { icon: '🌀', label: 'Google Gemini', color: (s) => chalk.hex('#4285f4')(s) },
    openrouter: { icon: '🌐', label: 'OpenRouter', color: (s) => chalk.hex('#a855f7')(s) },
};
const BUILTIN_PROVIDERS = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
// ─── Table Helpers ──────────────────────────────────────────────────────────
function statusIcon(available, configured) {
    if (available)
        return chalk.green('✅');
    if (configured)
        return chalk.yellow('⚠️');
    return chalk.red('❌');
}
function statusLabel(available, configured) {
    if (available)
        return chalk.green('Available');
    if (configured)
        return chalk.yellow('Unreachable');
    return chalk.red('Not configured');
}
function modelLabel(model) {
    if (!model)
        return chalk.dim('—');
    // Truncate long model names
    const maxLen = 28;
    const display = model.length > maxLen ? model.slice(0, maxLen - 3) + '...' : model;
    return chalk.cyan(display);
}
function keyPreview(key) {
    if (!key)
        return chalk.dim('Not set');
    return chalk.gray(`${key.slice(0, 6)}...${key.slice(-4)}`);
}
function divider(char = '─', count = 58) {
    return chalk.dim(char.repeat(count));
}
function padRight(s, len) {
    // Strip chalk ANSI codes (including multi-param codes like [38;2;R;G;B])
    // to calculate the visible string length for alignment.
    // eslint-disable-next-line no-control-regex
    const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
    const visibleLen = plain.length;
    const padding = Math.max(0, len - visibleLen);
    return s + ' '.repeat(padding);
}
// ─── ProviderCommand ────────────────────────────────────────────────────────
export class ProviderCommand extends BaseCommand {
    create() {
        const command = new Command('provider')
            .description('List and check health of all inference providers');
        // ── list ──────────────────────────────────────────────────────────────
        command
            .command('list')
            .description('Show all providers with color-coded status table')
            .option('--all', 'Include unconfigured providers', false)
            .action(async (options) => {
            await this.listProviders({ all: options?.all ?? false });
        });
        // ── health ────────────────────────────────────────────────────────────
        command
            .command('health [providerName]')
            .description('Show detailed health checks for one or all providers')
            .option('--watch', 'Continuous monitoring mode (refreshes every 30s)', false)
            .option('--verbose', 'Show detailed diagnostic information', false)
            .action(async (providerName, options) => {
            if (options?.watch) {
                await this.runWatchMode(providerName, options);
            }
            else {
                await this.checkHealth(providerName, options || { verbose: false });
            }
        });
        return command;
    }
    // ── List Providers ───────────────────────────────────────────────────────
    async listProviders(options) {
        const registry = getPluginRegistry();
        const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
        const providerTypes = [...BUILTIN_PROVIDERS, ...pluginTypes];
        // Fetch status for all providers in parallel
        const results = await Promise.all(providerTypes.map(async (pt) => {
            const isLocal = pt === 'local';
            const hasKey = isLocal || this.configManager.hasRequiredCredentials(pt);
            let available = false;
            let providerName = pt;
            let providerModel;
            let error;
            if (hasKey || options?.all) {
                try {
                    const resolved = resolveProvider(this.configManager, pt);
                    providerName = resolved.provider.name;
                    available = await resolved.provider.isAvailable();
                    // Try to get the configured model
                    const config = this.configManager.getProviderConfig(pt);
                    providerModel = config.config.model;
                }
                catch (err) {
                    error = err instanceof Error ? err.message : String(err);
                    available = false;
                }
            }
            return { pt, providerName, available, configured: hasKey, model: providerModel, error };
        }));
        // ── Render Table ────────────────────────────────────────────────────
        console.log('');
        logger.highlight('📡 Provider Status Overview');
        console.log('');
        // Table header
        const header = `  ${padRight(chalk.bold('Provider'), 24)} ${padRight(chalk.bold('Status'), 18)} ${padRight(chalk.bold('API Key'), 18)} ${chalk.bold('Model')}`;
        console.log(chalk.dim(chalk.bold(header)));
        console.log(`  ${divider()}`);
        let availableCount = 0;
        let configuredCount = 0;
        for (const r of results) {
            const display = PROVIDER_DISPLAY[r.pt] || { icon: '🔌', label: r.pt, color: (s) => chalk.hex('#888')(s) };
            const pName = display.color(`${display.icon}  ${display.label}`);
            const pStatus = statusIcon(r.available, r.configured) + '  ' + statusLabel(r.available, r.configured);
            const pKey = r.pt === 'local'
                ? chalk.dim('No key needed')
                : keyPreview(this.configManager.getAll().providers[r.pt]?.apiKey);
            const pModel = modelLabel(r.model);
            console.log(`  ${padRight(pName, 24)} ${padRight(pStatus, 18)} ${padRight(pKey, 18)} ${pModel}`);
            // Show error for unreachable configured providers
            if (r.error && r.configured) {
                console.log(`  ${' '.repeat(24)} ${chalk.dim('└─ Error:')} ${chalk.red(r.error)}`);
            }
            if (r.available)
                availableCount++;
            if (r.configured)
                configuredCount++;
        }
        // ── Summary ─────────────────────────────────────────────────────────
        console.log(`  ${divider()}`);
        const summaryParts = [];
        summaryParts.push(`${chalk.green(`✅ ${availableCount} available`)}`);
        summaryParts.push(`${chalk.yellow(`⚠️  ${configuredCount - availableCount} unreachable`)}`);
        summaryParts.push(`${chalk.red(`❌ ${results.length - configuredCount} not configured`)}`);
        console.log(`  ${summaryParts.join('  |  ')}`);
        console.log('');
        // ── Legend & Tips ──────────────────────────────────────────────────
        console.log(`  ${chalk.dim('Legend:')}`);
        console.log(`  ${chalk.green('✅ Available')}  — Provider is configured and reachable`);
        console.log(`  ${chalk.yellow('⚠️  Unreachable')} — Provider is configured but endpoint not reachable`);
        console.log(`  ${chalk.red('❌ Not configured')} — No API key found`);
        console.log('');
        console.log(`  ${chalk.dim('Tip:')} Run ${chalk.cyan('buff provider health')} for detailed diagnostics`);
        console.log(`  ${chalk.dim('Tip:')} Run ${chalk.cyan('buff doctor')} for full system health check`);
        console.log('');
    }
    // ── Health Check ─────────────────────────────────────────────────────────
    async checkHealth(providerName, options) {
        const registry = getPluginRegistry();
        const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
        const providersToCheck = providerName
            ? [providerName]
            : [...BUILTIN_PROVIDERS, ...pluginTypes];
        // Header
        console.log('');
        logger.highlight(`🏥 Provider Health${providerName ? ` — ${providerName}` : ''}`);
        console.log('');
        let allPassed = true;
        for (const pt of providersToCheck) {
            const display = PROVIDER_DISPLAY[pt] || { icon: '🔌', label: pt, color: (s) => chalk.hex('#888')(s) };
            const headerStr = `  ${display.icon}  ${chalk.bold(display.label)}`;
            console.log(`${headerStr}`);
            console.log(`  ${divider('─', 54)}`);
            // 1. API Key check
            const isLocal = pt === 'local';
            const hasKey = isLocal || this.configManager.hasRequiredCredentials(pt);
            if (isLocal) {
                console.log(`    ${chalk.green('✅')} API Key: ${chalk.dim('No key needed (local)')}`);
            }
            else if (hasKey) {
                const key = this.configManager.getAll().providers[pt]?.apiKey;
                console.log(`    ${chalk.green('✅')} API Key: ${keyPreview(key)}`);
            }
            else {
                allPassed = false;
                const envVar = this.getEnvVarName(pt);
                console.log(`    ${chalk.red('❌')} API Key: ${chalk.red('Not configured')}`);
                console.log(`       ${chalk.dim('Set')} ${chalk.cyan(envVar)} ${chalk.dim('environment variable')}`);
                console.log('');
                continue; // Skip further checks if no key
            }
            // 2. Provider instantiation & availability
            try {
                const resolved = resolveProvider(this.configManager, pt);
                const provider = resolved.provider;
                console.log(`    ${chalk.green('✅')} Module: ${chalk.cyan(provider.name)}`);
                const available = await provider.isAvailable();
                if (available) {
                    console.log(`    ${chalk.green('✅')} Endpoint: ${chalk.green('Reachable')}`);
                }
                else {
                    allPassed = false;
                    const detail = this.getEndpointDetail(pt);
                    console.log(`    ${chalk.red('❌')} Endpoint: ${chalk.red('Not reachable')}`);
                    console.log(`       ${chalk.dim('Detail:')} ${detail}`);
                    const fix = this.getEndpointFix(pt);
                    if (fix) {
                        console.log(`       ${chalk.dim('Fix:')} ${chalk.yellow(fix)}`);
                    }
                    console.log('');
                    continue;
                }
                // 3. Model info
                const config = this.configManager.getProviderConfig(pt);
                const configuredModel = config.config.model;
                if (configuredModel) {
                    console.log(`    ${chalk.green('ℹ')}  Model: ${chalk.cyan(configuredModel)}`);
                }
                else {
                    console.log(`    ${chalk.yellow('ℹ')}  Model: ${chalk.dim('Default (not specified)')}`);
                }
                // 4. Model listing (verbose only)
                if (options?.verbose) {
                    try {
                        const modelList = await provider.listModels();
                        if (modelList.length > 0) {
                            const models = modelList.slice(0, 8).map((m) => m.id);
                            const more = modelList.length > 8 ? ` ${chalk.dim(`(+${modelList.length - 8} more)`)}` : '';
                            console.log(`    ${chalk.green('✅')} Models: ${chalk.cyan(models.join(', '))}${more}`);
                        }
                        else {
                            console.log(`    ${chalk.yellow('⚠️')} Models: ${chalk.yellow('No models found')}`);
                        }
                    }
                    catch (err) {
                        console.log(`    ${chalk.yellow('⚠️')} Models: ${chalk.yellow('Could not list')} — ${chalk.dim(err instanceof Error ? err.message : String(err))}`);
                    }
                }
                else {
                    console.log(`    ${chalk.dim('   Models: (use --verbose to list)')}`);
                }
            }
            catch (err) {
                allPassed = false;
                console.log(`    ${chalk.red('❌')} Provider: ${chalk.red(err instanceof Error ? err.message : String(err))}`);
            }
            console.log('');
        }
        // ── Summary ─────────────────────────────────────────────────────────
        if (allPassed) {
            console.log(`  ${chalk.green('✅ All providers healthy')}`);
        }
        else {
            console.log(`  ${chalk.yellow('⚠️  Some providers have issues. Use')} ${chalk.cyan('buff doctor')} ${chalk.yellow('for full diagnostics.')}`);
        }
        console.log('');
    }
    // ── Watch Mode ────────────────────────────────────────────────────────────
    async runWatchMode(providerName, options) {
        logger.info('Watch mode enabled. Refreshing every 30s. Press Ctrl+C to stop.\n');
        const refresh = async () => {
            console.clear();
            await this.checkHealth(providerName, options);
        };
        await refresh();
        const interval = setInterval(refresh, 30_000);
        process.on('SIGINT', () => {
            clearInterval(interval);
            logger.info('\nWatch mode stopped.');
            process.exit(0);
        });
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    getEnvVarName(providerType) {
        const map = {
            groq: 'GROQ_API_KEY',
            gemini: 'GEMINI_API_KEY',
            nim: 'NVIDIA_NIM_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
        };
        return map[providerType] || `${providerType.toUpperCase()}_API_KEY`;
    }
    getEndpointDetail(providerType) {
        const endpoints = {
            local: 'Ollama not running at http://localhost:11434',
            groq: 'Groq API endpoint not reachable',
            gemini: 'Gemini API endpoint not reachable',
            nim: 'NVIDIA NIM endpoint not reachable',
            openrouter: 'OpenRouter endpoint not reachable',
        };
        return endpoints[providerType] || 'Provider endpoint not reachable';
    }
    getEndpointFix(providerType) {
        const fixes = {
            local: 'Run `ollama serve` to start the Ollama server',
            groq: 'Verify GROQ_API_KEY is correct at https://console.groq.com/keys',
            gemini: 'Verify GEMINI_API_KEY at https://aistudio.google.com/app/apikey',
            nim: 'Verify NVIDIA_NIM_API_KEY is correct',
            openrouter: 'Verify OPENROUTER_API_KEY at https://openrouter.ai/keys',
        };
        return fixes[providerType] || '';
    }
}
//# sourceMappingURL=provider.js.map