/**
 * AgentPlugin — Interface for third-party agent plugins and auto-discovery.
 *
 * Users can place agent plugin files in ~/.nuvira/agents/ and they will be
 * automatically discovered and registered with the orchestrator at startup.
 *
 * Provider plugins (inference providers):
 * - Any .js file in ~/.nuvira/plugins/
 * - Must export a default object matching the ProviderPlugin interface
 *
 * Agent plugins (agent extensions):
 * - Any .js file in ~/.nuvira/agents/
 * - Must export a default object matching the AgentPlugin interface
 *
 * Workflow plugins:
 * - Any .yaml, .yml, or .json file in ~/.nuvira/workflows/
 * - Defines a sequence of agent steps as a reusable workflow template
 */

import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraDataPath } from '../config/paths.js';

import { Agent } from '../agents/agent.js';
import type { AgentContext, AgentResult, LLMCallFn } from '../agents/agent.js';
import { getModuleRegistry } from '../agents/module-registry.js';
import type { ModuleRegistry } from '../agents/module-registry.js';
import type { WorkflowTemplate } from '../workflow/templates.js';
import { isValidWorkflowTemplate } from '../workflow/templates.js';
import type { ProviderPlugin } from './registry.js';
import { getPluginRegistry } from './registry.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentPluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Which agent types this plugin can act as (e.g., ['writer', 'reviewer']) */
  agentTypes: string[];
}

export interface AgentPlugin {
  metadata: AgentPluginMetadata;
  execute(context: AgentContext, callLLM: (prompt: string) => Promise<string>): Promise<AgentResult>;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * The three plugin directories, resolved PER CALL through `resolveNuviraDataPath`.
 *
 * WHY NOT CONSTANTS. They were module-level, built from `resolveNuviraHome()` —
 * which always answers `~/.nuvira` and ignores `$NUVIRA_CONFIG_DIR`, the exact
 * reach the note on that helper warns about. Measured (2026-10-12): a boot from an
 * isolated run created `package.json` markers in the DEVELOPER'S real
 * `~/.nuvira/agents/` and `~/.nuvira/plugins/`, and "drop a .js file into
 * ~/.nuvira/agents/ and it loads" could only ever be exercised against the machine
 * it ran on — which is how discovery came to build a map nobody read (see
 * `installAgentPlugins`) without a test noticing.
 *
 * Resolving per call fixes both halves: `$NUVIRA_CONFIG_DIR` / `$BUFF_CONFIG_DIR`
 * are honoured even when set after this module is imported, and the discovery path
 * is testable against a temp profile. With no override set the paths are unchanged
 * (`~/.nuvira/<dir>`), so nothing an existing install wrote moves.
 */
function pluginsDir(): string {
  return resolveNuviraDataPath('plugins');
}
function agentsDir(): string {
  return resolveNuviraDataPath('agents');
}
function workflowsDir(): string {
  return resolveNuviraDataPath('workflows');
}

/**
 * The three resolved directories, for the surfaces that have to NAME them.
 *
 * `nuvira plugins list` printed a hard-coded `~/.nuvira/…` while reading wherever
 * the override pointed — the output would name a directory it never looked in.
 */
export function pluginDirectories(): { provider: string; agents: string; workflows: string } {
  return { provider: pluginsDir(), agents: agentsDir(), workflows: workflowsDir() };
}

function ensureDirectories(): void {
  for (const dir of [pluginsDir(), agentsDir(), workflowsDir()]) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
  }

  // The loader uses `import()` and reads `export default`, so these directories
  // hold ES modules. Without a package.json declaring that, Node treats each .js
  // as CommonJS, fails to parse it, re-parses it as ESM, and prints a
  // MODULE_TYPELESS_PACKAGE_JSON warning on every boot for every plugin.
  //
  // Only written while the directory holds no plugin yet: adding the marker
  // changes how EXISTING .js files in there are interpreted, and silently
  // switching a user's working CommonJS plugin to ESM (where `module.exports`
  // throws) would be a worse trade than a warning.
  for (const dir of [pluginsDir(), agentsDir()]) {
    const marker = join(dir, 'package.json');
    try {
      if (existsSync(marker) || !existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
      if (files.length > 0) continue;
      writeFileSync(marker, JSON.stringify({ type: 'module' }, null, 2) + '\n', 'utf-8');
    } catch { /* best-effort: a plugin dir that cannot be written still loads .js */ }
  }
}

// ─── Auto-Discovery ─────────────────────────────────────────────────────────

/**
 * Scan ~/.nuvira/plugins/ for provider plugin .js files and register them
 * with the global PluginRegistry.
 *
 * Each file must export a default object matching the ProviderPlugin interface
 * from ./registry.js. Upon discovery, the plugin is automatically registered
 * so it can be used with: nuvira chat --provider <plugin-type>
 *
 * Returns the number of successfully loaded provider plugins.
 */
export async function discoverProviderPlugins(): Promise<number> {
  ensureDirectories();
  let loaded = 0;

  try {
    const files = readdirSync(pluginsDir()).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = join(pluginsDir(), file);
        // Dynamic import for ESM compatibility
        const mod: { default?: ProviderPlugin } = await import(pluginPath);
        if (!mod.default || !mod.default.metadata || !mod.default.getProviderType) {
          logger.debug(`Skipping ${file}: missing ProviderPlugin interface (need metadata + getProviderType)`);
          continue;
        }

        const plugin = mod.default;
        const type = plugin.getProviderType();
        const registry = getPluginRegistry();

        registry.register(plugin);
        loaded++;
        logger.success(`Auto-discovered provider plugin: ${plugin.metadata.name} v${plugin.metadata.version} (${type})`);
      } catch (err) {
        logger.debug(`Failed to load provider plugin ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to scan ${pluginsDir()}: ${err}`);
  }

  return loaded;
}

/**
 * Wrap a plain-object {@link AgentPlugin} in the {@link Agent} class the
 * ModuleRegistry hands out.
 *
 * WHY AN ADAPTER rather than widening the registry: the registry's contract is a
 * no-arg factory returning an `Agent`, and the orchestrator calls
 * `validate`/`execute`/`cleanup` on what it gets back. A plugin author should not
 * have to import the harness's base class (or even the harness) to ship an agent
 * — they export `{ metadata, execute }` and this makes it fit.
 */
class PluginAgent extends Agent {
  readonly name: string;
  readonly description: string;
  private readonly plugin: AgentPlugin;

  constructor(plugin: AgentPlugin) {
    super();
    this.plugin = plugin;
    this.name = plugin.metadata.name;
    this.description = plugin.metadata.description;
  }

  execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    // The plugin's `callLLM` is the same function with a narrower signature
    // (prompt only), which is assignable — options the plugin ignores are still
    // passed so a plugin that later accepts them keeps working.
    return this.plugin.execute(context, callLLM);
  }
}

/** Result of wiring discovered plugins into the module registry. */
export interface InstallAgentPluginsResult {
  /** Agent types now resolvable by a plan step. */
  registered: string[];
  /** Agent types that replaced a BUILT-IN agent (reported, never silent). */
  shadowed: string[];
}

/**
 * Register discovered agent plugins with the ModuleRegistry so a plan step whose
 * `agentType` matches can actually execute them.
 *
 * This is the step that makes plugin agents real. Discovery alone only produced
 * a map that nobody read: `nuvira plugins list` showed the file while the
 * orchestrator, which resolves agents through the ModuleRegistry, had no idea it
 * existed — a plugin that lists as installed and does nothing when planned. A
 * plugin may deliberately REPLACE a built-in type (that is its own feature);
 * `shadowed` reports each one so the override is visible.
 */
export function installAgentPlugins(
  plugins: Map<string, AgentPlugin>,
  registry: ModuleRegistry = getModuleRegistry(),
): InstallAgentPluginsResult {
  const registered: string[] = [];
  const shadowed: string[] = [];

  for (const [agentType, plugin] of plugins) {
    const existing = registry.getMetadata(agentType);
    if (existing?.isBuiltin) shadowed.push(agentType);

    registry.registerOrOverride(agentType, () => new PluginAgent(plugin), {
      name: plugin.metadata.name,
      description: plugin.metadata.description,
      // Plugin metadata has no icon field — the orchestrator's spinner needs
      // one, so every plugin agent gets the puzzle piece rather than `undefined`.
      icon: '🧩',
      isBuiltin: false,
    });
    registered.push(agentType);
  }

  for (const agentType of shadowed) {
    logger.warn(
      `  ⚠️  agent plugin overrides the built-in '${agentType}' — the plugin runs whenever a plan step asks for it.`,
    );
  }
  return { registered, shadowed };
}

/**
 * Scan ~/.nuvira/agents/ for plugin .js files and load them.
 * Returns a map of agent type → AgentPlugin.
 */
export async function discoverAgentPlugins(): Promise<Map<string, AgentPlugin>> {
  const plugins = new Map<string, AgentPlugin>();

  ensureDirectories();

  try {
    const files = readdirSync(agentsDir()).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = join(agentsDir(), file);
        // Dynamic import for ESM compatibility
        const plugin: { default?: AgentPlugin } = await import(pluginPath);
        if (!plugin.default || !plugin.default.metadata) {
          logger.debug(`Skipping ${file}: missing metadata or default export`);
          continue;
        }

        const agentPlugin = plugin.default;

        for (const agentType of agentPlugin.metadata.agentTypes) {
          plugins.set(agentType, agentPlugin);
          logger.success(`Discovered agent plugin: ${agentPlugin.metadata.name} v${agentPlugin.metadata.version} (${agentType})`);
        }
      } catch (err) {
        logger.debug(`Failed to load plugin ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to scan ${agentsDir()}: ${err}`);
  }

  return plugins;
}

/**
 * Scan ~/.nuvira/workflows/ for custom workflow template files.
 * Supports .json, .yaml, and .yml files.
 */
export function discoverWorkflowPlugins(): WorkflowTemplate[] {
  const workflows: WorkflowTemplate[] = [];

  ensureDirectories();

  try {
    const files = readdirSync(workflowsDir()).filter(
      (f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'),
    );

    for (const file of files) {
      try {
        const filePath = join(workflowsDir(), file);
        const content = readFileSync(filePath, 'utf-8');

        if (file.endsWith('.json')) {
          const parsed = JSON.parse(content);
          if (isValidWorkflowTemplate(parsed)) {
            workflows.push(parsed);
            logger.success(`Discovered workflow template: ${parsed.id} (${file})`);
          }
        } else {
          // YAML not available as dependency — skip, or use Node.js built-in
          logger.debug(`YAML workflow files not yet supported (${file}). Use .json format instead.`);
        }
      } catch (err) {
        logger.debug(`Failed to load workflow ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to scan ${workflowsDir()}: ${err}`);
  }

  return workflows;
}

/**
 * Get plugin statistics.
 */
export function getPluginStats(): { providerPlugins: number; agentPlugins: number; workflowPlugins: number } {
  let providerPlugins = 0;
  let agentPlugins = 0;
  let workflowPlugins = 0;

  try {
    if (existsSync(pluginsDir())) {
      providerPlugins = readdirSync(pluginsDir()).filter((f) => f.endsWith('.js')).length;
    }
  } catch { /* */ }

  try {
    if (existsSync(agentsDir())) {
      agentPlugins = readdirSync(agentsDir()).filter((f) => f.endsWith('.js')).length;
    }
  } catch { /* */ }

  try {
    if (existsSync(workflowsDir())) {
      workflowPlugins = readdirSync(workflowsDir()).filter(
        (f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'),
      ).length;
    }
  } catch { /* */ }

  return { providerPlugins, agentPlugins, workflowPlugins };
}

// ─── Startup Integration ────────────────────────────────────────────────────

/**
 * Run all auto-discovery scanners at startup.
 * Called once when the CLI boots up.
 *
 * @returns Summary of discovered plugins
 */
export async function runAutoDiscovery(): Promise<{
  providerPlugins: number;
  agentPlugins: number;
  /** Agent types the plugins registered into the module registry. */
  agentTypes: string[];
  /** Of those, the ones that replaced a built-in agent type. */
  shadowedAgentTypes: string[];
  workflowPlugins: number;
}> {
  await discoverProviderPlugins();
  const agentPlugins = await discoverAgentPlugins();
  // Register them, or the discovery above is decoration (see installAgentPlugins).
  const installed = installAgentPlugins(agentPlugins);
  const workflowPlugins = discoverWorkflowPlugins();
  const stats = getPluginStats();

  return {
    providerPlugins: stats.providerPlugins,
    agentPlugins: stats.agentPlugins,
    agentTypes: installed.registered,
    shadowedAgentTypes: installed.shadowed,
    workflowPlugins: stats.workflowPlugins,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────
// Note: isValidWorkflowTemplate is imported from '../workflow/templates.js'
// to avoid duplicating the validation logic.
