import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   buff models refresh [provider]  — probe + spot-check, update the registry
 *   buff models status [--json]     — show the Model Availability Registry
 *   buff models watch [--interval N]— background daemon keeping the registry fresh
 */
export declare class ModelsCommand extends BaseCommand {
    create(): Command;
    /**
     * Verbose `models status` — the two things routing learns from real usage:
     *  1. REGISTRY-BLOCKED providers — every tracked model unavailable/parked, so
     *     the auto router and fallback chain skip them predictively (sub-ms, no
     *     network). Shows WHY (the learned reason for each blocked model).
     *  2. PER-ACTION telemetry — which action verified/killed which provider ×
     *     model, the exact feed powering the dashboard's "learned from real
     *     usage" panel. A provider killed by ANY action is skipped by all others.
     */
    private printVerboseStatus;
    private execute;
}
//# sourceMappingURL=models.d.ts.map