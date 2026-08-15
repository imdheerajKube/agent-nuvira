import { Command } from 'commander';
import inquirer from 'inquirer';
import { BaseCommand } from './commands.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { clearModelListCache } from '../inference/model-validator.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider, catalogEnvVar, isCatalogKeyless } from '../inference/provider-catalog.js';
import { Vault } from '../enterprise/vault.js';
import { guardRbacAction } from './rbac-guard.js';
import { countKeyStates } from '../config/manager.js';
import { PLATFORM_ENV_VARS, } from '../gateway/channel-directory.js';
import { applyEnvToProcess, configurablePlatforms, envFilePath, envVarState, platformConfigStatus, platformEnvVarMeta, redactValue, writeEnvFile, } from '../gateway/platform-config.js';
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
            .addCommand(this.createVaultCommand())
            .addCommand(this.createGatewayCommand())
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
    /**
     * Phase A1 secret vault: `buff config vault status|migrate-keys`.
     * Vault stores provider API keys in the OS keychain (or an AES-256-GCM
     * encrypted file fallback) so `buffconfig.json` holds `vault:` refs instead
     * of plaintext secrets.
     */
    createVaultCommand() {
        const vault = new Command('vault').description('Secret vault management (Phase A1)');
        vault
            .command('status')
            .description('Show the active vault tier and migration state')
            .action(async () => {
            const v = Vault.open({});
            const st = v.status();
            const cfg = this.configManager.getAll();
            const { refs: refCount, plaintext: plaintextCount } = countKeyStates(cfg);
            const tierLabel = st.tier === 'keyring'
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
            if (st.tier === 'aes-file')
                console.log(`  Encrypted-file entries: ${st.fileEntryCount}`);
            console.log(`  Provider keys in config: ${refCount} vault ref(s), ${plaintextCount} plaintext`);
            if (plaintextCount > 0) {
                console.log(`\n  Run 'buff config vault migrate-keys' to move ${plaintextCount} plaintext key(s) into the vault.`);
            }
            console.log('');
        });
        vault
            .command('log')
            .description('Show recent vault access-log entries (K3 tamper-evident audit)')
            .option('-n, --limit <n>', 'Number of entries to show (default 20)', (v) => parseInt(v, 10) || 20)
            .action(async (options) => {
            const { readVaultAccessLog, VAULT_AUDIT_FILENAME } = await import('../enterprise/vault-audit.js');
            const entries = readVaultAccessLog(options?.limit ?? 20);
            logger.highlight('═'.repeat(64));
            logger.highlight(`  🔐  Vault Access Log (${entries.length} most recent)`);
            logger.highlight('═'.repeat(64));
            console.log('');
            if (entries.length === 0) {
                logger.info(`No vault accesses recorded yet (store: ~/.buff/memory/${VAULT_AUDIT_FILENAME}).`);
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
            console.log('  Verify integrity: buff audit verify · full posture: buff doctor --enterprise');
            console.log('');
        });
        vault
            .command('migrate-keys')
            .description('Move plaintext provider API keys from buffconfig.json into the vault')
            .action(async () => {
            // K4: moving plaintext keys into the vault is a credential write —
            // requires the admin role once RBAC is configured.
            if (!guardRbacAction('credential.write'))
                return;
            const v = Vault.open({});
            const st = v.status();
            if (st.tier === 'none') {
                logger.error('Vault unavailable — no OS keyring and no BUFF_VAULT_PASSPHRASE env. ' +
                    'Set BUFF_VAULT_PASSPHRASE to enable the encrypted-file fallback tier.');
                return;
            }
            this.configManager.attachVault(v);
            try {
                const result = await this.configManager.migrateKeysToVault();
                if (result.migrated === 0) {
                    console.log('  No plaintext keys to migrate — config is already vault-clean.');
                }
                else {
                    const storeLabel = st.tier === 'keyring' ? 'OS keychain' : st.tier === 'os-cli' ? `${st.backend}` : 'AES-256-GCM vault';
                    console.log(`  ✅ Moved ${result.migrated} key(s) into the ${storeLabel} for: ${result.providers.join(', ')}`);
                    console.log('  buffconfig.json now stores vault refs — plaintext keys removed.');
                }
            }
            catch (err) {
                logger.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        return vault;
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
                logger.error(`Unknown config key: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  providers.<name>.apiKeys "k1,k2"  (M2.3 multi-account rotation)\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  routing.bandit\n  routing.allowPaid\n  routing.quota.<provider>.requestsPerWindow\n  routing.governance.allowProviders "groq,local"  (M2.4 admin policy)\n  routing.contextWindows.<model> 16384  (M2.5 context preflight)\n  routing.nuviraSidecar.enabled  (P5 sidecar flag, default false)\n  routing.compression.enabled  (M4.4 conservative compression, default false)`);
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
            let typedValue = value;
            if (field === 'apiKeys') {
                // M2.3 multi-account rotation: comma-separated list of ADDITIONAL keys
                // for the same provider (the primary stays in `apiKey`). E.g.
                //   buff config set providers.groq.apiKeys "k1,k2,k3"
                // Empty/whitespace-only input CLEARS the list (remove rotation keys).
                const keys = value.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
                typedValue = keys;
            }
            else {
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
            });
            // A provider key/model/baseURL change can invalidate the cached live
            // model list (model-validator caches listModels() for 60s). Drop it now
            // so auto routing re-fetches against the new credentials immediately.
            clearModelListCache();
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
            if (BOOLEAN_ROUTING_KEYS.has(field)) {
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
                this.configManager.save({ routing: { [field]: typedValue } });
            }
            else if (NUMERIC_ROUTING_KEYS.has(field)) {
                const num = Number(value);
                if (isNaN(num) || num < 0) {
                    logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
                    return;
                }
                this.configManager.save({ routing: { [field]: num } });
            }
            else {
                logger.error(`Unknown routing config key: ${field}. Valid keys: bandit, allowPaid, capabilityFit, contextFit, partialFlakiness, promptOnWeakModel, promptOnFailover, mlRouter, promotionEnforce, maxCostUsd, minSpeed, minReasoning, mlK, mlMinSamples, mlStrength, promotionMinDecisions`);
                return;
            }
        }
        else if (parts.length === 4 && parts[0] === 'routing' && parts[1] === 'quota') {
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
            this.configManager.save({ routing: { quota } });
        }
        else if (parts.length >= 3 && parts[0] === 'routing' && parts[1] === 'governance') {
            // M2.4 governance policy — routing.governance.<field> where <field> is
            // one of: allowProviders, denyProviders, allowModels, denyModels
            // (comma-separated lists), maxCostUsd / minPrivacyForPii (numbers), or
            // allowUnblock (boolean). Empty/whitespace clears a list.
            const field = parts[2];
            const existing = config.routing?.governance || {};
            let typedValue;
            if (field === 'allowProviders' || field === 'denyProviders' || field === 'allowModels' || field === 'denyModels') {
                typedValue = value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
                this.configManager.save({
                    routing: { governance: { ...existing, [field]: typedValue } },
                });
            }
            else if (field === 'maxCostUsd' || field === 'minPrivacyForPii') {
                const num = Number(value);
                if (isNaN(num) || num < 0) {
                    logger.error(`Invalid number for ${key}: "${value}". Must be a non-negative number.`);
                    return;
                }
                typedValue = num;
                this.configManager.save({
                    routing: { governance: { ...existing, [field]: typedValue } },
                });
            }
            else if (field === 'allowUnblock') {
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
                this.configManager.save({
                    routing: { governance: { ...existing, [field]: typedValue } },
                });
            }
            else if (field === 'piiPatterns') {
                typedValue = value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
                this.configManager.save({
                    routing: { governance: { ...existing, [field]: typedValue } },
                });
            }
            else {
                logger.error(`Unknown governance config key: ${field}. Valid keys: allowProviders, denyProviders, allowModels, denyModels, piiPatterns, maxCostUsd, minPrivacyForPii, allowUnblock`);
                return;
            }
        }
        else if (parts.length >= 3 && parts[0] === 'routing' && parts[1] === 'contextWindows') {
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
            });
            console.log(`✓ ${key} = ${num}`);
        }
        else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'nuviraSidecar') {
            // P5 M5.4 — routing.nuviraSidecar.enabled (boolean feature flag, default
            // false) | routing.nuviraSidecar.image (pinned gateway image/tag for
            // docker-compose.nuvira.yml, overriding the NUVIRA_GATEWAY_IMAGE env).
            const field = parts[2];
            const existing = config.routing?.nuviraSidecar || {};
            if (field === 'enabled') {
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
                    routing: { nuviraSidecar: { ...existing, enabled: typedValue } },
                });
            }
            else if (field === 'image') {
                const image = value.trim();
                if (!image || !/^[a-z0-9._\/-]+(:[\w.\-]+)?$/.test(image)) {
                    logger.error(`Invalid gateway image for ${key}: "${value}". Expected an image:tag (e.g. ghcr.io/berriai/litellm:main-stable).`);
                    return;
                }
                this.configManager.save({
                    routing: { nuviraSidecar: { ...existing, image } },
                });
            }
            else {
                logger.error(`Unknown nuviraSidecar config key: ${field}. Valid keys: enabled, image`);
                return;
            }
        }
        else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'compression') {
            // M4.4 — routing.compression.enabled (boolean, DEFAULT FALSE — lossless-
            // for-code prose compression) | routing.compression.keepRatio (0.1–1) |
            // routing.compression.minProseChars (positive int).
            const field = parts[2];
            const existing = config.routing?.compression || {};
            if (field === 'enabled') {
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
                    routing: { compression: { ...existing, enabled: typedValue } },
                });
            }
            else if (field === 'keepRatio') {
                const num = Number(value);
                if (isNaN(num) || num < 0.1 || num > 1) {
                    logger.error(`Invalid keepRatio for ${key}: "${value}". Must be between 0.1 and 1 (fraction of prose kept).`);
                    return;
                }
                this.configManager.save({
                    routing: { compression: { ...existing, keepRatio: num } },
                });
            }
            else if (field === 'minProseChars') {
                const num = Number(value);
                if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
                    logger.error(`Invalid minProseChars for ${key}: "${value}". Must be a positive integer (chars).`);
                    return;
                }
                this.configManager.save({
                    routing: { compression: { ...existing, minProseChars: num } },
                });
            }
            else {
                logger.error(`Unknown compression config key: ${field}. Valid keys: enabled, keepRatio, minProseChars`);
                return;
            }
        }
        else if (parts.length === 3 && parts[0] === 'routing' && parts[1] === 'gatewayTelemetry') {
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
                routing: { gatewayTelemetry: { ...existing, [field]: typedValue } },
            });
        }
        else {
            logger.error(`Invalid config key format: ${key}. Expected formats:\n  defaultProvider\n  providers.<name>.<field>\n  providers.<name>.apiKeys "k1,k2"\n  pricing.<provider>.inputPer1K\n  pricing.<provider>.outputPer1K\n  history.retentionDays\n  history.semanticSearch\n  fallback.enabled\n  fallback.providers\n  routing.bandit\n  routing.allowPaid\n  routing.quota.<provider>.requestsPerWindow\n  routing.governance.allowProviders "groq,local"\n  routing.nuviraSidecar.enabled\n  routing.compression.enabled  (M4.4, DEFAULT FALSE)\n  routing.gatewayTelemetry.enabled  (M7.4, DEFAULT FALSE)`);
            return;
        }
        logger.success(`Set ${key} = ${value}`);
    }
    listProviders() {
        const config = this.configManager.getAll();
        logger.highlight('\nAvailable Providers:\n');
        // Issue 001: the FULL catalog — every onboardable provider is listed with
        // its catalog label + real env-var hint, not just the 5 built-ins.
        const providers = CATALOG_PROVIDER_IDS.map((type) => {
            const entry = getCatalogProvider(type);
            const name = entry ? `${entry.icon} ${entry.label}` : type;
            const status = isCatalogKeyless(type)
                ? '✅ No key needed (reachability probed)'
                : this.configManager.hasRequiredCredentials(type)
                    ? '✅'
                    : `❌ No API key (${catalogEnvVar(type) || `${type.toUpperCase()}_API_KEY`})`;
            return { name, type: type, status };
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
    initConfig() {
        logger.info('Configuration already initialized with defaults.');
        logger.info('Edit ~/.buff/buffconfig.json or use: buff config set <key> <value>');
        logger.info('Set API keys via environment variables or the config file.');
        console.log('');
        this.displayConfig();
    }
    // ─── Gateway platform transports (`buff config gateway`) ─────────────────
    createGatewayCommand() {
        const collect = (value, previous) => previous.concat([value]);
        const cmd = new Command('gateway')
            .description('Manage gateway platform transports (tokens written to ~/.buff/.env)')
            .addCommand(new Command('list')
            .description('Show every platform transport and its env-var status')
            .action(() => this.listPlatforms()))
            .addCommand(new Command('set')
            .description('Configure a platform transport (interactive wizard, or --set VAR=value)')
            .argument('<platform>', 'Platform id (e.g. telegram, discord, matrix, sms)')
            .option('--set <var=value>', 'Set a specific env var (repeatable; required in non-interactive mode)', collect, [])
            .action((platform, opts) => void this.setPlatform(platform, opts)))
            .addCommand(new Command('remove')
            .description('Remove a platform transport from the env file')
            .argument('<platform>', 'Platform id')
            .option('--yes', 'Skip confirmation')
            .action((platform, opts) => void this.removePlatform(platform, opts)))
            .addCommand(new Command('allow')
            .description('Allow a user/group to trigger the agent on a platform (written to gateway.policies in config)')
            .argument('<platform>', 'Platform id (e.g. whatsapp, telegram, discord)')
            .argument('<kind>', 'user or group')
            .argument('<id...>', 'Sender/group ids (mobile number, telegram user id, group jid, …)')
            .action((platform, kind, ids) => this.allowDisallow(platform, kind, ids, true)))
            .addCommand(new Command('disallow')
            .description('Remove a user/group from the allowed list of a platform')
            .argument('<platform>', 'Platform id')
            .argument('<kind>', 'user or group')
            .argument('<id...>', 'Sender/group ids to remove')
            .action((platform, kind, ids) => this.allowDisallow(platform, kind, ids, false)))
            .addCommand(new Command('reply')
            .description("Set how unapproved senders are handled on a platform: polite (⛔ message) or silent (no reply)")
            .argument('<platform>', 'Platform id')
            .argument('<mode>', 'polite or silent')
            .action((platform, mode) => this.setReplyMode(platform, mode)))
            .addCommand(new Command('notify')
            .description('Manage status recipients — contacts/groups that ALWAYS get pipeline completion summaries')
            .argument('<action>', 'add, remove or list')
            .argument('[target...]', 'Channel target(s): alias or platform:channelId (e.g. whatsapp:Daddy, telegram:123456)')
            .action((action, targets) => this.manageStatusRecipients(action, targets)));
        return cmd;
    }
    /** `buff config gateway allow/disallow <platform> <user|group> <id...>` */
    allowDisallow(platform, kind, ids, allow) {
        if (!(platform in PLATFORM_ENV_VARS)) {
            logger.error(`Unknown platform '${platform}' — see \`buff config gateway list\`.`);
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
        if (!guardRbacAction('gateway.manage'))
            return;
        const cfg = this.configManager.getAll();
        const policies = { ...(cfg.gateway?.policies ?? {}) };
        const pol = { ...(policies[platform] ?? {}) };
        const key = kind === 'user' ? 'allowedUsers' : 'allowedGroups';
        const list = pol[key] ?? [];
        if (allow) {
            const added = ids.filter((id) => !list.includes(id));
            pol[key] = [...list, ...added];
            logger.success(`Allowed ${added.length} ${kind}(s) on ${platform}: ${added.join(', ') || '(all already allowed)'}`);
        }
        else {
            const removed = ids.filter((id) => list.includes(id));
            pol[key] = list.filter((id) => !ids.includes(id));
            if (pol[key]?.length === 0)
                delete pol[key];
            logger.success(`Removed ${removed.length} ${kind}(s) from ${platform}: ${removed.join(', ') || '(none were allowed)'}`);
        }
        policies[platform] = pol; // write the (possibly mutated) platform policy back
        this.configManager.save({ gateway: { policies } });
        logger.info('Applied to the running gateway immediately (policies re-read per inbound).');
    }
    /** `buff config gateway reply <platform> <polite|silent>` */
    setReplyMode(platform, mode) {
        if (!(platform in PLATFORM_ENV_VARS)) {
            logger.error(`Unknown platform '${platform}' — see \`buff config gateway list\`.`);
            return;
        }
        if (mode !== 'polite' && mode !== 'silent') {
            logger.error(`Mode must be 'polite' or 'silent', got '${mode}'.`);
            return;
        }
        if (!guardRbacAction('gateway.manage'))
            return;
        const cfg = this.configManager.getAll();
        const policies = { ...(cfg.gateway?.policies ?? {}) };
        const pol = { ...(policies[platform] ?? {}) };
        // HARD POLICY: silent is the DEFAULT. `polite` must write `silentDrop:
        // false` EXPLICITLY (deleting the key would keep the silent default).
        if (mode === 'silent')
            pol.silentDrop = true;
        else
            pol.silentDrop = false;
        policies[platform] = pol; // write the (possibly mutated) platform policy back
        this.configManager.save({ gateway: { policies } });
        logger.success(`Unapproved senders on ${platform} are now handled ${mode === 'silent' ? 'SILENTLY (no reply)' : 'with a polite refusal message'}.`);
    }
    /** `buff config gateway notify add|remove|list <target...>` */
    manageStatusRecipients(action, targets) {
        if (!['add', 'remove', 'list'].includes(action)) {
            logger.error(`Action must be 'add', 'remove' or 'list', got '${action}'.`);
            return;
        }
        if (!guardRbacAction('gateway.manage'))
            return;
        const cfg = this.configManager.getAll();
        const recipients = [...(cfg.gateway?.statusRecipients ?? [])];
        if (action === 'list') {
            logger.info('Gateway status recipients (always get pipeline completion summaries):');
            if (recipients.length === 0)
                console.log('  (none — add one with: buff config gateway notify add whatsapp:Daddy)');
            for (const t of recipients)
                console.log(`  📊  ${t}`);
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
        }
        else {
            const removed = targets.filter((t) => recipients.includes(t));
            const next = recipients.filter((t) => !targets.includes(t));
            this.configManager.save({ gateway: { statusRecipients: next } });
            logger.success(`Removed ${removed.length} status recipient(s): ${removed.join(', ') || '(none were present)'}`);
        }
        logger.info('Applied to the running gateway immediately (recipients re-read per pipeline).');
    }
    listPlatforms() {
        logger.info('Gateway platform transports (values live in ~/.buff/.env or env vars):');
        for (const p of configurablePlatforms()) {
            const st = platformConfigStatus(p);
            console.log(`  ${st.configured ? '✅' : '❌'}  ${st.label} (${p})`);
            for (const v of st.envVars) {
                console.log(`       ${v.varName}=${v.set ? redactValue(v.value) : '<unset>'}`);
            }
        }
        console.log('');
        console.log('Configure one with: buff config gateway set <platform>');
    }
    async setPlatform(platform, opts) {
        if (!(platform in PLATFORM_ENV_VARS)) {
            logger.error(`Unknown platform '${platform}' — see \`buff config gateway list\`.`);
            return;
        }
        if (platform === 'whatsapp' || platform === 'mock') {
            logger.error(`'${platform}' is not env-configured — use \`buff whatsapp pair\` for the personal bridge.`);
            return;
        }
        if (!guardRbacAction('gateway.manage'))
            return;
        const meta = platformEnvVarMeta(platform);
        const current = platformConfigStatus(platform);
        const provided = {};
        for (const kv of opts.set ?? []) {
            const eq = kv.indexOf('=');
            if (eq === -1) {
                logger.error(`--set expects VAR=value, got '${kv}'`);
                return;
            }
            provided[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
        }
        const values = {};
        if (process.stdin.isTTY && Object.keys(provided).length === 0) {
            const questions = meta.map((m) => {
                const cur = current.envVars.find((v) => v.varName === m.varName);
                return {
                    type: m.secret ? 'password' : 'input',
                    name: m.varName,
                    message: `${m.prompt}${cur?.set ? ' (enter = keep current)' : ''}:`,
                    ...(cur?.set ? { default: cur.value } : {}),
                };
            });
            const answers = (await inquirer.prompt(questions));
            for (const m of meta) {
                const cur = current.envVars.find((v) => v.varName === m.varName);
                const answer = answers[m.varName];
                if (typeof answer === 'string' && answer.trim().length > 0)
                    values[m.varName] = answer.trim();
                else if (cur?.set)
                    values[m.varName] = cur.value;
            }
        }
        else {
            for (const m of meta) {
                const cur = current.envVars.find((v) => v.varName === m.varName);
                if (provided[m.varName])
                    values[m.varName] = provided[m.varName];
                else if (cur?.set)
                    values[m.varName] = cur.value;
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
        logger.info('Restart the gateway/dashboard (or run `buff gateway start`) to use the new transport.');
    }
    async removePlatform(platform, opts) {
        if (!(platform in PLATFORM_ENV_VARS)) {
            logger.error(`Unknown platform '${platform}' — see \`buff config gateway list\`.`);
            return;
        }
        if (!guardRbacAction('gateway.manage'))
            return;
        const keys = platformEnvVarMeta(platform).map((m) => m.varName);
        if (!keys.some((k) => envVarState(k).set)) {
            logger.info(`Nothing to remove — ${platform} has no configured values.`);
            return;
        }
        if (!opts.yes && process.stdin.isTTY) {
            const { confirm } = await inquirer.prompt([
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
}
//# sourceMappingURL=config.js.map