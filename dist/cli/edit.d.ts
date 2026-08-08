import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Edit command — edit files using AI assistance
 * buff edit <file> [--provider nim] [--instruction "add error handling"]
 * buff edit <file> --auto-route -i "add error handling"   (router-ranked walk)
 */
export declare class EditCommand extends BaseCommand {
    create(): Command;
    private execute;
    /** Legacy single-provider path (explicit --provider/--model, no auto). */
    private executeDirect;
    /**
     * ISSUE-003: router-ranked edit walk. Resolves the PRIMARY through the auto
     * router (full feature set: bandit, quota, runtime stats, floors, paid gate)
     * and fails over through the router's ranked candidates via the SHARED
     * single-shot walk — identical to plan/chat/execute so a dead provider is
     * never retried and every failure feeds the shared bookkeeping.
     */
    private executeAutoRouted;
}
//# sourceMappingURL=edit.d.ts.map