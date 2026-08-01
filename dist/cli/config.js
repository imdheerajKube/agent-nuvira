import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
/**
 * Config command — manage buff configuration
 * buff config [set|get|list]
 */
export class ConfigCommand extends BaseCommand {
    create() {
        const command = new Command('config')
            .description('Manage Buff configuration')
            .addCommand(this.createSetCommand())
            .addCommand(this.createGetCommand())
            .addCommand(this.createListCommand())
            .addCommand(this.createInitCommand())
            .action(() => {
            // Show current config when no subcommand is given
            this.displayConfig();
        });
        return command;
    }
    createSetCommand() {
        return new Command('set')
            .description('Set a configuration value')
            .argument('<key>', 'Config key (e.g., defaultProvider, providers.nim.model)')
            .argument('<value>', 'Config value')
            .action((key, value) => {
            this.setValue(key, value);
        });
    }
    createGetCommand() {
        return new Command('get')
            .description('Get a configuration value')
            .argument('[key]', 'Config key (e.g., defaultProvider)')
            .action((key) => {
            if (key) {
                this.getValue(key);
            }
            else {
                this.displayConfig();
            }
        });
    }
    createListCommand() {
        return new Command('list')
            .description('List all providers and their status')
            .action(() => {
            this.listProviders();
        });
    }
    createInitCommand() {
        return new Command('init')
            .description('Initialize configuration interactively')
            .action(() => {
            this.initConfig();
        });
    }
    displayConfig() {
        const config = this.configManager.getAll();
        logger.highlight('\nBuff Configuration\n');
        logger.info(`Default Provider: ${config.defaultProvider}`);
        console.log('');
        for (const [provider, providerConfig] of Object.entries(config.providers)) {
            logger.highlight(`${provider.toUpperCase()}:`);
            for (const [key, value] of Object.entries(providerConfig)) {
                if (key === 'apiKey' && value) {
                    const masked = String(value).slice(0, 8) + '...' + String(value).slice(-4);
                    console.log(`  ${key}: ${masked}`);
                }
                else {
                    console.log(`  ${key}: ${value || 'not set'}`);
                }
            }
            console.log('');
        }
        // Show history config
        if (config.history) {
            logger.highlight('HISTORY:');
            for (const [key, value] of Object.entries(config.history)) {
                console.log(`  ${key}: ${value}`);
            }
            console.log('');
        }
        // Show fallback config
        if (config.fallback) {
            logger.highlight('FALLBACK ROUTING:');
            for (const [key, value] of Object.entries(config.fallback)) {
                if (key === 'providers' && Array.isArray(value)) {
                    console.log(`  ${key}: ${value.join(', ')}`);
                }
                else {
                    console.log(`  ${key}: ${value}`);
                }
            }
            console.log('');
        }
        // Show auto-routing pricing overrides
        if (config.pricing && Object.keys(config.pricing).length > 0) {
            logger.highlight('AUTO ROUTING PRICING (USD per 1K tokens):');
            for (const [provider, pricing] of Object.entries(config.pricing)) {
                const input = pricing?.inputPer1K !== undefined ? pricing.inputPer1K : 'built-in';
                const output = pricing?.outputPer1K !== undefined ? pricing.outputPer1K : 'built-in';
                console.log(`  ${provider}: in ${input} / out ${output}`);
            }
            console.log('');
        }
        // Show learning-router config
        if (config.routing) {
            logger.highlight('LEARNING ROUTER:');
            for (const [key, value] of Object.entries(config.routing)) {
                if (key === 'bandit') {
                    console.log(`  bandit: ${value ? 'enabled (Thompson sampling)' : 'disabled'}`);
                }
                else {
                    console.log(`  ${key}: ${value}`);
                }
            }
            console.log('');
        }
    }
    getValue(key) {
        const config = this.configManager.getAll();
        const parts = key.split('.');
        let value = config;
        for (const part of parts) {
            if (value && typeof value === 'object' && part in value) {
                value = value[part];
            }
            else {
                logger.error(`Key not found: ${key}`);
                return;
            }
        }
        if (key.includes('apiKey') && value) {
            const masked = String(value).slice(0, 8) + '...' + String(value).slice(-4);
            console.log(`${key}: ${masked}`);
        }
        else {
            console.log(`${key}: ${value}`);
        }
    }
    setValue(key, value) {
        const config = this.configManager.getAll();
        // Parse the key path to set the value
        const parts = key.split('.');
        if (parts.length === 1) {
            // Top-level keys
            if (key === 'defaultProvider') {
                this.configManager.save({ defaultProvider: value });
            }
            else {
                logger.error(`Unknown config key: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers`);
                return;
            }
        }
        else if (parts.length === 2 && parts[0] === 'history') {
            // history.retentionDays or history.semanticSearch
            const field = parts[1];
            if (field !== 'retentionDays' && field !== 'semanticSearch') {
                logger.error(`Unknown history config key: ${field}. Valid keys: retentionDays, semanticSearch`);
                return;
            }
            let typedValue = value;
            if (field === 'semanticSearch') {
                // Coerce boolean values
                const lower = value.trim().toLowerCase();
                if (lower === 'true' || lower === '1' || lower === 'yes') {
                    typedValue = true;
                }
                else if (lower === 'false' || lower === '0' || lower === 'no') {
                    typedValue = false;
                }
                else {
                    logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
                    return;
                }
            }
            else if (!isNaN(Number(value)) && value.trim() !== '') {
                typedValue = Number(value);
            }
            this.configManager.save({
                history: {
                    [field]: typedValue,
                },
            });
        }
        else if (parts.length >= 3 && parts[0] === 'providers') {
            const providerName = parts[1];
            const field = parts[2];
            const providerConfig = config.providers[providerName] || {};
            // Coerce numeric values
            let typedValue = value;
            if (!isNaN(Number(value)) && value.trim() !== '') {
                typedValue = Number(value);
            }
            this.configManager.save({
                providers: {
                    [providerName]: {
                        ...providerConfig,
                        [field]: typedValue,
                    },
                },
            });
        }
        else if (parts.length === 3 && parts[0] === 'pricing') {
            // pricing.<provider>.inputPer1K | pricing.<provider>.outputPer1K
            const providerName = parts[1];
            const field = parts[2];
            if (field !== 'inputPer1K' && field !== 'outputPer1K') {
                logger.error(`Unknown pricing config key: ${field}. Valid keys: inputPer1K, outputPer1K`);
                return;
            }
            const num = Number(value);
            if (isNaN(num) || num < 0) {
                logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
                return;
            }
            this.configManager.save({
                pricing: {
                    [providerName]: {
                        [field]: num,
                    },
                },
            });
        }
        else if (parts.length === 2 && parts[0] === 'fallback') {
            // fallback.enabled or fallback.providers
            const field = parts[1];
            if (field === 'enabled') {
                // Coerce boolean values
                const lower = value.trim().toLowerCase();
                let typedValue;
                if (lower === 'true' || lower === '1' || lower === 'yes') {
                    typedValue = true;
                }
                else if (lower === 'false' || lower === '0' || lower === 'no') {
                    typedValue = false;
                }
                else {
                    logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
                    return;
                }
                this.configManager.save({
                    fallback: { enabled: typedValue },
                });
            }
            else if (field === 'providers') {
                // Parse comma-separated list
                const providers = value.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
                if (providers.length === 0) {
                    logger.error('fallback.providers requires at least one provider. Example: groq,nim,gemini');
                    return;
                }
                this.configManager.save({
                    fallback: { providers },
                });
            }
            else if (field === 'maxAttempts') {
                const num = Number(value);
                if (isNaN(num) || num < 1 || !Number.isInteger(num)) {
                    logger.error(`Invalid integer for ${key}: "${value}". Must be a positive integer >= 1.`);
                    return;
                }
                this.configManager.save({
                    fallback: { maxAttempts: num },
                });
            }
            else if (field === 'retryDelayMs') {
                const num = Number(value);
                if (isNaN(num) || num < 0) {
                    logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative integer.`);
                    return;
                }
                this.configManager.save({
                    fallback: { retryDelayMs: num },
                });
            }
            else {
                logger.error(`Unknown fallback config key: ${field}. Valid keys: enabled, providers, maxAttempts, retryDelayMs`);
                return;
            }
        }
        else if (parts.length === 2 && parts[0] === 'routing') {
            // routing.bandit | routing.maxCostUsd | routing.minSpeed | routing.minReasoning
            const field = parts[1];
            if (field === 'bandit') {
                const lower = value.trim().toLowerCase();
                let typedValue;
                if (lower === 'true' || lower === '1' || lower === 'yes') {
                    typedValue = true;
                }
                else if (lower === 'false' || lower === '0' || lower === 'no') {
                    typedValue = false;
                }
                else {
                    logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
                    return;
                }
                this.configManager.save({ routing: { bandit: typedValue } });
            }
            else if (field === 'maxCostUsd' || field === 'minSpeed' || field === 'minReasoning') {
                const num = Number(value);
                if (isNaN(num) || num < 0) {
                    logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
                    return;
                }
                this.configManager.save({ routing: { [field]: num } });
            }
            else {
                logger.error(`Unknown routing config key: ${field}. Valid keys: bandit, maxCostUsd, minSpeed, minReasoning`);
                return;
            }
        }
        else {
            logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  routing.bandit\n  routing.maxCostUsd`);
            return;
        }
        logger.success(`Set ${key} = ${value}`);
    }
    listProviders() {
        const config = this.configManager.getAll();
        logger.highlight('\nAvailable Providers:\n');
        const providers = [
            { name: 'NVIDIA NIM', type: 'nim', status: this.configManager.hasRequiredCredentials('nim') ? '✅' : '❌ No API key' },
            { name: 'Google Gemini', type: 'gemini', status: this.configManager.hasRequiredCredentials('gemini') ? '✅' : '❌ No API key' },
            { name: 'OpenRouter', type: 'openrouter', status: this.configManager.hasRequiredCredentials('openrouter') ? '✅' : '❌ No API key' },
            { name: 'Groq', type: 'groq', status: this.configManager.hasRequiredCredentials('groq') ? '✅' : '❌ No API key' },
            { name: 'Local', type: 'local', status: '✅ Always available' },
        ];
        for (const p of providers) {
            const model = config.providers[p.type]?.model || 'default';
            const isDefault = config.defaultProvider === p.type ? ' (default)' : '';
            console.log(`  ${p.status}  ${p.name}${isDefault}`);
            console.log(`       Model: ${model}`);
            console.log('');
        }
        const pluginRegistry = getPluginRegistry();
        const pluginProviders = pluginRegistry.getAllPlugins();
        if (pluginProviders.length > 0) {
            logger.highlight('Plugin Providers:');
            for (const plugin of pluginProviders) {
                const type = plugin.getProviderType();
                const providerConfig = config.providers[type] || {};
                const isDefault = config.defaultProvider === type ? ' (default)' : '';
                const model = providerConfig.model || 'default';
                const status = providerConfig.apiKey ? '✅ Configured' : '⚙️  Plugin loaded';
                console.log(`  ${status}  ${plugin.metadata.name}${isDefault}`);
                console.log(`       Type: ${type}`);
                console.log(`       Model: ${model}`);
                console.log('');
            }
        }
    }
    initConfig() {
        logger.info('Configuration already initialized with defaults.');
        logger.info('Edit ~/.buff/buffconfig.json or use: buff config set <key> <value>');
        logger.info('Set API keys via environment variables or the config file.');
        console.log('');
        this.displayConfig();
    }
}
//# sourceMappingURL=config.js.map