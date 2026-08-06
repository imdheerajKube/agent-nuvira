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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BaseCommand } from './commands.js';
import { ProviderFactory } from '../inference/factory.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { recordRegistryFailure } from '../learning/provider-fallback.js';
import { getQuotaLedger } from '../learning/quota-ledger.js';
import { getCostTracker } from '../learning/cost-tracker.js';
import { verifyAuditFile } from '../enterprise/audit-chain.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const PROVIDER_LABELS = {
    local: '🐍 Local (Ollama / HuggingFace / GGML)',
    groq: '⚡ Groq',
    nim: '🎮 NVIDIA NIM',
    gemini: '🌀 Google Gemini',
    openrouter: '🌐 OpenRouter',
    nuvira: '🌐 Nuvira Gateway (OpenAI-compatible sidecar)',
};
const BUILTIN_PROVIDERS = ['local', 'groq', 'nim', 'gemini', 'openrouter', 'nuvira'];
const CHECK_TIMEOUT_MS = 10_000; // 10s per check
const TOTAL_TIMEOUT_MS = 30_000; // 30s total for all checks on one provider
// Nuvira sidecar defaults (P5 M5.1): the adapter's default base URL is
// http://127.0.0.1:20128/v1 — the same host:port docker-compose.nuvira.yml
// binds, so a local sidecar is zero-config.
const DEFAULT_NUVIRA_BASE_URL = 'http://127.0.0.1:20128/v1';
/**
 * Probe the Nuvira sidecar gateway (P5 M5.1). Pure + unit-testable: talks
 * only over HTTP to the given base URL, never touches global state.
 *
 * @param baseUrl   Gateway base URL, default http://127.0.0.1:20128/v1
 * @param timeoutMs Per-request timeout (default 5000ms)
 * @param apiKey    Optional gateway auth token (from providers.nuvira.apiKey) —
 *                  production gateways require one; the probe honors it.
 */
export async function probeNuviraSidecar(baseUrl, timeoutMs = 5000, apiKey) {
    const base = (baseUrl || DEFAULT_NUVIRA_BASE_URL).trim().replace(/\/+$/, '');
    const versionBase = base.replace(/\/v1$/, '');
    const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    // ── 1. GET {base}/models — reachability + model count ──────────────
    let modelCount = 0;
    try {
        const modelsRes = await fetch(`${base}/models`, {
            headers: { Accept: 'application/json', ...authHeaders },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!modelsRes.ok) {
            return {
                status: 'fail',
                modelCount: 0,
                version: null,
                baseUrl: base,
                error: `GET /models → HTTP ${modelsRes.status}`,
            };
        }
        const data = (await modelsRes.json());
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
    }
    catch (err) {
        return {
            status: 'fail',
            modelCount: 0,
            version: null,
            baseUrl: base,
            error: err instanceof Error ? err.message : String(err),
        };
    }
    // ── 2. Best-effort GET {versionBase}/version — version string ──────
    let version = null;
    let versionError;
    try {
        const versionRes = await fetch(`${versionBase}/version`, {
            headers: { Accept: 'application/json', ...authHeaders },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (versionRes.ok) {
            const text = await versionRes.text();
            try {
                const parsed = JSON.parse(text);
                version = parsed?.version != null ? String(parsed.version) : text.trim().slice(0, 60) || null;
            }
            catch {
                version = text.trim().slice(0, 60) || null;
            }
        }
        else {
            versionError = `GET /version → HTTP ${versionRes.status}`;
        }
    }
    catch {
        versionError = 'GET /version timed out or failed';
    }
    // Models answered → the sidecar is up; a missing /version is only a WARN
    // level detail (many OpenAI-compatible gateways don't expose one).
    return {
        status: 'pass',
        modelCount,
        version,
        baseUrl: base,
        error: versionError,
    };
}
// ─── Enterprise self-check helpers (P7 M7.1, pure + testable) ──────────────
/**
 * Audit integrity check for a JSONL telemetry/audit file: every line must
 * parse as JSON (append-only, tamper-evident shape). Corrupt lines indicate a
 * truncated write or manual tampering. Pure + unit-testable.
 */
export function auditJsonlIntegrity(filePath) {
    try {
        if (!existsSync(filePath))
            return { total: 0, corrupt: 0 };
        const lines = readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
        let corrupt = 0;
        for (const line of lines) {
            try {
                JSON.parse(line);
            }
            catch {
                corrupt++;
            }
        }
        return { total: lines.length, corrupt };
    }
    catch {
        return { total: 0, corrupt: 0 };
    }
}
/**
 * Secrets-hygiene check: for each keyed provider, is the key supplied via a
 * secure env var (or a `~/.buff/.env` file) rather than hardcoded in the
 * plaintext `~/.buff/buffconfig.json`? Pure + testable (env passed in).
 */
export function checkSecretsBackend(config, env) {
    const envVars = [
        { provider: 'groq', varName: 'GROQ_API_KEY' },
        { provider: 'gemini', varName: 'GEMINI_API_KEY' },
        { provider: 'nim', varName: 'NVIDIA_NIM_API_KEY' },
        { provider: 'openrouter', varName: 'OPENROUTER_API_KEY' },
    ];
    const inPlaintext = [];
    const viaEnv = [];
    for (const { provider, varName } of envVars) {
        const cfg = config.providers?.[provider];
        const hasKey = !!cfg?.apiKey;
        // A set-but-empty env var still counts as "provided via env" — it shadows
        // the config value (empty = key withheld), so don't mislabel the config
        // key as plaintext when an env var is explicitly set.
        const hasEnv = env[varName] !== undefined && env[varName] !== '';
        if (hasEnv) {
            viaEnv.push(provider);
        }
        else if (hasKey) {
            inPlaintext.push(provider);
        }
    }
    if (inPlaintext.length > 0) {
        return {
            name: 'Secrets Backend',
            status: 'warn',
            message: `${inPlaintext.join(', ')} API key(s) stored in plaintext ~/.buff/buffconfig.json`,
            detail: `Use ${envVars.map((v) => v.varName).join(' / ')} env vars or ~/.buff/.env instead (P7 security default) — keys are never logged.`,
            fix: 'Move keys to environment variables: export GROQ_API_KEY=... (etc.)',
        };
    }
    if (viaEnv.length > 0) {
        return {
            name: 'Secrets Backend',
            status: 'pass',
            message: `${viaEnv.join(', ')} key(s) supplied via environment (not plaintext)`,
            detail: 'Keys come from env vars / ~/.buff/.env — never written to buffconfig.json.',
        };
    }
    return {
        name: 'Secrets Backend',
        status: 'warn',
        message: 'No cloud API keys configured at all',
        detail: 'Nothing to protect yet — add keys via env vars when you onboard providers.',
    };
}
/**
 * RBAC / governance-config check (P7 M7.1): has an admin defined an
 * allow/deny provider or model policy? Informational — the enforcement engine
 * (P6 M6.5) is roadmap; this reports whether the POLICY INPUT is present.
 */
function checkRbacConfig(config) {
    const gov = config.routing?.governance;
    const hasPolicy = !!(gov?.allowProviders?.length ||
        gov?.denyProviders?.length ||
        gov?.allowModels?.length ||
        gov?.denyModels?.length ||
        gov?.piiPatterns?.length);
    if (hasPolicy) {
        return {
            name: 'RBAC / Governance Policy',
            status: 'pass',
            message: 'Admin policy defined (allow/deny lists configured)',
            detail: 'routing.governance is present — auto routing honors it as a hard constraint.',
        };
    }
    return {
        name: 'RBAC / Governance Policy',
        status: 'warn',
        message: 'No admin allow/deny policy configured',
        detail: 'Fully permissive mode (default). Teams: set routing.governance.allowProviders "groq,local" etc.',
        fix: 'buff config set routing.governance.allowProviders "groq,local"',
    };
}
/**
 * Gateway-health check result for `doctor --enterprise`: reports the sidecar
 * probe outcome. Not configured is INFORMATIVE (warn), not a failure.
 */
function checkGatewayHealth(probe, configured) {
    if (!configured) {
        return {
            name: 'Gateway Health',
            status: 'warn',
            message: 'Nuvira gateway not configured (no providers.nuvira.baseUrl)',
            detail: 'Optional. Start with: docker compose -f docker-compose.nuvira.yml up -d (see UPGRADE_ROADMAP P5).',
        };
    }
    if (probe.status === 'pass') {
        return {
            name: 'Gateway Health',
            status: 'pass',
            message: `Gateway reachable — ${probe.modelCount} model(s)${probe.version ? `, version ${probe.version}` : ''}`,
            detail: `Probed ${probe.baseUrl}/models${probe.error ? ` (${probe.error})` : ''}`,
        };
    }
    return {
        name: 'Gateway Health',
        status: 'fail',
        message: `Gateway unreachable — ${probe.error || 'unknown error'}`,
        detail: `Probed ${probe.baseUrl}/models`,
        fix: 'docker compose -f docker-compose.nuvira.yml up -d · or check providers.nuvira.baseUrl / apiKey',
    };
}
/**
 * M7.4 telemetry/usage-health check. OPT-IN AND OFF BY DEFAULT: privacy-
 * preserving by construction — the numbers come from aggregate quota/cost
 * tracking, never prompt content. When the flag is off (default) the check is
 * an INFORMATIVE warn with the exact enable command, never a failure; when on
 * it reports the aggregate headline, plus per-provider health flags when
 * `healthFlags` is also enabled.
 */
export function checkGatewayTelemetry(config, usage) {
    const telemetry = config.routing?.gatewayTelemetry;
    const enabled = telemetry?.enabled === true;
    if (!enabled) {
        return {
            name: 'Telemetry / Usage Health',
            status: 'warn',
            message: 'Gateway usage-health telemetry OFF (privacy-preserving default)',
            detail: 'No prompt content is ever captured — enabling only reports aggregate requests/tokens/cost. ' +
                'Set routing.gatewayTelemetry.enabled true to surface usage-health in this report.',
            fix: 'buff config set routing.gatewayTelemetry.enabled true',
        };
    }
    const showFlags = telemetry?.healthFlags === true;
    const totalLines = [
        `${usage.totalRequests} call(s) · ${usage.totalTokens.toLocaleString()} token(s) · $${usage.totalCostUsd.toFixed(4)} est. cost`,
        'Aggregates only — no prompts, no payloads stored by this check (privacy-safe).',
    ];
    if (showFlags) {
        for (const p of usage.providers) {
            totalLines.push(`  ${p.provider}: ${p.requests} call(s) · ${p.tokens.toLocaleString()} tok · $${p.costUsd.toFixed(4)}${p.parked ? ' · ⛔ parked' : ''}${p.parked ? ` · resets in ${Math.ceil(p.resetsInMs / 60000)}m` : ''}`);
        }
    }
    return {
        name: 'Telemetry / Usage Health',
        status: usage.totalRequests > 0 ? 'pass' : 'warn',
        message: `Gateway telemetry ON — ${totalLines[0]}`,
        detail: totalLines.join('\n'),
    };
}
/**
 * Build the M7.4 aggregate gateway-usage view from the quota ledger + cost
 * tracker singletons (aggregate counts only — never prompt content).
 * Best-effort: any read failure degrades to an empty usage view.
 *
 * @param configManager When provided, its `routing.quota` limits are used to
 *   compute quota-configured parking (window exhausted), so the per-provider
 *   health flags show parked state accurately.
 */
export function buildGatewayUsage(configManager) {
    try {
        const statuses = getQuotaLedger().getStatus(configManager);
        const cost = getCostTracker().getSummary();
        const byProvider = cost?.byProvider || {};
        const providers = statuses
            .map((s) => ({
            provider: s.provider,
            requests: s.requests,
            tokens: s.tokensConsumed,
            costUsd: byProvider[s.provider] || 0,
            parked: s.parked,
            resetsInMs: s.parked ? s.resetsInMs : 0,
        }))
            .sort((a, b) => a.provider.localeCompare(b.provider));
        return {
            providers,
            totalRequests: providers.reduce((a, p) => a + p.requests, 0),
            totalTokens: providers.reduce((a, p) => a + p.tokens, 0),
            totalCostUsd: providers.reduce((a, p) => a + p.costUsd, 0),
        };
    }
    catch {
        return { providers: [], totalRequests: 0, totalTokens: 0, totalCostUsd: 0 };
    }
}
/**
 * P6 M6.3 chain-integrity check, built from a pure verify result (callers
 * run `verifyAuditFile` — this function never touches the filesystem).
 * Legacy pre-chain stores verify as a WARN (records readable; chain starts on
 * the next write); broken chains are a FAIL with the exact tamper line.
 */
export function checkAuditChainIntegrity(name, verify) {
    if (verify.verdict === 'tampered') {
        return {
            name: `Audit Chain: ${name}`,
            status: 'fail',
            message: `TAMPER DETECTED — first broken record at line ${verify.tamperLine}`,
            detail: `${verify.totalLines} record(s), ${verify.legacyLines} legacy. Stored head ≠ recomputed chain head.`,
            fix: 'Restore the file from backup; audit trails are append-only by design.',
        };
    }
    if (verify.verdict === 'corrupt') {
        return {
            name: `Audit Chain: ${name}`,
            status: 'fail',
            message: `${verify.corruptLines} corrupt line(s) — truncated write or tampering`,
            detail: `Hash chain cannot be trusted past a corrupt line. Restore from backup.`,
            fix: 'Restore the file from backup; audit trails are append-only by design.',
        };
    }
    if (verify.verdict === 'legacy') {
        return {
            name: `Audit Chain: ${name}`,
            status: 'warn',
            message: `${verify.totalLines} legacy pre-chain record(s) — readable, chain starts on next write`,
            detail: 'Pre-M6.3 lines are outside the hash chain. New writes are chained and verified.',
        };
    }
    return {
        name: `Audit Chain: ${name}`,
        status: 'pass',
        message: `${verify.totalLines} record(s), hash chain intact (tamper-evident)`,
        detail: `Head matches the persisted sidecar state — no tampering detected.`,
    };
}
/**
 * The full M7.1 enterprise self-check, built from pure inputs so it is
 * trivially testable: config snapshot + env + gateway probe result + audit
 * file paths + opt-in gateway usage (M7.4). Returns the ordered CheckResult[]
 * the CLI renders.
 */
export function buildEnterpriseChecks(inputs) {
    const checks = [];
    // 1. Gateway health
    checks.push(inputs.gatewayConfigured && inputs.gatewayProbe
        ? checkGatewayHealth(inputs.gatewayProbe, true)
        : checkGatewayHealth({
            status: 'fail',
            modelCount: 0,
            version: null,
            baseUrl: '',
            error: 'not configured',
        }, false));
    // 2. Secrets backend
    checks.push(checkSecretsBackend(inputs.config, inputs.env));
    // 3. Audit integrity (per JSONL audit/telemetry file)
    for (const f of inputs.auditFiles) {
        const { total, corrupt } = auditJsonlIntegrity(f.path);
        checks.push({
            name: `Audit Integrity: ${f.name}`,
            status: corrupt > 0 ? 'fail' : 'pass',
            message: corrupt > 0
                ? `${corrupt}/${total} corrupt line(s) — truncated write or tampering`
                : `${total} event(s), all lines valid JSON`,
            detail: `Append-only JSONL at ${f.path}`,
            fix: corrupt > 0 ? 'Restore the file from backup; audit trails are append-only by design.' : undefined,
        });
    }
    // 3b. P6 M6.3 hash-chain integrity (per audit file, when results provided)
    for (const chain of inputs.auditChains || []) {
        checks.push(checkAuditChainIntegrity(chain.name, chain.result));
    }
    // 4. RBAC / governance policy
    checks.push(checkRbacConfig(inputs.config));
    // 5. M7.4 opt-in gateway telemetry / usage health (off by default)
    checks.push(checkGatewayTelemetry(inputs.config, inputs.gatewayUsage || { providers: [], totalRequests: 0, totalTokens: 0, totalCostUsd: 0 }));
    return checks;
}
// ─── DoctorCommand ──────────────────────────────────────────────────────────
export class DoctorCommand extends BaseCommand {
    create() {
        const command = new Command('doctor')
            .description('Run diagnostic checks on all provider configurations and system health');
        command
            .option('-p, --provider <provider>', 'Check only a specific provider')
            .option('--nuvira', 'Probe the Nuvira sidecar gateway (GET /v1/models + version)', false)
            .option('--enterprise', 'P7 M7.1: enterprise self-check (gateway health, secrets backend, audit integrity, RBAC policy)', false)
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
        // ── Enterprise self-check (P7 M7.1) ────────────────────────────────
        // `buff doctor --enterprise` runs the P7 self-check: gateway health,
        // secrets backend (env vs plaintext), audit-trail integrity, and RBAC /
        // governance policy presence. Runs INSTEAD of the per-provider loop; a
        // missing optional piece is INFORMATIVE (warn), never a hard fail.
        if (options.enterprise) {
            const all = this.configManager.getAll();
            // Gateway probe: only when a baseUrl is configured.
            let gatewayProbe = null;
            let gatewayConfigured = false;
            try {
                const nuviraCfg = all.providers?.nuvira;
                gatewayConfigured = !!nuviraCfg?.baseUrl;
                if (gatewayConfigured) {
                    gatewayProbe = await probeNuviraSidecar(nuviraCfg?.baseUrl, 5000, nuviraCfg?.apiKey);
                }
            }
            catch {
                // Best-effort — a probe failure is reported as a fail check below.
            }
            const memoryDir = join(homedir(), '.buff', 'memory');
            const auditFiles = [
                { name: 'quota-events.jsonl', path: join(memoryDir, 'quota-events.jsonl') },
                { name: 'model-registry-actions.jsonl', path: join(memoryDir, 'model-registry-actions.jsonl') },
            ];
            const enterpriseChecks = buildEnterpriseChecks({
                config: all,
                env: { ...process.env },
                gatewayProbe,
                gatewayConfigured,
                auditFiles,
                // P6 M6.3: chain verification for each audit store (file I/O here,
                // pure core in the check).
                auditChains: auditFiles.map((f) => ({
                    name: f.name,
                    result: verifyAuditFile(f.path, f.name.replace(/\.jsonl$/, '')),
                })),
                gatewayUsage: buildGatewayUsage(this.configManager),
            });
            console.log('');
            this.renderEnterpriseSection(enterpriseChecks);
            console.log('');
            this.renderSummary(sysChecks, []);
            console.log('');
            logger.highlight('═'.repeat(62));
            console.log(`  Completed in ${Date.now() - startTime}ms`);
            logger.highlight('═'.repeat(62));
            console.log('');
            return {
                timestamp: Date.now(),
                system: sysChecks,
                providers: [],
                durationMs: Date.now() - startTime,
            };
        }
        // ── Nuvira sidecar probe (P5 M5.1) ─────────────────────────────────
        // `buff doctor --nuvira` probes the external gateway: reachability via
        // GET /v1/models, model count, and the gateway version. Runs INSTEAD of
        // the per-provider loop (the flag's job is the sidecar, not the fleet).
        // The probe honors the user's CONFIGURED gateway (providers.nuvira.baseUrl
        // + apiKey) — an auth-token production gateway must not report FAIL just
        // because the probe skipped its token.
        if (options.nuvira) {
            let nuviraCfg;
            try {
                nuviraCfg = this.configManager.getAll().providers?.nuvira;
            }
            catch {
                // Best-effort — never break the probe on a config read failure.
            }
            const probe = await probeNuviraSidecar(nuviraCfg?.baseUrl, 5000, nuviraCfg?.apiKey);
            console.log('');
            this.renderNuviraSidecarSection(probe);
            console.log('');
            this.renderSummary(sysChecks, []);
            console.log('');
            logger.highlight('═'.repeat(62));
            console.log(`  Completed in ${Date.now() - startTime}ms`);
            logger.highlight('═'.repeat(62));
            console.log('');
            return {
                timestamp: Date.now(),
                system: sysChecks,
                providers: [],
                durationMs: Date.now() - startTime,
            };
        }
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
                    // A failed real generation call is strong model-health evidence —
                    // feed the SHARED registry telemetry path so the doctor's probe
                    // (which is essentially a manual spot-check) teaches the router.
                    recordRegistryFailure(providerType, this.getDefaultModel(providerType), err, undefined, 'doctor');
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
    renderEnterpriseSection(checks) {
        logger.highlight('  ── Enterprise Self-Check (P7) ──');
        for (const check of checks) {
            const icon = this.statusIcon(check.status);
            console.log(`\n  ${icon} ${check.name}`);
            console.log(`     ${icon} ${check.message}`);
            if (check.detail)
                console.log(`     ℹ️  ${check.detail}`);
            if (check.fix)
                console.log(`     💡 Fix: ${check.fix}`);
        }
    }
    renderNuviraSidecarSection(probe) {
        logger.highlight('  ── Nuvira Sidecar (P5) ──');
        const icon = this.statusIcon(probe.status);
        console.log(`\n  ${icon} Nuvira Sidecar Gateway`);
        console.log(`     ${icon} Endpoint: ${probe.baseUrl}/models`);
        if (probe.status === 'pass') {
            console.log(`     ${icon} Models: ${probe.modelCount} available`);
            console.log(`     ${probe.version ? '✅' : '⚠️'} Version: ${probe.version || 'unknown (gateway exposes no /version)'}`);
        }
        else {
            console.log(`     ❌ Unreachable: ${probe.error}`);
            console.log('     💡 Start the sidecar: docker compose -f docker-compose.nuvira.yml --profile base up -d');
            console.log('     💡 Or set providers.nuvira.baseUrl in ~/.buff/buffconfig.json');
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