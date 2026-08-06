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
import { BaseCommand } from './commands.js';
import type { BuffConfig } from '../config/types.js';
export type HealthStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult {
    name: string;
    status: HealthStatus;
    message: string;
    detail?: string;
    fix?: string;
}
export interface ProviderHealth {
    providerType: string;
    displayName: string;
    configured: boolean;
    checks: CheckResult[];
    overallStatus: HealthStatus;
}
export interface DoctorReport {
    timestamp: number;
    system: CheckResult[];
    providers: ProviderHealth[];
    durationMs: number;
}
/**
 * Result of the P5 M5.1 sidecar probe (`buff doctor --nuvira`).
 *
 * The probe checks an external OpenAI-compatible gateway the way a gateway
 * consumer should: GET {base}/models (reachability + model list), then a
 * best-effort GET {base}/version (many gateways expose one — liteLLM serves
 * it at the root, i.e. {baseWithoutV1}/version).
 */
export interface NuviraSidecarProbe {
    /** 'pass' when /models answers 200; 'fail' when unreachable/HTTP error. */
    status: HealthStatus;
    /** Number of models the gateway lists (0 when unreachable or empty list). */
    modelCount: number;
    /** Gateway version string when the /version probe succeeds, else null. */
    version: string | null;
    /** The base URL probed. */
    baseUrl: string;
    /** Error message when status is 'fail' (or a partial failure like a bad version probe). */
    error?: string;
}
/**
 * Probe the Nuvira sidecar gateway (P5 M5.1). Pure + unit-testable: talks
 * only over HTTP to the given base URL, never touches global state.
 *
 * @param baseUrl   Gateway base URL, default http://127.0.0.1:20128/v1
 * @param timeoutMs Per-request timeout (default 5000ms)
 * @param apiKey    Optional gateway auth token (from providers.nuvira.apiKey) —
 *                  production gateways require one; the probe honors it.
 */
export declare function probeNuviraSidecar(baseUrl?: string, timeoutMs?: number, apiKey?: string): Promise<NuviraSidecarProbe>;
/**
 * Audit integrity check for a JSONL telemetry/audit file: every line must
 * parse as JSON (append-only, tamper-evident shape). Corrupt lines indicate a
 * truncated write or manual tampering. Pure + unit-testable.
 */
export declare function auditJsonlIntegrity(filePath: string): {
    total: number;
    corrupt: number;
};
/**
 * Secrets-hygiene check: for each keyed provider, is the key supplied via a
 * secure env var (or a `~/.buff/.env` file) rather than hardcoded in the
 * plaintext `~/.buff/buffconfig.json`? Pure + testable (env passed in).
 */
export declare function checkSecretsBackend(config: BuffConfig, env: Record<string, string | undefined>): CheckResult;
/**
 * One provider's gateway usage-health flags (M7.4). Aggregated from the
 * quota ledger + cost tracker — NEVER from captured prompt content.
 */
export interface GatewayUsageFlags {
    provider: string;
    /** Total requests tracked for this provider (quota ledger). */
    requests: number;
    /** Total tokens consumed for this provider (quota ledger). */
    tokens: number;
    /** Estimated spend in USD (cost tracker). */
    costUsd: number;
    /** Whether the provider is currently parked (window exhausted / cooldown). */
    parked: boolean;
    /** Ms until the current window resets (0 when not parked). */
    resetsInMs: number;
}
/** Aggregate gateway usage-health view (M7.4), fed to checkGatewayTelemetry. */
export interface GatewayUsage {
    /** Per-provider health flags, sorted by provider name. */
    providers: GatewayUsageFlags[];
    /** Sum of requests across all tracked providers. */
    totalRequests: number;
    /** Sum of tokens across all tracked providers. */
    totalTokens: number;
    /** Sum of estimated spend in USD across all tracked providers. */
    totalCostUsd: number;
}
/**
 * M7.4 telemetry/usage-health check. OPT-IN AND OFF BY DEFAULT: privacy-
 * preserving by construction — the numbers come from aggregate quota/cost
 * tracking, never prompt content. When the flag is off (default) the check is
 * an INFORMATIVE warn with the exact enable command, never a failure; when on
 * it reports the aggregate headline, plus per-provider health flags when
 * `healthFlags` is also enabled.
 */
export declare function checkGatewayTelemetry(config: BuffConfig, usage: GatewayUsage): CheckResult;
/**
 * Build the M7.4 aggregate gateway-usage view from the quota ledger + cost
 * tracker singletons (aggregate counts only — never prompt content).
 * Best-effort: any read failure degrades to an empty usage view.
 *
 * @param configManager When provided, its `routing.quota` limits are used to
 *   compute quota-configured parking (window exhausted), so the per-provider
 *   health flags show parked state accurately.
 */
export declare function buildGatewayUsage(configManager?: import('../config/manager.js').ConfigManager): GatewayUsage;
/**
 * The full M7.1 enterprise self-check, built from pure inputs so it is
 * trivially testable: config snapshot + env + gateway probe result + audit
 * file paths + opt-in gateway usage (M7.4). Returns the ordered CheckResult[]
 * the CLI renders.
 */
export declare function buildEnterpriseChecks(inputs: {
    config: BuffConfig;
    env: Record<string, string | undefined>;
    gatewayProbe: NuviraSidecarProbe | null;
    gatewayConfigured: boolean;
    auditFiles: Array<{
        name: string;
        path: string;
    }>;
    /** M7.4 opt-in gateway usage-health flags (default: empty = no tracked usage). */
    gatewayUsage?: GatewayUsage;
}): CheckResult[];
export declare class DoctorCommand extends BaseCommand {
    create(): Command;
    private runDiagnosis;
    private runWatchMode;
    private runSystemChecks;
    /**
     * Check availability of common CLI tools needed by the runner and sandbox.
     */
    private checkCliTools;
    private checkDocker;
    private checkConnectivity;
    private checkProvider;
    private renderSystemSection;
    private renderEnterpriseSection;
    private renderNuviraSidecarSection;
    private renderProviderSection;
    private renderSummary;
    private autoFix;
    private statusIcon;
    private hasApiKey;
    private createProvider;
    private getEnvVarName;
    private getDefaultModel;
    private getFixSuggestion;
    private getEndpointFailureDetail;
    private getEndpointFix;
    private getGenerationFix;
    private calculateOverallStatus;
    private withTimeout;
}
//# sourceMappingURL=doctor.d.ts.map