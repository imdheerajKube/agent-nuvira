/**
 * Workflow command — Lists, runs, and manages workflow templates.
 *
 * Usage:
 *   buff workflow list                    — Show available workflow templates
 *   buff workflow run quick-fix "goal"    — Run the quick-fix workflow
 *   buff workflow search <query>          — Search the GitHub workflow registry
 *   buff workflow install <template>      — Install template from the registry
 *   buff workflow publish <template-id>   — Prepare a local template for publishing
 *   buff workflow info <template>         — Show registry template details
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