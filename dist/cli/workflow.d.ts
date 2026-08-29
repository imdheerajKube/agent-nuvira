/**
 * Workflow command — Lists, runs, and manages workflow templates.
 *
 * Usage:
 *   nuvira workflow list                    — Show available workflow templates
 *   nuvira workflow run quick-fix "goal"    — Run the quick-fix workflow
 *   nuvira workflow search <query>          — Search the GitHub workflow registry
 *   nuvira workflow install <template>      — Install template from the registry
 *   nuvira workflow publish <template-id>   — Prepare a local template for publishing
 *   nuvira workflow info <template>         — Show registry template details
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Workflow command for listing, running, and managing workflow templates.
 */
export declare class WorkflowCommand extends BaseCommand {
    create(): Command;
    private listWorkflows;
    private runWorkflow;
    private searchRegistry;
    private installTemplate;
    private preparePublish;
    private checkUpgrades;
    private showInfo;
}
//# sourceMappingURL=workflow.d.ts.map