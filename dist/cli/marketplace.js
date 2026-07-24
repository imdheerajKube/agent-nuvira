/**
 * Marketplace command — Browse and install community plugins and workflow templates.
 *
 * Usage:
 *   buff marketplace browse                   — Browse all available items
 *   buff marketplace browse --workflows       — Browse workflow templates only
 *   buff marketplace browse --plugins         — Browse plugins only
 *   buff marketplace search <query>            — Search across plugins and templates
 *   buff marketplace install <name>            — Install a workflow template
 *   buff marketplace info <name>               — Show details for a marketplace item
 *
 * This command wraps the existing workflow registry and plugin discovery into
 * a unified "marketplace" experience.
 */
import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { getWorkflowTemplates } from '../workflow/templates.js';
import { searchRegistry, installTemplate, getRegistryEntry, getInstalledTemplates, clearRegistryCache, } from '../workflow/registry.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
export class MarketplaceCommand extends BaseCommand {
    create() {
        const command = new Command('marketplace')
            .description('Browse and install community plugins and workflow templates');
        // ── browse ──────────────────────────────────────────────────────────
        command
            .command('browse')
            .description('Browse all available marketplace items')
            .option('--workflows', 'Show workflow templates only')
            .option('--plugins', 'Show plugins only')
            .option('--refresh', 'Force refresh the registry cache')
            .action(async (options) => {
            await this.browse(options || {});
        });
        // ── search ──────────────────────────────────────────────────────────
        command
            .command('search')
            .description('Search across plugins and workflow templates')
            .argument('<query>', 'Search query')
            .action(async (query) => {
            await this.search(query);
        });
        // ── install ─────────────────────────────────────────────────────────
        command
            .command('install')
            .description('Install a workflow template from the registry')
            .argument('<name>', 'Template name from the registry')
            .action(async (name) => {
            await this.install(name);
        });
        // ── info ────────────────────────────────────────────────────────────
        command
            .command('info')
            .description('Show detailed information about a marketplace item')
            .argument('<name>', 'Name of the template or plugin')
            .action(async (name) => {
            await this.showInfo(name);
        });
        return command;
    }
    async browse(options) {
        const showWorkflows = options.workflows || (!options.workflows && !options.plugins);
        const showPlugins = options.plugins || (!options.workflows && !options.plugins);
        if (options.refresh) {
            clearRegistryCache();
        }
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight('  🏪  Agent-Nuvira Marketplace');
        logger.highlight(`${'═'.repeat(60)}`);
        console.log('');
        // ── Built-in workflow templates ────────────────────────────────────
        if (showWorkflows) {
            const builtin = getWorkflowTemplates();
            console.log(`  📦 Built-in Workflow Templates (${builtin.length}):`);
            console.log('');
            for (const t of builtin) {
                const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
                console.log(`    ${t.id.padEnd(24)} ${t.description.slice(0, 55)}${tags}`);
                console.log(`    ${' '.repeat(26)} Steps: ${t.steps.length}${t.useMemory ? '  🧠 memory' : ''}`);
                console.log('');
            }
        }
        // ── Installed registry templates ────────────────────────────────────
        if (showWorkflows) {
            const installed = getInstalledTemplates();
            if (installed.length > 0) {
                console.log(`  🌐 Installed from Registry (${installed.length}):`);
                console.log('');
                for (const t of installed) {
                    const ver = t.version ? ` v${t.version}` : '';
                    const author = t.author ? ` by ${t.author}` : '';
                    console.log(`    ${t.id.padEnd(24)} ${t.description.slice(0, 55)}${ver}${author}`);
                    console.log('');
                }
            }
        }
        // ── Plugins ─────────────────────────────────────────────────────────
        if (showPlugins) {
            const registry = getPluginRegistry();
            const plugins = registry.getAllPlugins();
            if (plugins.length > 0) {
                console.log(`  🔌 Available Plugins (${plugins.length}):`);
                console.log('');
                for (const plugin of plugins) {
                    const meta = plugin.metadata;
                    const ver = meta.version ? ` v${meta.version}` : '';
                    const author = meta.author ? ` by ${meta.author}` : '';
                    console.log(`    ${meta.name.padEnd(24)} ${(meta.description || '').slice(0, 55)}${ver}${author}`);
                    console.log(`    ${' '.repeat(26)} Provider type: ${plugin.getProviderType()}`);
                    console.log('');
                }
            }
            else {
                console.log('  🔌 Plugins:');
                console.log('');
                console.log('    No plugins discovered. Place plugins in ~/.buff/plugins/');
                console.log('');
            }
        }
        // ── Helpful tips ────────────────────────────────────────────────────
        console.log('  ─── Tips ─────────────────────────────────────────────');
        console.log('');
        console.log('  🔍  Search the registry:     buff marketplace search <query>');
        console.log('  📥  Install template:        buff marketplace install <name>');
        console.log('  ℹ️   Show item details:       buff marketplace info <name>');
        console.log('  📋  List workflows:          buff workflow list');
        console.log('  🔌  Manage plugins:          buff plugins list');
        console.log('');
    }
    async search(query) {
        // Search workflow templates first
        const spinner = ora('Searching marketplace...').start();
        let registryResults = [];
        try {
            registryResults = await searchRegistry(query);
        }
        catch {
            // Registry search failed — continue with local results
        }
        // Search built-in templates
        const builtin = getWorkflowTemplates().filter((t) => t.id.includes(query) || t.description.toLowerCase().includes(query.toLowerCase()));
        // Search plugins
        const registry = getPluginRegistry();
        const plugins = registry.getAllPlugins().filter((p) => p.metadata.name.toLowerCase().includes(query.toLowerCase()) ||
            (p.metadata.description || '').toLowerCase().includes(query.toLowerCase()) ||
            p.getProviderType().includes(query));
        spinner.stop();
        const total = registryResults.length + builtin.length + plugins.length;
        if (total === 0) {
            logger.info(`No marketplace items found matching "${query}".`);
            console.log('');
            return;
        }
        logger.highlight(`🔍 Marketplace Results for "${query}" (${total} found)`);
        console.log('');
        if (builtin.length > 0) {
            console.log(`  📦 Built-in Templates (${builtin.length}):`);
            for (const t of builtin) {
                console.log(`    ${t.id.padEnd(24)} ${t.description.slice(0, 60)}`);
            }
            console.log('');
        }
        if (registryResults.length > 0) {
            console.log(`  🌐 Registry Templates (${registryResults.length}):`);
            for (const r of registryResults) {
                const tags = r.tags?.length > 0 ? ` [${r.tags.join(', ')}]` : '';
                console.log(`    ${r.id.padEnd(24)} v${r.version} by ${r.author}${tags}`);
                console.log(`    ${' '.repeat(26)} ${r.description.slice(0, 60)}`);
            }
            console.log('');
        }
        if (plugins.length > 0) {
            console.log(`  🔌 Plugins (${plugins.length}):`);
            for (const p of plugins) {
                console.log(`    ${p.metadata.name.padEnd(24)} ${(p.metadata.description || '').slice(0, 60)}`);
                console.log(`    ${' '.repeat(26)} Provider: ${p.getProviderType()}`);
            }
            console.log('');
        }
        logger.info('Run `buff marketplace info <name>` for details or `buff marketplace install <name>` to install.');
        console.log('');
    }
    async install(name) {
        const spinner = ora(`Installing '${name}'...`).start();
        try {
            const template = await installTemplate(name);
            if (!template) {
                spinner.fail(`Template '${name}' not found in registry.`);
                logger.info('Try `buff marketplace search ' + name + '` to find it.');
                return;
            }
            spinner.stop();
            logger.success(`Successfully installed '${template.id}'`);
            console.log(`  Name: ${template.name}`);
            console.log(`  Steps: ${template.steps.length}`);
            console.log(`  Location: ~/.buff/workflows/registry/${template.id}.json`);
            console.log(`  Run it: buff workflow run ${template.id} "your goal"`);
            console.log('');
        }
        catch (err) {
            spinner.fail('Installation failed');
            logger.error(String(err));
        }
    }
    async showInfo(name) {
        // Check built-in templates first
        const builtin = getWorkflowTemplates().find((t) => t.id === name);
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
                console.log(`  Recommended models:`);
                for (const [agent, model] of Object.entries(builtin.recommendedModels)) {
                    console.log(`    ${agent}: ${model}`);
                }
            }
            console.log('');
            return;
        }
        // Check plugins
        const registry = getPluginRegistry();
        const plugin = registry.getAllPlugins().find((p) => p.metadata.name === name || p.getProviderType() === name);
        if (plugin) {
            logger.highlight(`  🔌  ${plugin.metadata.name} (plugin)`);
            console.log('');
            console.log(`  Provider type: ${plugin.getProviderType()}`);
            console.log(`  Description: ${plugin.metadata.description || 'No description'}`);
            if (plugin.metadata.author)
                console.log(`  Author: ${plugin.metadata.author}`);
            if (plugin.metadata.version)
                console.log(`  Version: ${plugin.metadata.version}`);
            // No homepage field in PluginMetadata — info is shown above
            console.log('');
            return;
        }
        // Check registry
        const spinner = ora('Looking up registry template...').start();
        try {
            const entry = await getRegistryEntry(name);
            spinner.stop();
            if (entry) {
                logger.highlight(`  🌐  ${entry.name} (registry)`);
                console.log('');
                console.log(`  ID: ${entry.id}`);
                console.log(`  Version: ${entry.version}`);
                console.log(`  Author: ${entry.author}`);
                console.log(`  Description: ${entry.description}`);
                console.log(`  Steps: ${entry.stepCount}`);
                if (entry.tags.length > 0)
                    console.log(`  Tags: ${entry.tags.join(', ')}`);
                console.log(`  Updated: ${entry.updatedAt}`);
                console.log('');
                logger.info(`Install: buff marketplace install ${entry.id}`);
                console.log('');
                return;
            }
        }
        catch {
            spinner.stop();
        }
        logger.error(`Marketplace item '${name}' not found.`);
        logger.info(`Search: buff marketplace search ${name}`);
        console.log('');
    }
}
//# sourceMappingURL=marketplace.js.map