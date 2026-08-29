/**
 * Phase command — Phase-wise project scope execution.
 *
 * Manages multi-goal project execution where each phase is a self-contained
 * goal that gets executed via the Orchestrator. Supports create, execute,
 * resume, status, and list operations.
 *
 * Usage:
 *   nuvira phase create "v2.0 Release" "Add auth" "Add API" "Publish"
 *   nuvira phase execute "v2.0 Release"
 *   nuvira phase resume "v2.0 Release"
 *   nuvira phase status "v2.0 Release"
 *   nuvira phase list
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class PhaseCommand extends BaseCommand {
    create(): Command;
    private createScope;
    private executeScope;
    private resumeScope;
    private showStatus;
    private deleteScope;
    private listScopes;
}
//# sourceMappingURL=phase.d.ts.map