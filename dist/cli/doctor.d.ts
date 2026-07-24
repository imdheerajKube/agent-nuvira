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