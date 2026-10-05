import { Command } from 'commander';
import inquirer from 'inquirer';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCommand, getCliName } from './commands.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { ProviderType, BuffConfig } from '../config/types.js';
import { clearModelListCache } from '../inference/model-validator.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider, catalogEnvVar, isCatalogKeyless } from '../inference/provider-catalog.js';
import { Vault } from '../enterprise/vault.js';
import { guardRbacAction } from './rbac-guard.js';
import { countKeyStates } from '../config/manager.js';
import {
  PLATFORM_ENV_VARS,
  type Platform,
} from '../gateway/channel-directory.js';
import {
  SERVICE_CATALOG,
  getServiceDefinition,
  servicesByCapability,
} from '../config/service-catalog.js';
import {
  applyEnvToProcess,
  configurablePlatforms,
  envFilePath,
  envVarState,
  platformConfigStatus,
  platformEnvVarMeta,
  redactValue,
  writeEnvFile,
} from '../gateway/platform-config.js';
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_EXTRACT_MAX_CHARS,
  resolveAttachmentMaxBytes,
  resolveExtractMaxChars,
} from '../config/limits.js';
import { deleteEnvValue, saveEnvValue } from '../skills/secret-capture.js';
import {
  DEFAULT_CAPABILITY_MODE,
  parseCapabilityMode,
  resolveCapabilityMode,
} from '../config/capability-mode.js';

/**
 * Parse a reply-window duration for `config gateway ask-user-wait timeout`.
 * Accepts a bare number (milliseconds), or a suffixed `30s` / `2m` / `1h`.
 * Returns null for anything unparseable — the caller reports the error rather
 * than silently writing a nonsense window.
 */
export function parseAskWaitDuration(value: string | undefined): number | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? 'ms';
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  return Math.round(n * factor);
}

/**
 * Config command — manage nuvira configuration
 * nuvira config [set|get|list]
 */
export class ConfigCommand extends BaseCommand {
  create(): Command {
    const command = new Command('config')
      .description('Manage Nuvira configuration')
      .addCommand(this.createSetCommand())
      .addCommand(this.createGetCommand())
      .addCommand(this.createListCommand())
      .addCommand(this.createInitCommand())
      .addCommand(this.createVaultCommand())
      .addCommand(this.createGatewayCommand())
      .addCommand(this.createServiceCommand())
      .addCommand(this.createLimitCommand())
      .addCommand(this.createCapabilityCommand())
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

  /**
   * Phase A1 secret vault: `${getCliName()} config vault status|migrate-keys`.
   * Vault stores provider API keys in the OS keychain (or an AES-256-GCM
   * encrypted file fallback) so `buffconfig.json` holds `vault:` refs instead
   * of plaintext secrets.
   */
  private createVaultCommand(): Command {
    const vault = new Command('vault').description('Secret vault management (Phase A1)');

    vault
      .command('status')
      .description('Show the active vault tier and migration state')
      .action(async () => {
        const v = Vault.open({});
        const st = v.status();
        const cfg = this.configManager.getAll();
        const { refs: refCount, plaintext: plaintextCount } = countKeyStates(cfg);
        const tierLabel =
          st.tier === 'keyring'
            ? '🔐 OS keychain'
            : st.tier === 'os-cli'
              ? '🔑 OS credential tool'
              : st.tier === 'aes-file'
                ? '🔒 AES-256-GCM file'
                : '❌ none';
        console.log(`\n  Vault tier: ${tierLabel}`);
        console.log(`  Platform: ${st.platform}`);
        console.log(`  Backend: ${st.backend}`);
        console.log(`  OS keyring reachable: ${st.keyringAvailable ? 'yes' : 'no'}`);
        if (st.tier === 'aes-file') console.log(`  Encrypted-file entries: ${st.fileEntryCount}`);
        console.log(`  Provider keys in config: ${refCount} vault ref(s), ${plaintextCount} plaintext`);
        if (plaintextCount > 0) {
          console.log(`\n  Run '${getCliName()} config vault migrate-keys' to move ${plaintextCount} plaintext key(s) into the vault.`);
        }
        console.log('');
      });

    vault
      .command('log')
      .description('Show recent vault access-log entries (K3 tamper-evident audit)')
      .option('-n, --limit <n>', 'Number of entries to show (default 20)', (v) => parseInt(v, 10) || 20)
      .action(async (options?: { limit?: number }) => {
        const { readVaultAccessLog, VAULT_AUDIT_FILENAME } = await import('../enterprise/vault-audit.js');
        const entries = readVaultAccessLog(options?.limit ?? 20);
        logger.highlight('═'.repeat(64));
        logger.highlight(`  🔐  Vault Access Log (${entries.length} most recent)`);
        logger.highlight('═'.repeat(64));
        console.log('');
        if (entries.length === 0) {
          logger.info(`No vault accesses recorded yet (store: ~/.nuvira/memory/${VAULT_AUDIT_FILENAME}).`);
          console.log('');
          return;
        }
        for (const e of entries) {
          const when = new Date(e.ts).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          const opIcon = e.op === 'get' ? '👁' : e.op === 'set' ? '✍️' : '🗑';
          const okIcon = e.ok ? '✅' : '❌';
          const viaTag = e.via === 'sync' ? 'sync' : 'async';
          console.log(`  ${opIcon} ${e.op.padEnd(6)} ${okIcon}  ${when}  ${e.account}  (${e.tier}, ${viaTag})`);
        }
        console.log('');
        console.log('  Store is hash-chained + secret-scrubbed (never logs values).');
        console.log('  Verify integrity: nuvira audit verify · full posture: nuvira doctor --enterprise');
        console.log('');
      });

    vault
      .command('migrate-keys')
      .description('Move plaintext provider API keys from buffconfig.json into the vault')
      .action(async () => {
        // K4: moving plaintext keys into the vault is a credential write —
        // requires the admin role once RBAC is configured.
        if (!guardRbacAction('credential.write')) return;
        const v = Vault.open({});
        const st = v.status();
        if (st.tier === 'none') {
          logger.error(
            'Vault unavailable — no OS keyring and no BUFF_VAULT_PASSPHRASE env. ' +
            'Set BUFF_VAULT_PASSPHRASE to enable the encrypted-file fallback tier.',
          );
          return;
        }
        this.configManager.attachVault(v);
        try {
          const result = await this.configManager.migrateKeysToVault();
          if (result.migrated === 0) {
            console.log('  No plaintext keys to migrate — config is already vault-clean.');
          } else {
            const storeLabel =
              st.tier === 'keyring' ? 'OS keychain' : st.tier === 'os-cli' ? `${st.backend}` : 'AES-256-GCM vault';
            console.log(`  ✅ Moved ${result.migrated} key(s) into the ${storeLabel} for: ${result.providers.join(', ')}`);
            console.log('  nuviraconfig.json now stores vault refs — plaintext keys removed.');
          }
        } catch (err) {
          logger.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    return vault;
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
        //   nuvira config set providers.groq.apiKeys "k1,k2,k3"
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
        'promptOnWeakModel', 'promptOnFailover',
        'mlRouter', 'promotionEnforce',
      ]);
      // Numeric routing keys (positive numbers; mlK/mlMinSamples are ints).
      const NUMERIC_ROUTING_KEYS = new Set([
        'maxCostUsd', 'minSpeed', 'minReasoning', 'mlK', 'mlMinSamples', 'mlStrength',
        'promotionMinDecisions',
      ]);
      // Enum routing keys with their allowed values (weak-model consent fallback).
      const ENUM_ROUTING_KEYS: Record<string, readonly string[]> = {
        weakModelPolicy: ['ask', 'auto-allow', 'deny'],
      };

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
      } else if (NUMERIC_ROUTING_KEYS.has(field)) {
        const num = Number(value);
        if (isNaN(num) || num < 0) {
          logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
          return;
        }
        this.configManager.save({ routing: { [field]: num } } as Partial<BuffConfig>);
      } else if (ENUM_ROUTING_KEYS[field]) {
        const allowed = ENUM_ROUTING_KEYS[field];
        const lower = value.trim().toLowerCase();
        if (!allowed.includes(lower)) {
          logger.error(`Invalid value for ${key}: "${value}". Use ${allowed.join(' | ')}.`);
          return;
        }
        this.configManager.save({ routing: { [field]: lower } } as Partial<BuffConfig>);
      } else {
        logger.error(`Unknown routing config key: ${field}. Valid keys: bandit, allowPaid, capabilityFit, contextFit, partialFlakiness, promptOnWeakModel, promptOnFailover, mlRouter, promotionEnforce, weakModelPolicy, maxCostUsd, minSpeed, minReasoning, mlK, mlMinSamples, mlStrength, promotionMinDecisions`);
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
      // ConfigManager.save shallow-merges `routing` — save the FULL merged
      // quota map so sibling providers' limits are never wiped (Session 36).
      const quota = { ...(config.routing?.quota || {}) };
      quota[providerName] = { ...(quota[providerName] || {}), [field]: num };
      this.configManager.save({ routing: { quota } } as Partial<BuffConfig>);
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
      // rates) via `${getCliName()} doctor --enterprise`.
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
    } else if (parts.length === 3 && parts[0] === 'modality' && parts[1] === 'image') {
      // modality.image.provider | modality.image.model | modality.image.baseUrl
      // — which backend `generate_image` uses (gemini | openai | stability |
      // comfyui | pollinations). The API KEY itself comes from env or the
      // provider config, never from here.
      const field = parts[2];
      if (field !== 'provider' && field !== 'model' && field !== 'baseUrl') {
        logger.error(`Unknown modality.image config key: ${field}. Valid keys: provider, model, baseUrl`);
        return;
      }
      const existing = config.modality?.image || {};
      this.configManager.save({
        modality: { image: { ...existing, [field]: value } },
      } as Partial<BuffConfig>);
    } else if (key === 'dashboard.cwd') {
      // The directory dashboard chat turns run in when no project is attached.
      // Validated to EXIST and be a directory: a typo here would otherwise make
      // every unattached turn fall back to the server's own cwd — the exact
      // accident this setting exists to remove.
      const target = resolve(value.trim());
      if (!value.trim() || !existsSync(target) || !statSync(target).isDirectory()) {
        logger.error(`dashboard.cwd must be an existing directory (got: ${value}).`);
        return;
      }
      this.configManager.save({ dashboard: { cwd: target } } as Partial<BuffConfig>);
    } else if (key === 'dashboard.cwd.clear') {
      this.configManager.save({ dashboard: { cwd: undefined } } as Partial<BuffConfig>);
    } else {
      logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  providers.<name>.apiKeys "k1,k2"\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  modality.image.provider\n  modality.image.model\n  dashboard.cwd "<dir>"  (working dir for unattached dashboard chat turns)\n  routing.bandit\n  routing.allowPaid\n  routing.quota.<provider>.requestsPerWindow\n  routing.governance.allowProviders "groq,local"\n  routing.nuviraSidecar.enabled\n  routing.compression.enabled  (M4.4, DEFAULT FALSE)\n  routing.gatewayTelemetry.enabled  (M7.4, DEFAULT FALSE)`);
      return;
    }

    logger.success(`Set ${key} = ${value}`);
  }

  private listProviders(): void {
    const config = this.configManager.getAll();
    logger.highlight('\nAvailable Providers:\n');

    // Issue 001: the FULL catalog — every onboardable provider is listed with
    // its catalog label + real env-var hint, not just the 5 built-ins.
    const providers: Array<{ name: string; type: ProviderType; status: string }> = CATALOG_PROVIDER_IDS.map((type) => {
      const entry = getCatalogProvider(type);
      const name = entry ? `${entry.icon} ${entry.label}` : type;
      const status = isCatalogKeyless(type)
        ? '✅ No key needed (reachability probed)'
        : this.configManager.hasRequiredCredentials(type)
          ? '✅'
          : `❌ No API key (${catalogEnvVar(type) || `${type.toUpperCase()}_API_KEY`})`;
      return { name, type: type as ProviderType, status };
    });

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
    logger.info('Edit ~/.nuvira/nuviraconfig.json or use: nuvira config set <key> <value>');
    logger.info('Set API keys via environment variables or the config file.');
    console.log('');
    this.displayConfig();
  }

  // ─── Gateway platform transports (`${getCliName()} config gateway`) ─────────────────

  private createGatewayCommand(): Command {
    const collect = (value: string, previous: string[]): string[] => previous.concat([value]);
    const cmd = new Command('gateway')
      .description('Manage gateway platform transports (tokens written to ~/.nuvira/.env)')
      .addCommand(
        new Command('list')
          .description('Show every platform transport and its env-var status')
          .action(() => this.listPlatforms()),
      )
      .addCommand(
        new Command('set')
          .description('Configure a platform transport (interactive wizard, or --set VAR=value)')
          .argument('<platform>', 'Platform id (e.g. telegram, discord, matrix, sms)')
          .option('--set <var=value>', 'Set a specific env var (repeatable; required in non-interactive mode)', collect, [])
          .action((platform: string, opts: { set?: string[] }) => void this.setPlatform(platform, opts)),
      )
      .addCommand(
        new Command('remove')
          .description('Remove a platform transport from the env file')
          .argument('<platform>', 'Platform id')
          .option('--yes', 'Skip confirmation')
          .action((platform: string, opts: { yes?: boolean }) => void this.removePlatform(platform, opts)),
      )
      .addCommand(
        new Command('allow')
          .description('Allow a user/group to trigger the agent on a platform (written to gateway.policies in config)')
          .argument('<platform>', 'Platform id (e.g. whatsapp, telegram, discord)')
          .argument('<kind>', 'user or group')
          .argument('<id...>', 'Sender/group ids (mobile number, telegram user id, group jid, …)')
          .action((platform: string, kind: string, ids: string[]) => this.allowDisallow(platform, kind, ids, true)),
      )
      .addCommand(
        new Command('disallow')
          .description('Remove a user/group from the allowed list of a platform')
          .argument('<platform>', 'Platform id')
          .argument('<kind>', 'user or group')
          .argument('<id...>', 'Sender/group ids to remove')
          .action((platform: string, kind: string, ids: string[]) => this.allowDisallow(platform, kind, ids, false)),
      )
      .addCommand(
        new Command('reply')
          .description("Set how unapproved senders are handled on a platform: polite (⛔ message) or silent (no reply)")
          .argument('<platform>', 'Platform id')
          .argument('<mode>', 'polite or silent')
          .action((platform: string, mode: string) => this.setReplyMode(platform, mode)),
      )
      .addCommand(
        new Command('send-authority')
          .description('Manage who may command the agent to send to OTHER people (gateway_send). Outbound-only gate — separate from `allow` (who may trigger).')
          .argument('<action>', 'add, remove, list, reset or require-target')
          .argument('<platform>', 'Platform id (e.g. whatsapp, telegram)')
          .argument('[id...]', 'Sender ids for add/remove; on|off for require-target')
          .action((action: string, platform: string, ids: string[]) => this.manageSendAuthority(action, platform, ids)),
      )
      .addCommand(
        new Command('notify')
          .description('Manage status recipients — contacts/groups that ALWAYS get pipeline completion summaries')
          .argument('<action>', 'add, remove or list')
          .argument('[target...]', 'Channel target(s): alias or platform:channelId (e.g. whatsapp:Alex, telegram:123456)')
          .action((action: string, targets: string[]) => this.manageStatusRecipients(action, targets)),
      )
      .addCommand(
        new Command('ask-user-wait')
          .description('Ask-and-wait for clarifying questions on messaging channels: when a turn asks the sender a question, hold it for their reply instead of assuming option 1')
          .argument('<mode>', 'on, off or timeout')
          .argument('[value]', 'timeout mode only: reply window, e.g. 120s, 2m or 90000 (ms)')
          .action((mode: string, value?: string) => this.setAskUserWait(mode, value)),
      );
    return cmd;
  }

  /**
   * `${getCliName()} config gateway ask-user-wait on|off|timeout [value]`
   *
   * OFF by default. When ON, a turn that asks the sender a question HOLDS for
   * their reply, so an answer typed on WhatsApp actually steers the run instead
   * of arriving after the agent already acted on option 1. Applies to the
   * running gateway immediately (config is re-read per turn).
   */
  private setAskUserWait(mode: string, value?: string): void {
    if (!guardRbacAction('gateway.manage')) return;
    const cfg = this.configManager.getAll() as {
      gateway?: { askUserWait?: boolean; askUserTimeoutMs?: number };
    };

    if (mode === 'on' || mode === 'off') {
      this.configManager.save({ gateway: { askUserWait: mode === 'on' } });
      const ms = cfg.gateway?.askUserTimeoutMs ?? 120_000;
      if (mode === 'on') {
        logger.success(
          `Ask-and-wait is ON — a question holds the turn for up to ${Math.round(ms / 1000)}s for the sender's reply.`,
        );
      } else {
        logger.info('Ask-and-wait is OFF — questions use the first choice immediately (historical behaviour).');
      }
      return;
    }

    if (mode === 'timeout') {
      const parsed = parseAskWaitDuration(value);
      if (parsed === null) {
        logger.error(`Timeout must look like 120s, 2m or 90000 — got '${value ?? ''}'.`);
        return;
      }
      const clamped = Math.min(600_000, Math.max(5_000, parsed));
      this.configManager.save({ gateway: { askUserTimeoutMs: clamped } });
      logger.success(
        `Ask-and-wait reply window: ${Math.round(clamped / 1000)}s` +
          (clamped !== parsed ? ` (clamped from ${parsed}ms to the 5s–10min range)` : '') +
          '.',
      );
      if (cfg.gateway?.askUserWait !== true) {
        logger.info('Note: ask-and-wait is currently OFF — enable it with: config gateway ask-user-wait on');
      }
      return;
    }

    if (mode === 'status' || mode === 'list') {
      const on = cfg.gateway?.askUserWait === true;
      logger.info(`Ask-and-wait: ${on ? 'ON' : 'OFF (default)'}`);
      logger.info(`Reply window: ${Math.round((cfg.gateway?.askUserTimeoutMs ?? 120_000) / 1000)}s`);
      return;
    }

    logger.error(`Mode must be on, off, timeout or status — got '${mode}'.`);
  }

  /**
   * `${getCliName()} config gateway send-authority <action> <platform> [id...]`
   *
   * The OUTBOUND gate. `allow` decides who may TRIGGER the agent; this decides
   * who may then direct it to deliver to SOMEONE ELSE. Absent = inherit the
   * inbound allow-list (open); an empty list = nobody; the Allow-All wildcard
   * = anyone.
   */
  private manageSendAuthority(action: string, platform: string, ids: string[]): void {
    if (!(platform in PLATFORM_ENV_VARS)) {
      logger.error(`Unknown platform '${platform}' — see \`${getCliName()} config gateway list\`.`);
      return;
    }
    if (!['add', 'remove', 'list', 'reset', 'require-target'].includes(action)) {
      logger.error(`Action must be add, remove, list, reset or require-target, got '${action}'.`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;

    type Pol = { outboundSenders?: string[]; requireApprovedTarget?: boolean; allowedUsers?: string[] };
    const cfg = this.configManager.getAll() as { gateway?: { policies?: Record<string, Pol> } };
    const policies = { ...(cfg.gateway?.policies ?? {}) };
    const pol: Pol = { ...(policies[platform] ?? {}) };

    if (action === 'list') {
      const list = pol.outboundSenders;
      if (list === undefined) {
        logger.info(`${platform}: OPEN — any sender who may trigger the agent may also send to others (inherits the allowed-users list).`);
      } else if (list.length === 0) {
        logger.info(`${platform}: RESTRICTED — nobody may send to others.`);
      } else {
        logger.info(`${platform}: RESTRICTED to ${list.join(', ')}`);
      }
      logger.info(`Require approved recipients: ${pol.requireApprovedTarget ? 'ON' : 'OFF'}`);
      return;
    }

    if (action === 'reset') {
      delete pol.outboundSenders;
      policies[platform] = pol;
      this.configManager.save({ gateway: { policies } });
      logger.success(`${platform}: send authority reset to OPEN (inherits the allowed-users list).`);
      return;
    }

    if (action === 'require-target') {
      const value = (ids[0] ?? '').toLowerCase();
      if (!['on', 'off', 'true', 'false', 'yes', 'no'].includes(value)) {
        logger.error(`Use 'require-target <platform> on|off'.`);
        return;
      }
      pol.requireApprovedTarget = ['on', 'true', 'yes'].includes(value);
      policies[platform] = pol;
      this.configManager.save({ gateway: { policies } });
      logger.success(`${platform}: gateway_send targets must be approved contacts: ${pol.requireApprovedTarget ? 'ON' : 'OFF'}.`);
      return;
    }

    if (ids.length === 0) {
      logger.error(`Provide at least one sender id.`);
      return;
    }
    const list = pol.outboundSenders ?? [];
    if (action === 'add') {
      const added = ids.filter((id) => !list.includes(id));
      pol.outboundSenders = [...list, ...added];
      logger.success(`Added ${added.length} outbound sender(s) on ${platform}: ${added.join(', ') || '(all already present)'}`);
      logger.info('ℹ  These senders may now direct the agent to message OTHER people. Everyone else is refused.');
      logger.info(`    Reset with: ${getCliName()} config gateway send-authority reset ${platform}`);
    } else {
      const removed = ids.filter((id) => list.includes(id));
      pol.outboundSenders = list.filter((id) => !ids.includes(id));
      logger.success(`Removed ${removed.length} outbound sender(s) on ${platform}: ${removed.join(', ') || '(none were listed)'}`);
      if (pol.outboundSenders.length === 0) {
        logger.info('ℹ  The list is now EMPTY — nobody may send to others. Use `reset` to return to the open default.');
      }
    }
    policies[platform] = pol;
    this.configManager.save({ gateway: { policies } });
    logger.info('Applied to the running gateway immediately (policies re-read per inbound).');
  }

  /** `${getCliName()} config gateway allow/disallow <platform> <user|group> <id...>` */
  private allowDisallow(platform: string, kind: string, ids: string[], allow: boolean): void {
    if (!(platform in PLATFORM_ENV_VARS)) {
      logger.error(`Unknown platform '${platform}' — see \`${getCliName()} config gateway list\`.`);
      return;
    }
    if (kind !== 'user' && kind !== 'group') {
      logger.error(`Kind must be 'user' or 'group', got '${kind}'.`);
      return;
    }
    if (ids.length === 0) {
      logger.error(`Provide at least one id (mobile number, user id, group jid).`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;

    const cfg = this.configManager.getAll() as { gateway?: { policies?: Record<string, { allowedUsers?: string[]; allowedGroups?: string[] }> } };
    const policies = { ...(cfg.gateway?.policies ?? {}) };
    const pol = { ...(policies[platform] ?? {}) };
    const key = kind === 'user' ? 'allowedUsers' : 'allowedGroups';
    const list = pol[key] ?? [];
    if (allow) {
      const added = ids.filter((id) => !list.includes(id));
      pol[key] = [...list, ...added];
      logger.success(`Allowed ${added.length} ${kind}(s) on ${platform}: ${added.join(', ') || '(all already allowed)'}`);
      if (kind === 'user') {
        console.log('');
        logger.info('ℹ  This is the VERIFIED list — these senders can now TRIGGER the agent');
        logger.info('    when they message you on this platform (DMs and groups).');
        if (platform === 'whatsapp') {
          logger.info('    To also send TO them by name, add a mapping: nuvira whatsapp contact add <Name> <number>');
        }
      }
    } else {
      const removed = ids.filter((id) => list.includes(id));
      pol[key] = list.filter((id) => !ids.includes(id));
      if (pol[key]?.length === 0) delete pol[key];
      logger.success(`Removed ${removed.length} ${kind}(s) from ${platform}: ${removed.join(', ') || '(none were allowed)'}`);
    }
    policies[platform] = pol; // write the (possibly mutated) platform policy back
    this.configManager.save({ gateway: { policies } });
    logger.info('Applied to the running gateway immediately (policies re-read per inbound).');
  }

  /** `${getCliName()} config gateway reply <platform> <polite|silent>` */
  private setReplyMode(platform: string, mode: string): void {
    if (!(platform in PLATFORM_ENV_VARS)) {
      logger.error(`Unknown platform '${platform}' — see \`${getCliName()} config gateway list\`.`);
      return;
    }
    if (mode !== 'polite' && mode !== 'silent') {
      logger.error(`Mode must be 'polite' or 'silent', got '${mode}'.`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;
    const cfg = this.configManager.getAll() as { gateway?: { policies?: Record<string, { silentDrop?: boolean }> } };
    const policies = { ...(cfg.gateway?.policies ?? {}) };
    const pol = { ...(policies[platform] ?? {}) };
    // HARD POLICY: silent is the DEFAULT. `polite` must write `silentDrop:
    // false` EXPLICITLY (deleting the key would keep the silent default).
    if (mode === 'silent') pol.silentDrop = true;
    else pol.silentDrop = false;
    policies[platform] = pol; // write the (possibly mutated) platform policy back
    this.configManager.save({ gateway: { policies } });
    logger.success(`Unapproved senders on ${platform} are now handled ${mode === 'silent' ? 'SILENTLY (no reply)' : 'with a polite refusal message'}.`);
  }

  /** `${getCliName()} config gateway notify add|remove|list <target...>` */
  private manageStatusRecipients(action: string, targets: string[]): void {
    if (!['add', 'remove', 'list'].includes(action)) {
      logger.error(`Action must be 'add', 'remove' or 'list', got '${action}'.`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;
    const cfg = this.configManager.getAll() as { gateway?: { statusRecipients?: string[] } };
    const recipients = [...(cfg.gateway?.statusRecipients ?? [])];
    if (action === 'list') {
      logger.info('Gateway status recipients (always get pipeline completion summaries):');
      if (recipients.length === 0) console.log('  (none — add one with: nuvira config gateway notify add whatsapp:Alex)');
      for (const t of recipients) console.log(`  📊  ${t}`);
      return;
    }
    if (targets.length === 0) {
      logger.error(`Provide at least one target (alias or platform:channelId) for '${action}'.`);
      return;
    }
    if (action === 'add') {
      const added = targets.filter((t) => !recipients.includes(t));
      const next = [...recipients, ...added];
      this.configManager.save({ gateway: { statusRecipients: next } });
      logger.success(`Added ${added.length} status recipient(s): ${added.join(', ') || '(all already present)'}`);
    } else {
      const removed = targets.filter((t) => recipients.includes(t));
      const next = recipients.filter((t) => !targets.includes(t));
      this.configManager.save({ gateway: { statusRecipients: next } });
      logger.success(`Removed ${removed.length} status recipient(s): ${removed.join(', ') || '(none were present)'}`);
    }
    logger.info('Applied to the running gateway immediately (recipients re-read per pipeline).');
  }

  private listPlatforms(): void {
    logger.info('Gateway platform transports (values live in ~/.nuvira/.env or env vars):');
    for (const p of configurablePlatforms()) {
      const st = platformConfigStatus(p);
      console.log(`  ${st.configured ? '✅' : '❌'}  ${st.label} (${p})`);
      for (const v of st.envVars) {
        console.log(`       ${v.varName}=${v.set ? redactValue(v.value) : '<unset>'}`);
      }
    }
    console.log('');
    console.log('Configure one with: nuvira config gateway set <platform>');
  }

  private async setPlatform(platform: string, opts: { set?: string[] }): Promise<void> {
    if (!(platform in PLATFORM_ENV_VARS)) {
      logger.error(`Unknown platform '${platform}' — see \`${getCliName()} config gateway list\`.`);
      return;
    }
    if (platform === 'whatsapp' || platform === 'mock') {
      logger.error(`'${platform}' is not env-configured — use \`${getCliName()} whatsapp pair\` for the personal bridge.`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;

    const meta = platformEnvVarMeta(platform as Platform);
    const current = platformConfigStatus(platform as Platform);
    const provided: Record<string, string> = {};
    for (const kv of opts.set ?? []) {
      const eq = kv.indexOf('=');
      if (eq === -1) {
        logger.error(`--set expects VAR=value, got '${kv}'`);
        return;
      }
      provided[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
    }

    const values: Record<string, string> = {};
    if (process.stdin.isTTY && Object.keys(provided).length === 0) {
      const questions = meta.map((m) => {
        const cur = current.envVars.find((v) => v.varName === m.varName);
        return {
          type: m.secret ? 'password' : 'input',
          name: m.varName,
          // An additional transport mode (Slack Socket Mode's app token, a
          // webhook URL) is asked for with `m.prompt` already saying "(optional)":
          // leaving it blank is a valid choice, and blank means "skip" below.
          message: `${m.prompt}${cur?.set ? ' (enter = keep current)' : ''}:`,
          ...(cur?.set ? { default: cur.value } : {}),
        };
      });
      const answers = (await inquirer.prompt(questions)) as Record<string, string>;
      for (const m of meta) {
        const cur = current.envVars.find((v) => v.varName === m.varName);
        const answer = answers[m.varName];
        if (typeof answer === 'string' && answer.trim().length > 0) values[m.varName] = answer.trim();
        else if (cur?.set) values[m.varName] = cur.value;
      }
    } else {
      for (const m of meta) {
        const cur = current.envVars.find((v) => v.varName === m.varName);
        if (provided[m.varName]) values[m.varName] = provided[m.varName];
        else if (cur?.set) values[m.varName] = cur.value;
        // Optional transport vars are not demanded: `--set <bot token>` alone must
        // keep working for an outbound-only setup (it did before these were
        // offered here, and failing it now would be a regression in the surface).
        else if (m.optional) continue;
        else {
          logger.error(`Missing --set ${m.varName}=<value> (non-interactive mode).`);
          return;
        }
      }
    }

    if (Object.keys(values).length === 0) {
      logger.info('No changes.');
      return;
    }
    const { wrote } = writeEnvFile(values);
    applyEnvToProcess(values);
    logger.success(`Saved ${wrote.join(', ')} → ${envFilePath()}`);
    logger.info(`Restart the gateway/dashboard (or run \`${getCliName()} gateway start\`) to use the new transport.`);
  }

  private async removePlatform(platform: string, opts: { yes?: boolean }): Promise<void> {
    if (!(platform in PLATFORM_ENV_VARS)) {
      logger.error(`Unknown platform '${platform}' — see \`${getCliName()} config gateway list\`.`);
      return;
    }
    if (!guardRbacAction('gateway.manage')) return;
    const keys = platformEnvVarMeta(platform as Platform).map((m) => m.varName);
    if (!keys.some((k) => envVarState(k).set)) {
      logger.info(`Nothing to remove — ${platform} has no configured values.`);
      return;
    }
    if (!opts.yes && process.stdin.isTTY) {
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Remove ${platform} config (${keys.join(', ')}) from ${envFilePath()}?`,
          default: false,
        },
      ]);
      if (!confirm) {
        logger.info('Aborted.');
        return;
      }
    }
    writeEnvFile({}, keys);
    applyEnvToProcess({}, keys);
    logger.success(`Removed ${platform} transport config.`);
  }

  // ─── Third-party services (`${getCliName()} config service`) ─────────────

  /**
   * Service-provider API keys (image / video / search / vision / speech).
   * These are the same env vars the dashboard's Service Provider API Key
   * Configuration section writes — the CLI is never deprecated, so one command
   * configures a backend for both surfaces. Values land in ~/.nuvira/.env.
   */
  /**
   * `config limit` — the two size limits a user can move.
   *
   * Both are ordinary process-environment variables (`NUVIRA_EXTRACT_MAX_CHARS`,
   * `NUVIRA_ATTACHMENT_MAX_BYTES`), so this is a convenience over
   * `config set`/`unset` for the names a user would otherwise have to remember.
   * The values land in the same `~/.nuvira/.env` the dashboard's Process
   * Environment page writes, so the CLI and the dashboard stay parallel.
   */
  private createLimitCommand(): Command {
    const limit = new Command('limit').description(
      'Show or change the size limits for document extraction and attachments',
    );

    limit
      .command('list')
      .description('Show the effective extraction and attachment limits')
      .action(() => this.listLimits());

    limit
      .command('set')
      .description('Set a limit: config limit set <extract-max-chars|attachment-max-kb> <value>')
      .argument('<key>', 'extract-max-chars | attachment-max-kb')
      .argument('<value>', 'A positive integer')
      .action((key: string, value: string) => this.setLimit(key, value));

    limit
      .command('unset')
      .description('Restore a limit to its default')
      .argument('<key>', 'extract-max-chars | attachment-max-kb')
      .action((key: string) => this.unsetLimit(key));

    return limit;
  }

  private listLimits(): void {
    const extract = resolveExtractMaxChars();
    const attach = resolveAttachmentMaxBytes();
    console.log('\n  Size limits');
    console.log(`    extract-max-chars   ${extract.toLocaleString()} characters` +
      (extract === DEFAULT_EXTRACT_MAX_CHARS ? '  (default)' : ''));
    console.log(`    attachment-max-kb   ${Math.round(attach / 1024).toLocaleString()} KB` +
      (attach === DEFAULT_ATTACHMENT_MAX_BYTES ? '  (default)' : ''));
    console.log('\n  Values come from NUVIRA_EXTRACT_MAX_CHARS / NUVIRA_ATTACHMENT_MAX_BYTES');
    console.log('  (or their BUFF_ aliases). A value exported in your shell wins over the file.\n');
  }

  private setLimit(key: string, value: string): void {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      logger.error(`'${value}' is not a positive integer.`);
      return;
    }
    const resolved = this.resolveLimitKey(key);
    if (!resolved) {
      logger.error(`Unknown limit '${key}'. Known: extract-max-chars, attachment-max-kb`);
      return;
    }
    // attachment-max-kb is stored in the BYTES variable the reader actually reads,
    // so the CLI and the dashboard's byte field cannot disagree.
    const stored = resolved.bytesFromValue(n);
    const result = saveEnvValue(resolved.envName, String(stored));
    if (!result.success) {
      logger.error(`Could not write ${resolved.envName} to the env file (${result.reason ?? 'unknown'}).`);
      return;
    }
    logger.success(`✅ ${resolved.envName} = ${stored} — takes effect on the next turn.`);
  }

  private unsetLimit(key: string): void {
    const resolved = this.resolveLimitKey(key);
    if (!resolved) {
      logger.error(`Unknown limit '${key}'. Known: extract-max-chars, attachment-max-kb`);
      return;
    }
    const result = deleteEnvValue(resolved.envName);
    if (!result.success) {
      logger.error(`Could not remove ${resolved.envName} (${result.reason ?? 'unknown'}).`);
      return;
    }
    logger.success(
      result.removed
        ? `✅ ${resolved.envName} removed — back to the default (${resolved.defaultLabel}).`
        : `${resolved.envName} was not set; the default (${resolved.defaultLabel}) still applies.`,
    );
  }

  /** Map a friendly limit key to the env var the reader reads, and its default label. */
  private resolveLimitKey(
    key: string,
  ): { envName: string; bytesFromValue: (n: number) => number; defaultLabel: string } | null {
    switch (key.trim()) {
      case 'extract-max-chars':
        return { envName: 'NUVIRA_EXTRACT_MAX_CHARS', bytesFromValue: (n) => n, defaultLabel: '40,000 characters' };
      case 'attachment-max-kb':
        return {
          envName: 'NUVIRA_ATTACHMENT_MAX_BYTES',
          bytesFromValue: (kb) => kb * 1024,
          defaultLabel: '300 KB',
        };
      default:
        return null;
    }
  }

  /**
   * `config capability` — the reasoning-vs-cost switch.
   *
   * Writes `NUVIRA_CAPABILITY_MODE` into the same `~/.nuvira/.env` the
   * dashboard's Process Environment page writes, so the CLI and the dashboard
   * stay parallel. `balanced` (default) leaves the routing untouched; `max`
   * relaxes the cost gates and always prefers capability. It only ever widens
   * MODEL QUALITY and AUTONOMY — the deterministic safety gates are unchanged.
   */
  private createCapabilityCommand(): Command {
    const capability = new Command('capability').description(
      'Show or change the capability mode (balanced | max)',
    );

    capability
      .command('show', { isDefault: true })
      .description('Show the effective capability mode')
      .action(() => this.showCapability());

    capability
      .command('set')
      .description('Set the capability mode: config capability set <balanced|max>')
      .argument('<mode>', 'balanced | max')
      .action((mode: string) => this.setCapability(mode));

    capability
      .command('unset')
      .description('Restore the default capability mode (balanced)')
      .action(() => this.unsetCapability());

    return capability;
  }

  private showCapability(): void {
    const mode = resolveCapabilityMode(this.configManager);
    console.log('\n  Capability mode');
    console.log(`    ${mode}${mode === DEFAULT_CAPABILITY_MODE ? '  (default)' : ''}`);
    console.log(
      mode === 'max'
        ? '    → cost is not a concern: every turn routes to the strongest model, paid models are always allowed.'
        : '    → best model for complex/critical work, cheaper models for simple work, escalate on a detected stall.',
    );
    console.log('\n  Values come from NUVIRA_CAPABILITY_MODE (or the BUFF_ alias), then routing.capabilityMode.');
    console.log('  A value exported in your shell wins over the file.\n');
  }

  private setCapability(mode: string): void {
    const parsed = parseCapabilityMode(mode);
    if (!parsed) {
      logger.error(`Unknown capability mode '${mode}'. Known: balanced, max`);
      return;
    }
    const result = saveEnvValue('NUVIRA_CAPABILITY_MODE', parsed);
    if (!result.success) {
      logger.error(`Could not write NUVIRA_CAPABILITY_MODE to the env file (${result.reason ?? 'unknown'}).`);
      return;
    }
    logger.success(
      `✅ NUVIRA_CAPABILITY_MODE = ${parsed} — takes effect on the next turn.` +
        (parsed === 'max' ? ' (cost is not a concern — strongest model, every turn)' : ''),
    );
  }

  private unsetCapability(): void {
    const result = deleteEnvValue('NUVIRA_CAPABILITY_MODE');
    if (!result.success) {
      logger.error(`Could not remove NUVIRA_CAPABILITY_MODE (${result.reason ?? 'unknown'}).`);
      return;
    }
    logger.success(
      result.removed
        ? `✅ NUVIRA_CAPABILITY_MODE removed — back to the default (${DEFAULT_CAPABILITY_MODE}).`
        : `NUVIRA_CAPABILITY_MODE was not set; the default (${DEFAULT_CAPABILITY_MODE}) still applies.`,
    );
  }

  private createServiceCommand(): Command {
    const collect = (value: string, previous: string[]): string[] => previous.concat([value]);
    return new Command('service')
      .description('Manage third-party service keys (image/video/search/vision/speech) in ~/.nuvira/.env')
      .addCommand(
        new Command('list')
          .description('Show every service backend and its env-var status')
          .action(() => this.listServices()),
      )
      .addCommand(
        new Command('set')
          .description('Set a service key: config service set <serviceId> <ENV_VAR> <value> (or --set VAR=value)')
          .argument('<serviceId>', 'Service id (e.g. image-gemini, search-brave)')
          .argument('[varName]', 'Env var name for the service (e.g. BRAVE_SEARCH_API_KEY)')
          .argument('[value]', 'Value for that env var')
          .option('--set <var=value>', 'Set a specific env var (repeatable)', collect, [])
          .action((serviceId: string, varName: string | undefined, value: string | undefined, opts: { set?: string[] }) =>
            void this.setService(serviceId, varName, value, opts),
          ),
      )
      .addCommand(
        new Command('unset')
          .description('Remove a service key (all vars, or one with [varName]) from the env file')
          .argument('<serviceId>', 'Service id')
          .argument('[varName]', 'Remove only this env var')
          .option('--yes', 'Skip confirmation')
          .action((serviceId: string, varName: string | undefined, opts: { yes?: boolean }) =>
            void this.unsetService(serviceId, varName, opts),
          ),
      );
  }

  private listServices(): void {
    logger.info('Service provider keys (values live in ~/.nuvira/.env or env vars):');
    for (const group of servicesByCapability()) {
      console.log(`\n  ${group.label}`);
      for (const svc of group.services) {
        const vars = svc.envVars.map((v) => envVarState(v.varName));
        const configured = svc.keyless || vars.every((v) => v.set);
        console.log(`    ${configured ? '✅' : '❌'}  ${svc.label} (${svc.id})`);
        for (const v of vars) {
          console.log(`         ${v.varName}=${v.set ? redactValue(v.value) : '<unset>'}`);
        }
        if (svc.keyless && svc.envVars.length === 0) console.log('         (no key needed — always available)');
      }
    }
    console.log('');
    console.log(`Configure one with: ${getCliName()} config service set <serviceId>`);
  }

  private async setService(
    serviceId: string,
    varName: string | undefined,
    value: string | undefined,
    opts: { set?: string[] },
  ): Promise<void> {
    const def = getServiceDefinition(serviceId);
    if (!def) {
      logger.error(`Unknown service '${serviceId}'. Known ids: ${SERVICE_CATALOG.map((s) => s.id).join(', ')}`);
      return;
    }
    if (def.envVars.length === 0) {
      logger.info(`${def.label} is keyless — there is nothing to configure.`);
      return;
    }
    if (!guardRbacAction('credential.write')) return;

    const allowed = new Set(def.envVars.map((v) => v.varName));
    const values: Record<string, string> = {};
    for (const kv of opts.set ?? []) {
      const eq = kv.indexOf('=');
      if (eq === -1) {
        logger.error(`--set expects VAR=value, got '${kv}'`);
        return;
      }
      const name = kv.slice(0, eq).trim();
      if (!allowed.has(name)) {
        logger.error(`Unknown env var '${name}' for ${def.label}. Valid: ${[...allowed].join(', ')}`);
        return;
      }
      values[name] = kv.slice(eq + 1).trim();
    }
    if (varName !== undefined) {
      if (!allowed.has(varName)) {
        logger.error(`Unknown env var '${varName}' for ${def.label}. Valid: ${[...allowed].join(', ')}`);
        return;
      }
      if (value === undefined) {
        logger.error(`Missing value: ${getCliName()} config service set ${serviceId} ${varName} <value>`);
        return;
      }
      values[varName] = value.trim();
    }

    if (Object.keys(values).length === 0) {
      if (!process.stdin.isTTY) {
        logger.error(`No value given. Use: ${getCliName()} config service set ${serviceId} <ENV_VAR> <value>`);
        return;
      }
      const answers = (await inquirer.prompt(
        def.envVars.map((v) => ({
          type: v.secret ? 'password' : 'input',
          name: v.varName,
          message: `${v.prompt}${envVarState(v.varName).set ? ' (enter = keep current)' : ''}:`,
        })),
      )) as Record<string, string>;
      for (const v of def.envVars) {
        const answer = answers[v.varName];
        if (typeof answer === 'string' && answer.trim().length > 0) values[v.varName] = answer.trim();
      }
    }

    if (Object.keys(values).length === 0) {
      logger.info('No changes.');
      return;
    }
    const { wrote } = writeEnvFile(values);
    applyEnvToProcess(values);
    logger.success(`Saved ${wrote.join(', ')} → ${envFilePath()}`);
    logger.info(`The agent will use ${def.label} on its next call.`);
  }

  private async unsetService(serviceId: string, varName: string | undefined, opts: { yes?: boolean }): Promise<void> {
    const def = getServiceDefinition(serviceId);
    if (!def) {
      logger.error(`Unknown service '${serviceId}'. Known ids: ${SERVICE_CATALOG.map((s) => s.id).join(', ')}`);
      return;
    }
    if (!guardRbacAction('credential.write')) return;
    const allowed = new Set(def.envVars.map((v) => v.varName));
    if (varName !== undefined && !allowed.has(varName)) {
      logger.error(`Unknown env var '${varName}' for ${def.label}. Valid: ${[...allowed].join(', ')}`);
      return;
    }
    const keys = varName !== undefined ? [varName] : def.envVars.map((v) => v.varName);
    if (keys.length === 0) {
      logger.info(`${def.label} is keyless — nothing to remove.`);
      return;
    }
    if (!keys.some((k) => envVarState(k).set)) {
      logger.info(`Nothing to remove — ${def.label} has no configured values.`);
      return;
    }
    if (!opts.yes && process.stdin.isTTY) {
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        { type: 'confirm', name: 'confirm', message: `Remove ${def.label} config (${keys.join(', ')}) from ${envFilePath()}?`, default: false },
      ]);
      if (!confirm) {
        logger.info('Aborted.');
        return;
      }
    }
    writeEnvFile({}, keys);
    applyEnvToProcess({}, keys);
    logger.success(`Removed ${keys.join(', ')}.`);
  }
}
