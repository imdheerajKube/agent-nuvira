/**
 * Provider command — List and check health of all inference providers.
 *
 * Usage:
 *   nuvira provider list              — Show all providers with color-coded status table
 *   nuvira provider health            — Show detailed health checks for all providers
 *   nuvira provider health <name>     — Show detailed health for a specific provider
 *   nuvira provider health --watch    — Continuous monitoring mode (refreshes every 30s)
 *   nuvira provider health --verbose  — Show detailed diagnostic info
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class ProviderCommand extends BaseCommand {
    create(): Command;
    private listProviders;
    private checkHealth;
    private runWatchMode;
    private getEnvVarName;
    private getEndpointDetail;
    private getEndpointFix;
}
//# sourceMappingURL=provider.d.ts.map