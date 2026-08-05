import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   buff models refresh [provider]  — probe + spot-check, update the registry
 *   buff models status [--json]     — show the Model Availability Registry
 *   buff models unblock <provider>  — manual escape hatch: release a blocked provider + re-probe
 *   buff models watch [--interval N]— background daemon keeping the registry fresh
 */
export declare class ModelsCommand extends BaseCommand {
    create(): Command;
    /**
     * Resolve the effective `--json` flag for a subcommand.
     *
     * BUG WORKAROUND: the parent `models` command also defines `-j, --json`, and
     * commander's option parser scans the WHOLE arg list against the CURRENT
     * command's options — so a `--json` token typed after a subcommand name
     * (e.g. `models status --json`) is consumed by the PARENT's option, and the
     * subcommand's own `opts.json` stays at its default. Without this, every
     * subcommand `--json` silently fell back to human output (a pre-existing
     * production bug). The token does land in `parent.opts()`, so read it from
     * there when the child's own opts didn't see it.
     */
    private isJsonMode;
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