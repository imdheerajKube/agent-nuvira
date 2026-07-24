/**
 * Plugins command — Lists and manages agent plugins and workflow templates.
 *
 * Usage:
 *   buff plugins list          — Show discovered plugins and workflow templates
 *   buff plugins scan          — Force re-scan of ~/.buff/agents/ and ~/.buff/workflows/
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { getPluginStats, discoverAgentPlugins, discoverWorkflowPlugins, runAutoDiscovery } from '../plugins/agent-plugin.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { getWorkflowTemplates } from '../workflow/templates.js';
export class PluginsCommand extends BaseCommand {
    create() {
        const command = new Command('plugins')
            .description('Manage provider plugins, agent plugins, and workflow templates');
        // ── list ──────────────────────────────────────────────────────────────
        command
            .command('list')
            .description('List all discovered plugins and workflows')
            .action(() => this.listPlugins());
        // ── scan ──────────────────────────────────────────────────────────────
        command
            .command('scan')
            .description('Force re-scan all plugin directories')
            .action(() => this.scanPlugins());
        return command;
    }
    async listPlugins() {
        const stats = getPluginStats();
        const registry = getPluginRegistry();
        logger.highlight(`${'═'.repeat(60)}`);
        logger.highlight('  🔌  Plugin System');
        logger.highlight(`${'═'.repeat(60)}`);
        // ── Provider plugins (from ~/.buff/plugins/) ─────────────────────────
        const registeredPlugins = registry.getAllPlugins();
        console.log(`\n  🔗 Provider Plugins: ${stats.providerPlugins} discovered, ${registeredPlugins.length} registered`);
        if (registeredPlugins.length > 0) {
            for (const p of registeredPlugins) {
                console.log(`    🔌 ${p.getProviderType()}: ${p.metadata.name} v${p.metadata.version}`);
                if (p.metadata.description) {
                    console.log(`       ${p.metadata.description}`);
                }
            }
        }
        else {
            console.log('    (no provider plugins found in ~/.buff/plugins/)');
            console.log('    Tip: Drop a .js file exporting a ProviderPlugin into ~/.buff/plugins/');
        }
        // ── Built-in workflow templates ──────────────────────────────────────
        const builtinWorkflows = getWorkflowTemplates();
        console.log(`\n  📋 Built-in Workflow Templates: ${builtinWorkflows.length}`);
        for (const w of builtinWorkflows) {
            console.log(`    ${w.id}: ${w.name} (${w.steps.length} steps)`);
        }
        // ── Discovered agent plugins ──────────────────────────────────────────
        console.log(`\n  🤖 Agent Plugins: ${stats.agentPlugins} discovered`);
        if (stats.agentPlugins > 0) {
            try {
                const plugins = await discoverAgentPlugins();
                for (const [type, plugin] of plugins) {
                    console.log(`    📦 ${type}: ${plugin.metadata.name} v${plugin.metadata.version}`);
                }
            }
            catch {
                console.log('    (run `buff plugins scan` to reload)');
            }
        }
        else {
            console.log('    (no agent plugins found in ~/.buff/agents/)');
        }
        // ── Discovered workflow plugins ──────────────────────────────────────
        console.log(`\n  📄 Workflow Plugins: ${stats.workflowPlugins} discovered`);
        if (stats.workflowPlugins > 0) {
            try {
                const workflows = discoverWorkflowPlugins();
                for (const w of workflows) {
                    console.log(`    📄 ${w.id}: ${w.name} (${w.steps.length} steps)`);
                }
            }
            catch {
                console.log('    (run `buff plugins scan` to reload)');
            }
        }
        else {
            console.log('    (no workflow plugins found in ~/.buff/workflows/)');
        }
        // ── Plugin directories ──────────────────────────────────────────────
        console.log(`\n  📁 Plugin Directories:`);
        console.log(`    Provider plugins: ~/.buff/plugins/`);
        console.log(`    Agent plugins: ~/.buff/agents/`);
        console.log(`    Workflow templates: ~/.buff/workflows/`);
        console.log('');
    }
    async scanPlugins() {
        logger.info('Scanning for plugins...');
        const result = await runAutoDiscovery();
        const registry = getPluginRegistry();
        const registeredPlugins = registry.getAllPlugins();
        console.log(`\n  ✅ Scan complete`);
        console.log(`  Provider plugins: ${result.providerPlugins} discovered (${registeredPlugins.length} registered)`);
        console.log(`  Agent plugins: ${result.agentPlugins} discovered`);
        console.log(`  Workflow plugins: ${result.workflowPlugins} discovered`);
        console.log('');
        // Show what was discovered
        for (const p of registeredPlugins) {
            logger.success(`  Provider: ${p.getProviderType()} ← ${p.metadata.name} v${p.metadata.version}`);
        }
        const agentPlugins = await discoverAgentPlugins();
        for (const [type, plugin] of agentPlugins) {
            logger.success(`  Agent: ${type} ← ${plugin.metadata.name} v${plugin.metadata.version}`);
        }
        const workflowPlugins = discoverWorkflowPlugins();
        for (const w of workflowPlugins) {
            logger.success(`  Workflow: ${w.id} ← ${w.name}`);
        }
        if (registeredPlugins.length === 0 && agentPlugins.size === 0 && workflowPlugins.length === 0) {
            console.log('  Tip: Place .js provider files in ~/.buff/plugins/, .js agent files in ~/.buff/agents/,\n        or .json workflow files in ~/.buff/workflows/');
        }
    }
}
//# sourceMappingURL=plugins.js.map