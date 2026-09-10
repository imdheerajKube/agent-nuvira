/**
 * Admin command — P6 M6.5 governance policy surface for Auto routing.
 *
 * The M2.4 admin schema (routing.governance.*) is enforced inside the
 * auto-router's hard-constraint slot on every pick — violating providers are
 * ELIMINATED, never just scored lower. This command promotes that raw config
 * surface into a first-class admin API:
 *
 *   nuvira admin                        — Show the current policy (alias for `policy`)
 *   nuvira admin policy [--json]        — Current allow/deny policy + enforcement status
 *   nuvira admin allow <provider...>    — Add providers to governance.allowProviders
 *   nuvira admin deny <provider...>     — Add providers to governance.denyProviders
 *   nuvira admin allow-model <m...>     — Add models to governance.allowModels
 *   nuvira admin deny-model <m...>      — Add models to governance.denyModels
 *   nuvira admin max-cost <usd>         — Admin hard max cost per call (joins routing.maxCostUsd)
 *   nuvira admin pii-min <0..1>         — Min privacy score for PII-matching tasks (default 1.0)
 *   nuvira admin unblock on|off         — May `nuvira models unblock` override registry blocks?
 *   nuvira admin clear <field>          — Remove one governance field (policy becomes permissive on it)
 *
 * All writes go through ConfigManager.save() — the same file/path the config
 * CLI writes — so `nuvira config get routing.governance.<key>` agrees with the
 * admin surface. Everything is additive: an empty policy is fully permissive.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class AdminCommand extends BaseCommand {
    /** P6 M6.1 RBAC — local role file + OIDC adapter seam (see enterprise/rbac.ts). */
    private rbac;
    /**
     * Enforce an RBAC action for the current identity; returns false (after
     * logging) when denied. Legacy single-user mode (no role file) stays fully
     * permissive — enabling RBAC never locks you out; once roles are assigned,
     * policy writes require `admin`. Callers abort on false.
     */
    private guard;
    create(): Command;
    private policyCommand;
    private showPolicy;
    private describeEnforcement;
    private allowCommand;
    private denyCommand;
    private allowModelCommand;
    private denyModelCommand;
    private setListField;
    private maxCostCommand;
    private piiMinCommand;
    private unblockCommand;
    private clearCommand;
    private roleCommand;
    private whoamiCommand;
    private cronCommand;
    private parseCronArgs;
    private cronAdd;
    private cronList;
    private cronRemove;
    private cronRun;
}
//# sourceMappingURL=admin.d.ts.map