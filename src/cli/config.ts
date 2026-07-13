import { Command } from 'commander';
import { BaseCommand } from './commands.js';
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
        logger.error(`Unknown config key: ${key}. Use 'providers.<name>.<field>' format.`);
        return;
      }
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
    } else {
      logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>`);
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
  }

  private initConfig(): void {
    logger.info('Configuration already initialized with defaults.');
    logger.info('Edit ~/.buff/buffconfig.json or use: buff config set <key> <value>');
    logger.info('Set API keys via environment variables or the config file.');
    console.log('');
    this.displayConfig();
  }
}
