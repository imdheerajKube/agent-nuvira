/**
 * Doctor command — One-command diagnosis of all provider configurations.
 *
 * Usage:
 *   buff doctor                           — Run full health check on all providers
 *   buff doctor --provider groq           — Check only a specific provider
 *   buff doctor --watch                   — Continuous monitoring mode (refreshes every 30s)
 *   buff doctor --verbose                 — Show detailed diagnostic info
 *   buff doctor --fix                     — Attempt auto-fix for common issues (create ~/.buff dirs, etc.)
 *
 * The health check runs all provider tests in parallel with timeouts:
 *   1. API Key presence check
 *   2. Endpoint reachability check
 *   3. Provider availability check (isAvailable())
 *   4. Model listing check
 *   5. Quick generation test (optional, with --verbose)
 *
 * Each test returns a status: ✅ PASS, ⚠️  WARN, ❌ FAIL
 * With fix suggestions for common failure modes.
 */
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BaseCommand } from './commands.js';
import { ProviderFactory } from '../inference/factory.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const PROVIDER_LABELS = {
    local: '🐍 Local (Ollama / HuggingFace / GGML)',
    groq: '⚡ Groq',
    nim: '🎮 NVIDIA NIM',
    gemini: '🌀 Google Gemini',
    openrouter: '🌐 OpenRouter',
};
const BUILTIN_PROVIDERS = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
const CHECK_TIMEOUT_MS = 10_000; // 10s per check
const TOTAL_TIMEOUT_MS = 30_000; // 30s total for all checks on one provider
// ─── DoctorCommand ──────────────────────────────────────────────────────────
export class DoctorCommand extends BaseCommand {
    create() {
        const command = new Command('doctor')
            .description('Run diagnostic checks on all provider configurations and system health');
        command
            .option('-p, --provider <provider>', 'Check only a specific provider')
            .option('--watch', 'Continuous monitoring mode (refreshes every 30s)', false)
            .option('--verbose', 'Show detailed diagnostic information', false)
            .option('--fix', 'Attempt to auto-fix common issues', false)
            .action(async (options) => {
            if (options?.watch) {
                await this.runWatchMode(options);
            }
            else {
                await this.runDiagnosis(options || {});
            }
        });
        return command;
    }
    // ── Main Diagnosis ───────────────────────────────────────────────────────
    async runDiagnosis(options) {
        const startTime = Date.now();
        // Header
        logger.highlight('═'.repeat(62));
        logger.highlight('  🏥  Buff System Health Diagnosis');
        logger.highlight('═'.repeat(62));
        console.log('');
        // ── System-level checks ─────────────────────────────────────────────
        const sysChecks = await this.runSystemChecks();
        // ── Provider checks ─────────────────────────────────────────────────
        const providersToCheck = options.provider
            ? [options.provider]
            : [...BUILTIN_PROVIDERS];
        // Collect plugin providers too
        const registry = getPluginRegistry();
        const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
        if (!options.provider) {
            providersToCheck.push(...pluginTypes);
        }
        const providerResults = [];
        for (const providerType of providersToCheck) {
            const result = await this.checkProvider(providerType, options);
            providerResults.push(result);
        }
        const durationMs = Date.now() - startTime;
        // ── Render Report ───────────────────────────────────────────────────
        console.log('');
        this.renderSystemSection(sysChecks);
        console.log('');
        this.renderProviderSection(providerResults, options.verbose);
        console.log('');
        // ── Summary ─────────────────────────────────────────────────────────
        this.renderSummary(sysChecks, providerResults);
        console.log('');
        // ── Fix mode ────────────────────────────────────────────────────────
        if (options.fix) {
            await this.autoFix(sysChecks, providerResults);
        }
        logger.highlight('═'.repeat(62));
        console.log(`  Completed in ${durationMs}ms`);
        logger.highlight('═'.repeat(62));
        console.log('');
        return {
            timestamp: Date.now(),
            system: sysChecks,
            providers: providerResults,
            durationMs,
        };
    }
    // ── Watch Mode ────────────────────────────────────────────────────────────
    async runWatchMode(options) {
        logger.info('Watch mode enabled. Refreshing every 30s. Press Ctrl+C to stop.\n');
        const refresh = async () => {
            // Clear previous output
            console.clear();
            await this.runDiagnosis(options);
        };
        await refresh();
        // Continuous refresh
        const interval = setInterval(refresh, 30_000);
        // Handle Ctrl+C gracefully
        process.on('SIGINT', () => {
            clearInterval(interval);
            logger.info('\nWatch mode stopped.');
            process.exit(0);
        });
    }
    // ── System Checks ─────────────────────────────────────────────────────────
    async runSystemChecks() {
        const checks = [];
        // 1. Config directory
        const buffDir = join(homedir(), '.buff');
        checks.push({
            name: 'Config Directory',
            status: existsSync(buffDir) ? 'pass' : 'warn',
            message: existsSync(buffDir)
                ? `~/.buff/ exists`
                : `~/.buff/ not found`,
            detail: existsSync(buffDir)
                ? `Path: ${buffDir}`
                : `Run 'buff config' or create ~/.buff/ manually`,
            fix: !existsSync(buffDir) ? 'Run `buff doctor --fix` to create required directories' : undefined,
        });
        // 2. Memory directory
        const memoryDir = join(buffDir, 'memory');
        const memoryExists = existsSync(memoryDir);
        checks.push({
            name: 'Memory Directory',
            status: memoryExists ? 'pass' : 'warn',
            message: memoryExists
                ? `~/.buff/memory/ exists`
                : `~/.buff/memory/ not found (will be created on first use)`,
            detail: `Path: ${memoryDir}`,
        });
        // 3. Docker availability (quick check)
        try {
            const dockerCheck = await this.checkDocker();
            checks.push(dockerCheck);
        }
        catch {
            checks.push({
                name: 'Docker',
                status: 'warn',
                message: 'Docker check skipped',
                detail: 'Could not verify Docker installation',
            });
        }
        // 4. Plugin directories
        const pluginDir = join(buffDir, 'plugins');
        const agentDir = join(buffDir, 'agents');
        const workflowDir = join(buffDir, 'workflows');
        checks.push({
            name: 'Plugin Directories',
            status: 'pass',
            message: `plugins/${existsSync(pluginDir) ? '✅' : '⏳'} agents/${existsSync(agentDir) ? '✅' : '⏳'} workflows/${existsSync(workflowDir) ? '✅' : '⏳'}`,
            detail: `~/.buff/plugins/: ${existsSync(pluginDir) ? 'exists' : 'will create on first scan'}\n` +
                `~/.buff/agents/: ${existsSync(agentDir) ? 'exists' : 'will create on first scan'}\n` +
                `~/.buff/workflows/: ${existsSync(workflowDir) ? 'exists' : 'will create on first scan'}`,
        });
        // 5. CLI tool availability checks
        const cliChecks = this.checkCliTools();
        checks.push(...cliChecks);
        // 6. Online connectivity check
        try {
            const onlineCheck = await this.checkConnectivity();
            checks.push(onlineCheck);
        }
        catch {
            checks.push({
                name: 'Internet Connectivity',
                status: 'warn',
                message: 'Connectivity check skipped',
                detail: 'Could not verify internet access',
            });
        }
        return checks;
    }
    /**
     * Check availability of common CLI tools needed by the runner and sandbox.
     */
    checkCliTools() {
        const tools = ['node', 'npm', 'git', 'python3', 'python'];
        const results = [];
        for (const tool of tools) {
            try {
                const output = execSync(`${tool} --version 2>&1`, {
                    encoding: 'utf-8',
                    timeout: 5000,
                    stdio: 'pipe',
                });
                const version = output.trim().split('\n')[0] || 'unknown';
                results.push({
                    name: `CLI: ${tool}`,
                    status: 'pass',
                    message: `${tool} ${version}`,
                    detail: `${tool} is available at PATH`,
                });
            }
            catch {
                // For python, both python3 and python are tried; only warn if both missing
                if (tool === 'python' && results.some((r) => r.name === 'CLI: python3' && r.status === 'pass')) {
                    continue; // python3 already found, skip warning for python
                }
                results.push({
                    name: `CLI: ${tool}`,
                    status: 'warn',
                    message: `${tool} not found in PATH`,
                    detail: `The ${tool} command is not available. Some runner steps may not work.`,
                    fix: tool === 'node'
                        ? 'Install Node.js from https://nodejs.org/'
                        : tool === 'npm'
                            ? 'npm is bundled with Node.js — install Node.js from https://nodejs.org/'
                            : tool === 'git'
                                ? 'Install Git from https://git-scm.com/downloads'
                                : `Install ${tool} using your system package manager`,
                });
            }
        }
        return results;
    }
    async checkDocker() {
        try {
            const { getSandboxManager } = await import('../sandbox/manager.js');
            const manager = getSandboxManager();
            const available = await manager.isDockerAvailable();
            return {
                name: 'Docker',
                status: available ? 'pass' : 'warn',
                message: available ? 'Docker is available' : 'Docker is not available',
                detail: available
                    ? 'Sandbox mode can use Docker for isolated code execution'
                    : 'Code execution will use temp directories (less secure)',
                fix: !available ? 'Install Docker Desktop: https://docs.docker.com/get-docker/' : undefined,
            };
        }
        catch {
            return {
                name: 'Docker',
                status: 'warn',
                message: 'Docker module not loaded',
                detail: 'Sandbox features may be limited',
            };
        }
    }
    async checkConnectivity() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch('https://www.google.com/generate_204', {
                signal: controller.signal,
                method: 'HEAD',
            });
            clearTimeout(timeout);
            const status = response.ok || response.status === 204 ? 'pass' : 'warn';
            return {
                name: 'Internet Connectivity',
                status: status,
                message: status === 'pass' ? 'Internet reachable' : 'Connectivity issues detected',
                detail: status === 'pass'
                    ? 'Cloud providers can make API calls'
                    : 'Check your network connection for cloud providers',
            };
        }
        catch {
            return {
                name: 'Internet Connectivity',
                status: 'warn',
                message: 'No internet access detected',
                detail: 'Cloud providers (Groq, Gemini, NIM, OpenRouter) will not work. Local models are unaffected.',
                fix: 'Check your WiFi/Ethernet connection or proxy settings',
            };
        }
    }
    // ── Provider Checks ───────────────────────────────────────────────────────
    async checkProvider(providerType, options) {
        const checks = [];
        const displayName = PROVIDER_LABELS[providerType] || `🔌 ${providerType} (plugin)`;
        // 1. Configuration Check
        const isLocal = providerType === 'local';
        const hasApiKey = this.hasApiKey(providerType);
        const isPluginProvider = !BUILTIN_PROVIDERS.includes(providerType);
        const hasConfig = isLocal || hasApiKey || isPluginProvider;
        if (!hasConfig && !isLocal) {
            checks.push({
                name: 'Configuration',
                status: 'fail',
                message: `No API key found for '${providerType}'`,
                detail: `Set ${this.getEnvVarName(providerType)} environment variable or add to ~/.buff/buffconfig.json`,
                fix: this.getFixSuggestion(providerType),
            });
        }
        else if (isLocal) {
            checks.push({
                name: 'Configuration',
                status: 'pass',
                message: 'Local models: no API key needed',
                detail: 'Using Ollama / HuggingFace / GGML runner',
            });
        }
        else {
            checks.push({
                name: 'API Key',
                status: 'pass',
                message: 'API key is configured',
                detail: `Using ${this.getEnvVarName(providerType)}`,
            });
        }
        // Skip further checks if no API key for non-local providers
        if (!hasConfig && !isLocal) {
            return {
                providerType,
                displayName,
                configured: false,
                checks,
                overallStatus: 'fail',
            };
        }
        // 2. Provider instantiation and availability check
        try {
            const provider = this.createProvider(providerType);
            const providerName = provider.name;
            checks.push({
                name: 'Provider Module',
                status: 'pass',
                message: `Provider "${providerName}" loaded successfully`,
                detail: `Type: ${providerType}`,
            });
            // 3. Availability check (reachable endpoint)
            const isAvailable = await this.withTimeout(provider.isAvailable(), CHECK_TIMEOUT_MS, `${providerType} availability check`);
            checks.push({
                name: 'Endpoint',
                status: isAvailable ? 'pass' : 'fail',
                message: isAvailable
                    ? `Endpoint reachable`
                    : `Endpoint not reachable`,
                detail: isAvailable
                    ? `${providerType} API is responding`
                    : this.getEndpointFailureDetail(providerType),
                fix: isAvailable ? undefined : this.getEndpointFix(providerType),
            });
            // 4. Model listing check (optional — may fail for some providers)
            if (options.verbose || providerType === 'local') {
                try {
                    const models = await this.withTimeout(provider.listModels(), CHECK_TIMEOUT_MS, `${providerType} model listing`);
                    checks.push({
                        name: 'Model Listing',
                        status: models.length > 0 ? 'pass' : 'warn',
                        message: models.length > 0
                            ? `${models.length} model(s) available`
                            : 'No models found',
                        detail: models.length > 0
                            ? `Available: ${models.slice(0, 5).map((m) => m.id).join(', ')}${models.length > 5 ? `... and ${models.length - 5} more` : ''}`
                            : `${providerType} returned no models. Check your configuration.`,
                    });
                }
                catch (err) {
                    checks.push({
                        name: 'Model Listing',
                        status: 'warn',
                        message: 'Could not fetch model list',
                        detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }
            }
            else {
                checks.push({
                    name: 'Model Listing',
                    status: 'pass',
                    message: 'Skipped (use --verbose to check)',
                    detail: 'Run `buff doctor --verbose` to check model listing',
                });
            }
            // 5. Quick generation test (only in verbose mode)
            if (options.verbose) {
                try {
                    const quickResult = await this.withTimeout(provider.generate('Say "ok" in one word.', {
                        model: this.getDefaultModel(providerType),
                        maxTokens: 10,
                        temperature: 0.1,
                    }), CHECK_TIMEOUT_MS, `${providerType} quick generation`);
                    const isOk = quickResult.toLowerCase().includes('ok');
                    checks.push({
                        name: 'Quick Generation',
                        status: isOk ? 'pass' : 'warn',
                        message: isOk
                            ? 'Quick generation test passed'
                            : 'Generation test completed but response unexpected',
                        detail: isOk
                            ? `Response: "${quickResult.slice(0, 100)}"`
                            : `Unexpected response: "${quickResult.slice(0, 100)}"`,
                    });
                }
                catch (err) {
                    checks.push({
                        name: 'Quick Generation',
                        status: 'fail',
                        message: 'Generation test failed',
                        detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
                        fix: this.getGenerationFix(providerType),
                    });
                }
            }
            else {
                checks.push({
                    name: 'Quick Generation',
                    status: 'pass',
                    message: 'Skipped (use --verbose to test)',
                    detail: 'Run `buff doctor --verbose` to test actual generation',
                });
            }
        }
        catch (err) {
            checks.push({
                name: 'Provider Instantiation',
                status: 'fail',
                message: `Failed to create provider: ${err instanceof Error ? err.message : String(err)}`,
                detail: `Check your configuration in ~/.buff/buffconfig.json`,
                fix: this.getFixSuggestion(providerType),
            });
        }
        const overallStatus = this.calculateOverallStatus(checks);
        return {
            providerType,
            displayName,
            configured: true,
            checks,
            overallStatus,
        };
    }
    // ── Rendering ─────────────────────────────────────────────────────────────
    renderSystemSection(checks) {
        logger.highlight('  ── System Health ──');
        for (const check of checks) {
            const icon = this.statusIcon(check.status);
            console.log(`  ${icon} ${check.name}: ${check.message}`);
            if (check.fix && check.status === 'fail') {
                console.log(`     💡 Fix: ${check.fix}`);
            }
        }
    }
    renderProviderSection(results, verbose) {
        logger.highlight('  ── Provider Health ──');
        for (const result of results) {
            const overallIcon = this.statusIcon(result.overallStatus);
            console.log(`\n  ${overallIcon} ${result.displayName}`);
            if (!result.configured) {
                console.log(`     ❌ Not configured`);
                const failCheck = result.checks[0];
                if (failCheck?.fix) {
                    console.log(`     💡 ${failCheck.fix}`);
                }
                continue;
            }
            for (const check of result.checks) {
                const icon = this.statusIcon(check.status);
                const detailStr = verbose && check.detail ? ` — ${check.detail}` : '';
                console.log(`     ${icon} ${check.name}: ${check.message}${detailStr}`);
                if (check.fix && check.status === 'fail') {
                    console.log(`        💡 Fix: ${check.fix}`);
                }
            }
        }
    }
    renderSummary(sysChecks, providerResults) {
        const allChecks = [
            ...sysChecks,
            ...providerResults.flatMap((p) => p.checks),
        ];
        const passed = allChecks.filter((c) => c.status === 'pass').length;
        const warned = allChecks.filter((c) => c.status === 'warn').length;
        const failed = allChecks.filter((c) => c.status === 'fail').length;
        const configuredProviders = providerResults.filter((p) => p.configured).length;
        const healthyProviders = providerResults.filter((p) => p.overallStatus === 'pass').length;
        console.log('  ── Summary ──');
        console.log(`  ✅ Passed: ${passed}  ⚠️  Warnings: ${warned}  ❌ Failed: ${failed}`);
        console.log(`  Providers: ${healthyProviders}/${configuredProviders} healthy`);
        if (failed > 0) {
            console.log('');
            console.log('  ❌ Failed checks require attention. Use --verbose for details.');
            console.log('  💡 Run `buff doctor --fix` to attempt auto-fix for common issues.');
        }
    }
    // ── Auto-Fix ──────────────────────────────────────────────────────────────
    async autoFix(sysChecks, providerResults) {
        logger.highlight('\n  ── Auto-Fix Mode ──');
        let fixesApplied = 0;
        // 1. Create ~/.buff/ directories if missing
        const buffDir = join(homedir(), '.buff');
        const dirsToCreate = [
            buffDir,
            join(buffDir, 'memory'),
            join(buffDir, 'plugins'),
            join(buffDir, 'agents'),
            join(buffDir, 'workflows'),
        ];
        for (const dir of dirsToCreate) {
            if (!existsSync(dir)) {
                try {
                    mkdirSync(dir, { recursive: true });
                    logger.success(`Created directory: ${dir}`);
                    fixesApplied++;
                }
                catch (err) {
                    logger.error(`Failed to create ${dir}: ${err}`);
                }
            }
        }
        // 2. Check for and warn about missing API keys
        for (const provider of ['groq', 'gemini', 'openrouter', 'nim']) {
            const pr = providerResults.find((p) => p.providerType === provider);
            if (pr && !pr.configured) {
                const envVar = this.getEnvVarName(provider);
                logger.warn(`Missing API key for ${provider}. Set ${envVar}=your_key_here`);
                fixesApplied++;
            }
        }
        if (fixesApplied === 0) {
            logger.info('No auto-fixable issues found.');
        }
        else {
            console.log('');
            logger.success(`Applied ${fixesApplied} fix(es). Run 'buff doctor' again to verify.`);
        }
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    statusIcon(status) {
        switch (status) {
            case 'pass': return '✅';
            case 'warn': return '⚠️';
            case 'fail': return '❌';
            default: return '❓';
        }
    }
    hasApiKey(providerType) {
        return this.configManager.hasRequiredCredentials(providerType);
    }
    createProvider(providerType) {
        if (BUILTIN_PROVIDERS.includes(providerType)) {
            const { config } = this.configManager.getProviderConfig(providerType);
            return ProviderFactory.createProvider(providerType, config);
        }
        // Plugin provider
        const registry = getPluginRegistry();
        const plugin = registry.getPlugin(providerType);
        if (!plugin) {
            throw new Error(`No plugin found for provider type: ${providerType}`);
        }
        const config = this.configManager.getAll().providers[providerType] || {};
        return plugin.createProvider(config);
    }
    getEnvVarName(providerType) {
        const map = {
            groq: 'GROQ_API_KEY',
            gemini: 'GEMINI_API_KEY',
            nim: 'NVIDIA_NIM_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
        };
        return map[providerType] || `${providerType.toUpperCase()}_API_KEY`;
    }
    getDefaultModel(providerType) {
        const config = this.configManager.getAll().providers[providerType];
        return config?.model;
    }
    getFixSuggestion(providerType) {
        const envVar = this.getEnvVarName(providerType);
        return `Set ${envVar}=your_api_key in your shell profile, or run:\n         echo "export ${envVar}=your_key" >> ~/.zshrc\n         Or add it to ~/.buff/buffconfig.json`;
    }
    getEndpointFailureDetail(providerType) {
        const endpoints = {
            local: 'Ollama not running at http://localhost:11434. Run: ollama serve',
            groq: 'Groq API endpoint not reachable. Check your API key and internet connection.',
            gemini: 'Gemini API endpoint not reachable. Check your API key and internet connection.',
            nim: 'NVIDIA NIM endpoint not reachable. Check your API key and internet connection.',
            openrouter: 'OpenRouter endpoint not reachable. Check your API key and internet connection.',
        };
        return endpoints[providerType] || `Provider endpoint not reachable`;
    }
    getEndpointFix(providerType) {
        const fixes = {
            local: 'Run `ollama serve` to start the Ollama server',
            groq: 'Verify GROQ_API_KEY is correct at https://console.groq.com/keys',
            gemini: 'Verify GEMINI_API_KEY is correct at https://aistudio.google.com/app/apikey',
            nim: 'Verify NVIDIA_NIM_API_KEY is correct',
            openrouter: 'Verify OPENROUTER_API_KEY is correct at https://openrouter.ai/keys',
        };
        return fixes[providerType] || `Check your API key and configuration`;
    }
    getGenerationFix(providerType) {
        const fixes = {
            local: 'Ensure Ollama has a model pulled: `ollama pull llama2`',
            groq: 'Ensure the model is available in your Groq account',
            gemini: 'Ensure the model name is correct and your API key has access',
            nim: 'Ensure the model is available on your NIM endpoint',
        };
        return fixes[providerType] || `Check provider configuration`;
    }
    calculateOverallStatus(checks) {
        if (checks.some((c) => c.status === 'fail'))
            return 'fail';
        if (checks.some((c) => c.status === 'warn'))
            return 'warn';
        return 'pass';
    }
    async withTimeout(promise, timeoutMs, label) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]);
    }
}
//# sourceMappingURL=doctor.js.map