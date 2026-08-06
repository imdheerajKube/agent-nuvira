import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { ProviderType, BuffConfig } from '../config/types.js';
import { clearModelListCache } from '../inference/model-validator.js';

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
        logger.error(`Unknown config key: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  providers.<name>.apiKeys "k1,k2"  (M2.3 multi-account rotation)\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  routing.bandit\n  routing.allowPaid\n  routing.quota.<provider>.requestsPerWindow\n  routing.governance.allowProviders "groq,local"  (M2.4 admin policy)\n  routing.contextWindows.<model> 16384  (M2.5 context preflight)\n  routing.nuviraSidecar.enabled  (P5 sidecar flag, default false)\n  routing.compression.enabled  (M4.4 conservative compression, default false)`);
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

      let typedValue: string | number | string[] = value;

      if (field === 'apiKeys') {
        // M2.3 multi-account rotation: comma-separated list of ADDITIONAL keys
        // for the same provider (the primary stays in `apiKey`). E.g.
        //   buff config set providers.groq.apiKeys "k1,k2,k3"
        // Empty/whitespace-only input CLEARS the list (remove rotation keys).
        const keys = value.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
        typedValue = keys;
      } else {
        // Coerce numeric values (existing behavior for model/temperature/maxTokens)
        if (!isNaN(Number(value)) && value.trim() !== '') {
          typedValue = Number(value);
        }
      }

      this.configManager.save({
        providers: {
          [providerName]: {
            ...providerConfig,
            [field]: typedValue,
          },
        },
      } as Partial<typeof config>);

      // A provider key/model/baseURL change can invalidate the cached live
      // model list (model-validator caches listModels() for 60s). Drop it now
      // so auto routing re-fetches against the new credentials immediately.
      clearModelListCache();
    } else if (parts.length === 3 && parts[0] === 'pricing') {
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
    } else if (parts.length === 2 && parts[0] === 'routing') {
      // routing.bandit | routing.allowPaid | routing.maxCostUsd | routing.minSpeed | routing.minReasoning
      // | routing.capabilityFit | routing.contextFit | routing.partialFlakiness
      const field = parts[1];
      // Boolean routing gates — the soft scoring signals (capability-fit,
      // context preflight, P4 M4.4 partial-flakiness) are all boolean.
      const BOOLEAN_ROUTING_KEYS = new Set([
        'bandit', 'allowPaid', 'capabilityFit', 'contextFit', 'partialFlakiness',
      ]);

      if (BOOLEAN_ROUTING_KEYS.has(field)) {
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
        this.configManager.save({ routing: { [field]: typedValue } } as Partial<BuffConfig>);
      } else if (field === 'maxCostUsd' || field === 'minSpeed' || field === 'minReasoning') {
        const num = Number(value);
        if (isNaN(num) || num < 0) {
          logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
          return;
        }
        this.configManager.save({ routing: { [field]: num } } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown routing config key: ${field}. Valid keys: bandit, allowPaid, capabilityFit, contextFit, partialFlakiness, maxCostUsd, minSpeed, minReasoning`);
        return;
      }
    } else if (parts.length === 4 && parts[0] === 'routing' && parts[1] === 'quota') {
      // routing.quota.<provider>.<field> — e.g. routing.quota.gemini.requestsPerWindow 1500
      const providerName = parts[2];
      const field = parts[3];
      if (field !== 'tokensPerWindow' && field !== 'requestsPerWindow' && field !== 'windowMs') {
        logger.error(`Unknown quota config key: ${field}. Valid keys: tokensPerWindow, requestsPerWindow, windowMs`);
        return;
      }
      const num = Number(value);
      if (isNaN(num) || num < 0) {
        logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
        return;
      }
      const existing = config.routing?.quota?.[providerName] || {};
      this.configManager.save({
        routing: {
          quota: {
            [providerName]: { ...existing, [field]: num },
          },
        },
      } as Partial<BuffConfig>);
    } else if (parts.length >= 3 && parts[0] === 'routing' && parts[1] === 'governance') {
      // M2.4 governance policy — routing.governance.<field> where <field> is
      // one of: allowProviders, denyProviders, allowModels, denyModels
      // (comma-separated lists), maxCostUsd / minPrivacyForPii (numbers), or
      // allowUnblock (boolean). Empty/whitespace clears a list.
      const field = parts[2];
      const existing = config.routing?.governance || {};
      let typedValue: string[] | number | boolean;

      if (field === 'allowProviders' || field === 'denyProviders' || field === 'allowModels' || field === 'denyModels') {
        typedValue = value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
        this.configManager.save({
          routing: { governance: { ...existing, [field]: typedValue } },
        } as Partial<BuffConfig>);
      } else if (field === 'maxCostUsd' || field === 'minPrivacyForPii') {
        const num = Number(value);
        if (isNaN(num) || num < 0) {
          logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
          return;
        }
        typedValue = num;
        this.configManager.save({
          routing: { governance: { ...existing, [field]: typedValue } },
        } as Partial<BuffConfig>);
      } else if (field === 'allowUnblock') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') {
          typedValue = true;
        } else if (lower === 'false' || lower === '0' || lower === 'no') {
          typedValue = false;
        } else {
          logger.error(`Invalid boolean value for ${key}: "${value}". Use true or false.`);
          return;
        }
        this.configManager.save({
          routing: { governance: { ...existing, [field]: typedValue } },
        } as Partial<BuffConfig>);
      } else if (field === 'piiPatterns') {
        typedValue = value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
        this.configManager.save({
          routing: { governance: { ...existing, [field]: typedValue } },
        } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown governance config key: ${field}. Valid keys: allowProviders, denyProviders, allowModels, denyModels, piiPatterns, maxCostUsd, minPrivacyForPii, allowUnblock`);
        return;
      }
    } else if (parts.length >= 3 && parts[0] === 'routing' && parts[1] === 'contextWindows') {
      // M2.5 context preflight — routing.contextWindows.<model|provider> where
      // the value is a positive integer token count: the nominal input window
      // override used by the soft context-fit signal. Stored as a NUMBER so
      // utilization math never relies on JS coercion of a string.
      const windowKey = parts[2];
      const num = Number(value);
      if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
        logger.error(`Invalid context window for ${key}: "${value}". Must be a positive integer token count (e.g. 16384).`);
        return;
      }
      this.configManager.save({
        routing: { contextWindows: { ...(config.routing?.contextWindows || {}), [windowKey]: num } },
      } as Partial<BuffConfig>);
      console.log(`✓ ${key} = ${num}`);
    } else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'nuviraSidecar') {
      // P5 M5.4 — routing.nuviraSidecar.enabled (boolean feature flag, default
      // false) | routing.nuviraSidecar.image (pinned gateway image/tag for
      // docker-compose.nuvira.yml, overriding the NUVIRA_GATEWAY_IMAGE env).
      const field = parts[2];
      const existing = config.routing?.nuviraSidecar || {};
      if (field === 'enabled') {
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
          routing: { nuviraSidecar: { ...existing, enabled: typedValue } },
        } as Partial<BuffConfig>);
      } else if (field === 'image') {
        const image = value.trim();
        if (!image || !/^[a-z0-9._\/-]+(:[\w.\-]+)?$/.test(image)) {
          logger.error(`Invalid gateway image for ${key}: "${value}". Expected an image:tag (e.g. ghcr.io/berriai/litellm:main-stable).`);
          return;
        }
        this.configManager.save({
          routing: { nuviraSidecar: { ...existing, image } },
        } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown nuviraSidecar config key: ${field}. Valid keys: enabled, image`);
        return;
      }
    } else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'compression') {
      // M4.4 — routing.compression.enabled (boolean, DEFAULT FALSE — lossless-
      // for-code prose compression) | routing.compression.keepRatio (0.1–1) |
      // routing.compression.minProseChars (positive int).
      const field = parts[2];
      const existing = config.routing?.compression || {};
      if (field === 'enabled') {
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
          routing: { compression: { ...existing, enabled: typedValue } },
        } as Partial<BuffConfig>);
      } else if (field === 'keepRatio') {
        const num = Number(value);
        if (isNaN(num) || num < 0.1 || num > 1) {
          logger.error(`Invalid keepRatio for ${key}: "${value}". Must be between 0.1 and 1 (fraction of prose kept).`);
          return;
        }
        this.configManager.save({
          routing: { compression: { ...existing, keepRatio: num } },
        } as Partial<BuffConfig>);
      } else if (field === 'minProseChars') {
        const num = Number(value);
        if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
          logger.error(`Invalid minProseChars for ${key}: "${value}". Must be a positive integer (chars).`);
          return;
        }
        this.configManager.save({
          routing: { compression: { ...existing, minProseChars: num } },
        } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown compression config key: ${field}. Valid keys: enabled, keepRatio, minProseChars`);
        return;
      }
    } else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'gatewayTelemetry') {
      // M7.4 — routing.gatewayTelemetry.enabled (boolean, DEFAULT FALSE) |
      // routing.gatewayTelemetry.healthFlags (boolean). OPT-IN, privacy-
      // preserving: enabling never captures prompt content — it only reports
      // aggregate gateway usage/health numbers (requests, tokens, error
      // rates) via `buff doctor --enterprise`.
      const field = parts[2];
      const existing = config.routing?.gatewayTelemetry || {};
      if (field !== 'enabled' && field !== 'healthFlags') {
        logger.error(`Unknown gatewayTelemetry config key: ${field}. Valid keys: enabled, healthFlags`);
        return;
      }
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
        routing: { gatewayTelemetry: { ...existing, [field]: typedValue } },
      } as Partial<BuffConfig>);
    } else {
      logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  providers.<name>.apiKeys "k1,k2"\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  routing.bandit\n  routing.allowPaid\n  routing.quota.<provider>.requestsPerWindow\n  routing.governance.allowProviders "groq,local"\n  routing.nuviraSidecar.enabled\n  routing.compression.enabled  (M4.4, DEFAULT FALSE)\n  routing.gatewayTelemetry.enabled  (M7.4, DEFAULT FALSE)`);
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
