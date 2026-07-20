import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { ProviderType, BuffConfig } from '../config/types.js';

/**
 * Config command — manage buff configuration
 * buff config [set|get|list]
 */
export class ConfigCommand extends BaseCommand {
  create(): Command {
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

  private createSetCommand(): Command {
    return new Command('set')
      .description('Set a configuration value')
      .argument('<key>', 'Config key (e.g., defaultProvider, providers.nim.model)')
      .argument('<value>', 'Config value')
      .action((key: string, value: string) => {
        this.setValue(key, value);
      });
  }

  private createGetCommand(): Command {
    return new Command('get')
      .description('Get a configuration value')
      .argument('[key]', 'Config key (e.g., defaultProvider)')
      .action((key?: string) => {
        if (key) {
          this.getValue(key);
        } else {
          this.displayConfig();
        }
      });
  }

  private createListCommand(): Command {
    return new Command('list')
      .description('List all providers and their status')
      .action(() => {
        this.listProviders();
      });
  }

  private createInitCommand(): Command {
    return new Command('init')
      .description('Initialize configuration interactively')
      .action(() => {
        this.initConfig();
      });
  }

  private displayConfig(): void {
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
        } else {
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
        } else {
          console.log(`  ${key}: ${value}`);
        }
      }
      console.log('');
    }
  }

  private getValue(key: string): void {
    const config = this.configManager.getAll();
    const parts = key.split('.');

    let value: unknown = config;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        logger.error(`Key not found: ${key}`);
        return;
      }
    }

    if (key.includes('apiKey') && value) {
      const masked = String(value).slice(0, 8) + '...' + String(value).slice(-4);
      console.log(`${key}: ${masked}`);
    } else {
      console.log(`${key}: ${value}`);
    }
  }

  private setValue(key: string, value: string): void {
    const config = this.configManager.getAll();

    // Parse the key path to set the value
    const parts = key.split('.');
    if (parts.length === 1) {
      // Top-level keys
      if (key === 'defaultProvider') {
        this.configManager.save({ defaultProvider: value as ProviderType });
      } else {
        logger.error(`Unknown config key: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers`);
        return;
      }
    } else if (parts.length === 2 && parts[0] === 'history') {
      // history.retentionDays or history.semanticSearch
      const field = parts[1];

      if (field !== 'retentionDays' && field !== 'semanticSearch') {
        logger.error(`Unknown history config key: ${field}. Valid keys: retentionDays, semanticSearch`);
        return;
      }

      let typedValue: string | number | boolean = value;

      if (field === 'semanticSearch') {
        // Coerce boolean values
        const lower = value.trim().toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') {
          typedValue = true;
        } else if (lower === 'false' || lower === '0' || lower === 'no') {
          typedValue = false;
        } else {
          logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
          return;
        }
      } else if (!isNaN(Number(value)) && value.trim() !== '') {
        typedValue = Number(value);
      }

      this.configManager.save({
        history: {
          [field]: typedValue,
        },
      } as Partial<typeof config>);
    } else if (parts.length >= 3 && parts[0] === 'providers') {
      const providerName = parts[1] as ProviderType;
      const field = parts[2];
      const providerConfig = config.providers[providerName] || {};

      // Coerce numeric values
      let typedValue: string | number = value;
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
      } as Partial<typeof config>);
    } else if (parts.length === 2 && parts[0] === 'fallback') {
      // fallback.enabled or fallback.providers
      const field = parts[1];

      if (field === 'enabled') {
        // Coerce boolean values
        const lower = value.trim().toLowerCase();
        let typedValue: boolean;
        if (lower === 'true' || lower === '1' || lower === 'yes') {
          typedValue = true;
        } else if (lower === 'false' || lower === '0' || lower === 'no') {
          typedValue = false;
        } else {
          logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
          return;
        }
        this.configManager.save({
          fallback: { enabled: typedValue },
        } as Partial<BuffConfig>);
      } else if (field === 'providers') {
        // Parse comma-separated list
        const providers = value.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
        if (providers.length === 0) {
          logger.error('fallback.providers requires at least one provider. Example: groq,nim,gemini');
          return;
        }
        this.configManager.save({
          fallback: { providers },
        } as Partial<BuffConfig>);
      } else if (field === 'maxAttempts') {
        const num = Number(value);
        if (isNaN(num) || num < 1 || !Number.isInteger(num)) {
          logger.error(`Invalid integer for ${key}: "${value}". Must be a positive integer >= 1.`);
          return;
        }
        this.configManager.save({
          fallback: { maxAttempts: num },
        } as Partial<BuffConfig>);
      } else if (field === 'retryDelayMs') {
        const num = Number(value);
        if (isNaN(num) || num < 0) {
          logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative integer.`);
          return;
        }
        this.configManager.save({
          fallback: { retryDelayMs: num },
        } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown fallback config key: ${field}. Valid keys: enabled, providers, maxAttempts, retryDelayMs`);
        return;
      }
    } else {
      logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers`);
      return;
    }

    logger.success(`Set ${key} = ${value}`);
  }

  private listProviders(): void {
    const config = this.configManager.getAll();
    logger.highlight('\nAvailable Providers:\n');

    const providers: Array<{ name: string; type: ProviderType; status: string }> = [
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

  private initConfig(): void {
    logger.info('Configuration already initialized with defaults.');
    logger.info('Edit ~/.buff/buffconfig.json or use: buff config set <key> <value>');
    logger.info('Set API keys via environment variables or the config file.');
    console.log('');
    this.displayConfig();
  }
}
