/**
 * Provider command — List and check health of all inference providers.
 *
 * Usage:
 *   buff provider list              — Show all providers with color-coded status table
 *   buff provider health            — Show detailed health checks for all providers
 *   buff provider health <name>     — Show detailed health for a specific provider
 *   buff provider health --watch    — Continuous monitoring mode (refreshes every 30s)
 *   buff provider health --verbose  — Show detailed diagnostic info
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