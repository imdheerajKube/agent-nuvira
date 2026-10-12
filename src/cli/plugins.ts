/**
 * Plugins command — Lists and manages agent plugins and workflow templates.
 *
 * Usage:
 *   nuvira plugins list          — Show discovered plugins and workflow templates
 *   nuvira plugins scan          — Force re-scan of ~/.nuvira/agents/ and ~/.nuvira/workflows/
 */

import { Command } from 'commander';

import { BaseCommand, getCliName } from './commands.js';
import { getPluginStats, discoverProviderPlugins, discoverAgentPlugins, discoverWorkflowPlugins, pluginDirectories, runAutoDiscovery } from '../plugins/agent-plugin.js';
import { homedir } from 'node:os';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import { getWorkflowTemplates } from '../workflow/templates.js';

/**
 * The plugin dirs the RUN is actually reading, with the home prefix shortened.
 *
 * Hard-coding `~/.nuvira/…` in the output named a directory the process may never
 * have looked in: with `$NUVIRA_CONFIG_DIR` set (an isolated profile, a sandbox,
 * CI) discovery reads THAT dir, so the listing has to name it. The `~` shortening
 * keeps today's output byte-identical for the default profile.
 */
function dirsForDisplay(): { provider: string; agents: string; workflows: string } {
  const dirs = pluginDirectories();
  const home = homedir();
  const short = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  return { provider: short(dirs.provider), agents: short(dirs.agents), workflows: short(dirs.workflows) };
}

export class PluginsCommand extends BaseCommand {
  create(): Command {
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

  private async listPlugins(): Promise<void> {
    const stats = getPluginStats();
    const registry = getPluginRegistry();
    const dirs = dirsForDisplay();

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  🔌  Plugin System');
    logger.highlight(`${'═'.repeat(60)}`);

    // ── Provider plugins (from ~/.nuvira/plugins/) ─────────────────────────
    const registeredPlugins = registry.getAllPlugins();
    console.log(`\n  🔗 Provider Plugins: ${stats.providerPlugins} discovered, ${registeredPlugins.length} registered`);
    if (registeredPlugins.length > 0) {
      for (const p of registeredPlugins) {
        console.log(`    🔌 ${p.getProviderType()}: ${p.metadata.name} v${p.metadata.version}`);
        if (p.metadata.description) {
          console.log(`       ${p.metadata.description}`);
        }
      }
    } else {
      console.log(`    (no provider plugins found in ${dirs.provider}/)`);
      console.log(`    Tip: Drop a .js file exporting a ProviderPlugin into ${dirs.provider}/`);
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
      } catch {
        console.log('    (run `${getCliName()} plugins scan` to reload)');
      }
    } else {
      console.log(`    (no agent plugins found in ${dirs.agents}/)`);
    }

    // ── Discovered workflow plugins ──────────────────────────────────────
    console.log(`\n  📄 Workflow Plugins: ${stats.workflowPlugins} discovered`);
    if (stats.workflowPlugins > 0) {
      try {
        const workflows = discoverWorkflowPlugins();
        for (const w of workflows) {
          console.log(`    📄 ${w.id}: ${w.name} (${w.steps.length} steps)`);
        }
      } catch {
        console.log('    (run `${getCliName()} plugins scan` to reload)');
      }
    } else {
      console.log(`    (no workflow plugins found in ${dirs.workflows}/)`);
    }

    // ── Plugin directories ──────────────────────────────────────────────
    console.log(`\n  📁 Plugin Directories:`);
    console.log(`    Provider plugins: ${dirs.provider}/`);
    console.log(`    Agent plugins: ${dirs.agents}/`);
    console.log(`    Workflow templates: ${dirs.workflows}/`);
    console.log('');
  }

  private async scanPlugins(): Promise<void> {
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
      const tips = dirsForDisplay();
      console.log(`  Tip: Place .js provider files in ${tips.provider}/, .js agent files in ${tips.agents}/,\n        or .json workflow files in ${tips.workflows}/`);
    }
  }
}
