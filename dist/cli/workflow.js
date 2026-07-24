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
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { getWorkflowTemplates, getWorkflowTemplate, buildTaskPlanFromTemplate, buildWorkflowOptions } from '../workflow/templates.js';
import { searchRegistry, installTemplate, getRegistryEntry, getInstalledTemplates, validateForPublish, prepareForPublish, getPublishUrl, clearRegistryCache, checkForUpgrades, } from '../workflow/registry.js';
import { logger } from '../utils/logger.js';
import { printOrchestrationResult } from './execute.js';
/**
 * Workflow command for listing, running, and managing workflow templates.
 */
export class WorkflowCommand extends BaseCommand {
    create() {
        const command = new Command('workflow')
            .description('Run, manage, and share workflow templates');
        // ── list ──────────────────────────────────────────────────────────────
        command
            .command('list')
            .description('Show available workflow templates (built-in + installed)')
            .action(() => {
            this.listWorkflows();
        });
        // ── run ───────────────────────────────────────────────────────────────
        command
            .command('run')
            .description('Run a workflow template')
            .argument('<template>', 'Template name')
            .argument('<goal>', 'The goal to accomplish')
            .option('-p, --provider <provider>', 'Inference provider override')
            .option('-m, --model <model>', 'Model override')
            .option('--dry-run', 'Preview changes without writing to disk', false)
            .option('-v, --verbose', 'Show detailed agent output', false)
            .action(async (template, goal, options) => {
            await this.runWorkflow(template, goal, options);
        });
        // ── search ────────────────────────────────────────────────────────────
        command
            .command('search')
            .description('Search the GitHub workflow template registry')
            .argument('<query>', 'Search query (e.g., "security", "test", "react")')
            .option('--refresh', 'Force refresh the registry cache')
            .action(async (query, options) => {
            await this.searchRegistry(query, options);
        });
        // ── install ──────────────────────────────────────────────────────────
        command
            .command('install')
            .description('Install a workflow template from the GitHub registry')
            .argument('<template>', 'Template name from the registry (use `buff workflow search` to find templates)')
            .action(async (template) => {
            await this.installTemplate(template);
        });
        // ── publish ──────────────────────────────────────────────────────────
        command
            .command('publish')
            .description('Prepare a local workflow template for publishing to the registry')
            .argument('<template-id>', 'The ID of the local template to publish (must exist in ~/.buff/workflows/)')
            .action(async (templateId) => {
            await this.preparePublish(templateId);
        });
        // ── info ──────────────────────────────────────────────────────────────
        command
            .command('info')
            .description('Show detailed information about a registry template')
            .argument('<template>', 'Template name from the registry')
            .action(async (template) => {
            await this.showInfo(template);
        });
        // ── upgrade ────────────────────────────────────────────────────────────
        command
            .command('upgrade')
            .description('Check for and apply template upgrades from the registry')
            .action(async () => {
            await this.checkUpgrades();
        });
        return command;
    }
    // ─── Action Handlers ──────────────────────────────────────────────────
    listWorkflows() {
        const builtin = getWorkflowTemplates();
        const installed = getInstalledTemplates();
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight('  📋  Available Workflow Templates');
        logger.highlight(`${'═'.repeat(60)}`);
        // Built-in templates
        console.log(`\n  📦 Built-in (${builtin.length}):`);
        for (const t of builtin) {
            const tags = t.tags ? ` [${t.tags.join(', ')}]` : '';
            console.log(`    ${t.id.padEnd(22)} ${t.description.slice(0, 50)}...${tags}`);
            console.log(`    ${' '.repeat(24)} Steps: ${t.steps.length}${t.useMemory ? '  🧠 memory' : ''}`);
        }
        // Installed registry templates
        if (installed.length > 0) {
            console.log(`\n  🌐 Installed from registry (${installed.length}):`);
            for (const t of installed) {
                const ver = t.version ? ` v${t.version}` : '';
                const author = t.author ? ` by ${t.author}` : '';
                console.log(`    ${t.id.padEnd(22)} ${t.description.slice(0, 50)}...${ver}${author}`);
            }
        }
        console.log(`\n  💡 Use 'buff workflow search <query>' to find templates in the registry.`);
        console.log(`     Use 'buff workflow install <name>' to install from the registry.`);
        console.log('');
    }
    async runWorkflow(templateId, goal, options) {
        // Check built-in templates first
        let template = getWorkflowTemplate(templateId);
        // If not found, check installed registry templates
        if (!template) {
            const installed = getInstalledTemplates();
            template = installed.find((t) => t.id === templateId);
        }
        // If still not found, offer to install from registry
        if (!template) {
            logger.error(`Unknown workflow template: '${templateId}'`);
            console.log(`\n  💡 Search the registry: buff workflow search ${templateId}`);
            console.log(`     Install from registry: buff workflow install ${templateId}`);
            console.log(`     Available built-in: ${getWorkflowTemplates().map((t) => t.id).join(', ')}`);
            return;
        }
        // Build the task plan from the template
        const taskPlan = buildTaskPlanFromTemplate(template, goal);
        const workflowOptions = buildWorkflowOptions(template, options);
        if (options.verbose) {
            logger.info(`Workflow: ${template.name}`);
            logger.info(`Template: ${template.id}`);
            logger.info(`Steps: ${taskPlan.length}`);
            if (template.recommendedModels) {
                logger.info('Recommended models:');
                for (const [agent, model] of Object.entries(template.recommendedModels)) {
                    logger.info(`  ${agent}: ${model}`);
                }
            }
            console.log('');
        }
        // Execute via orchestrator with the pre-built plan
        const spinner = ora({
            text: `Running workflow '${template.id}'...`,
            spinner: 'dots',
        }).start();
        try {
            const orchestrator = new Orchestrator(this.configManager);
            const result = await orchestrator.execute(goal, {
                ...workflowOptions,
                provider: options.provider,
                model: options.model,
                dryRun: options.dryRun,
                verbose: options.verbose,
                prefillPlan: taskPlan, // Skip the planner, use the pre-built plan
            });
            spinner.stop();
            console.log('');
            printOrchestrationResult(result);
        }
        catch (err) {
            spinner.fail(`Workflow '${template.id}' failed`);
            logger.error(String(err));
        }
    }
    async searchRegistry(query, options) {
        if (options?.refresh) {
            clearRegistryCache();
        }
        const spinner = ora('Searching workflow registry...').start();
        try {
            const results = await searchRegistry(query);
            spinner.stop();
            if (results.length === 0) {
                logger.info(`No templates found matching "${query}".`);
                console.log('  The registry is at: https://github.com/agent-baba-d/workflows');
                console.log('  You can submit your own templates there!');
                return;
            }
            logger.highlight(`${'═'.repeat(60)}`);
            logger.highlight(`  🔍  Registry Results: "${query}" (${results.length} found)`);
            logger.highlight(`${'═'.repeat(60)}`);
            for (const entry of results) {
                const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
                console.log(`\n  ${entry.id.padEnd(22)} v${entry.version} by ${entry.author}`);
                console.log(`  ${' '.repeat(24)} ${entry.description.slice(0, 80)}`);
                console.log(`  ${' '.repeat(24)} ${entry.stepCount} steps  |  Updated: ${entry.updatedAt.slice(0, 10)}${tags}`);
                if (entry.sourceUrl) {
                    console.log(`  ${' '.repeat(24)} ${entry.sourceUrl}`);
                }
            }
            console.log(`\n  Install: buff workflow install <template-id>`);
            console.log('');
        }
        catch (err) {
            spinner.fail('Registry search failed');
            logger.error(String(err));
        }
    }
    async installTemplate(templateId) {
        const spinner = ora(`Installing '${templateId}'...`).start();
        try {
            const template = await installTemplate(templateId);
            spinner.stop();
            if (template) {
                const stepCount = template.steps.length;
                logger.success(`Successfully installed '${template.id}'`);
                console.log(`  Name: ${template.name}`);
                console.log(`  Steps: ${stepCount}`);
                console.log(`  Location: ~/.buff/workflows/registry/${template.id}.json`);
                console.log(`\n  Run it: buff workflow run ${template.id} "your goal"`);
            }
        }
        catch (err) {
            spinner.fail('Installation failed');
            logger.error(String(err));
        }
    }
    async preparePublish(templateId) {
        console.log('');
        logger.highlight(`  📤  Preparing '${templateId}' for publishing`);
        console.log('');
        // Validate
        const validation = validateForPublish(templateId);
        if (!validation.valid) {
            logger.error('Validation failed:');
            for (const err of validation.errors) {
                console.log(`    ❌ ${err}`);
            }
            return;
        }
        if (validation.warnings.length > 0) {
            logger.info('Warnings:');
            for (const w of validation.warnings) {
                console.log(`    ⚠️  ${w}`);
            }
            console.log('');
        }
        // Generate the publish-ready JSON
        const publishData = prepareForPublish(templateId);
        if (!publishData)
            return;
        logger.success('Template validated successfully!');
        console.log('');
        // Display the publish data and instructions
        console.log('  📄 Template data ready for publishing:');
        console.log('');
        // Show a preview (first 500 chars)
        const preview = publishData.length > 500 ? publishData.slice(0, 500) + '\n  ...' : publishData;
        for (const line of preview.split('\n')) {
            console.log(`  ${line}`);
        }
        console.log('');
        logger.highlight(`${'═'.repeat(60)}`);
        console.log('');
        console.log('  To publish this template:');
        console.log('    1. Create a pull request at:');
        console.log(`       ${getPublishUrl()}`);
        console.log('    2. Include the template JSON shown above');
        console.log('    3. The template will be reviewed and added to the registry');
        console.log('');
        console.log('  Or visit the registry repo:');
        console.log('    https://github.com/agent-baba-d/workflows');
        console.log('');
    }
    async checkUpgrades() {
        const spinner = ora('Checking for template upgrades...').start();
        try {
            const upgrades = await checkForUpgrades();
            spinner.stop();
            if (upgrades.length === 0) {
                logger.success('All installed templates are up to date.');
                return;
            }
            logger.highlight(`${'═'.repeat(60)}`);
            logger.highlight(`  ⬆️  Template Upgrades Available (${upgrades.length})`);
            logger.highlight(`${'═'.repeat(60)}`);
            for (const upgrade of upgrades) {
                console.log(`\n  ${upgrade.id}`);
                console.log(`    Current: v${upgrade.currentVersion}`);
                console.log(`    Latest:  v${upgrade.latestVersion}`);
            }
            console.log(`\n  To upgrade a template: buff workflow install <template-id>`);
            console.log('  (This will overwrite the local version with the latest from the registry)');
            console.log('');
        }
        catch (err) {
            spinner.fail('Upgrade check failed');
            logger.error(String(err));
        }
    }
    async showInfo(templateId) {
        const spinner = ora('Fetching template info...').start();
        try {
            const entry = await getRegistryEntry(templateId);
            spinner.stop();
            if (!entry) {
                // Check if it's a built-in template
                const builtin = getWorkflowTemplate(templateId);
                if (builtin) {
                    logger.highlight(`  📋  ${builtin.name} (built-in)`);
                    console.log('');
                    console.log(`  ID: ${builtin.id}`);
                    console.log(`  Description: ${builtin.description}`);
                    console.log(`  Steps: ${builtin.steps.length}`);
                    for (const step of builtin.steps) {
                        console.log(`    ▶ [${step.agentType}] ${step.description}`);
                    }
                    if (builtin.recommendedModels) {
                        console.log(`\n  Recommended models:`);
                        for (const [agent, model] of Object.entries(builtin.recommendedModels)) {
                            console.log(`    ${agent}: ${model}`);
                        }
                    }
                    console.log('');
                    return;
                }
                logger.error(`Template '${templateId}' not found in registry or built-in templates.`);
                logger.info(`Search: buff workflow search ${templateId}`);
                return;
            }
            logger.highlight(`  📋  ${entry.name} (registry)`);
            console.log('');
            console.log(`  ID: ${entry.id}`);
            console.log(`  Version: ${entry.version}`);
            console.log(`  Author: ${entry.author}`);
            console.log(`  Description: ${entry.description}`);
            console.log(`  Steps: ${entry.stepCount}`);
            if (entry.tags.length > 0) {
                console.log(`  Tags: ${entry.tags.join(', ')}`);
            }
            console.log(`  Updated: ${entry.updatedAt}`);
            console.log(`  \n  Install: buff workflow install ${entry.id}`);
            console.log('');
        }
        catch (err) {
            spinner.fail('Failed to fetch template info');
            logger.error(String(err));
        }
    }
}
//# sourceMappingURL=workflow.js.map