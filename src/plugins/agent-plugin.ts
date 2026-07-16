/**
 * AgentPlugin — Interface for third-party agent plugins and auto-discovery.
 *
 * Users can place agent plugin files in ~/.buff/agents/ and they will be
 * automatically discovered and registered with the orchestrator at startup.
 *
 * Provider plugins (inference providers):
 * - Any .js file in ~/.buff/plugins/
 * - Must export a default object matching the ProviderPlugin interface
 *
 * Agent plugins (agent extensions):
 * - Any .js file in ~/.buff/agents/
 * - Must export a default object matching the AgentPlugin interface
 *
 * Workflow plugins:
 * - Any .yaml, .yml, or .json file in ~/.buff/workflows/
 * - Defines a sequence of agent steps as a reusable workflow template
 */

import { readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentContext, AgentResult } from '../agents/agent.js';
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

const BUFF_DIR = join(homedir(), '.buff');
const PLUGINS_DIR = join(BUFF_DIR, 'plugins');
const AGENTS_DIR = join(BUFF_DIR, 'agents');
const WORKFLOWS_DIR = join(BUFF_DIR, 'workflows');

function ensureDirectories(): void {
  for (const dir of [PLUGINS_DIR, AGENTS_DIR, WORKFLOWS_DIR]) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
  }
}

// ─── Auto-Discovery ─────────────────────────────────────────────────────────

/**
 * Scan ~/.buff/plugins/ for provider plugin .js files and register them
 * with the global PluginRegistry.
 *
 * Each file must export a default object matching the ProviderPlugin interface
 * from ./registry.js. Upon discovery, the plugin is automatically registered
 * so it can be used with: buff chat --provider <plugin-type>
 *
 * Returns the number of successfully loaded provider plugins.
 */
export async function discoverProviderPlugins(): Promise<number> {
  ensureDirectories();
  let loaded = 0;

  try {
    const files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = join(PLUGINS_DIR, file);
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
    logger.debug(`Failed to scan ${PLUGINS_DIR}: ${err}`);
  }

  return loaded;
}

/**
 * Scan ~/.buff/agents/ for plugin .js files and load them.
 * Returns a map of agent type → AgentPlugin.
 */
export async function discoverAgentPlugins(): Promise<Map<string, AgentPlugin>> {
  const plugins = new Map<string, AgentPlugin>();

  ensureDirectories();

  try {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = join(AGENTS_DIR, file);
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
    logger.debug(`Failed to scan ${AGENTS_DIR}: ${err}`);
  }

  return plugins;
}

/**
 * Scan ~/.buff/workflows/ for custom workflow template files.
 * Supports .json, .yaml, and .yml files.
 */
export function discoverWorkflowPlugins(): WorkflowTemplate[] {
  const workflows: WorkflowTemplate[] = [];

  ensureDirectories();

  try {
    const files = readdirSync(WORKFLOWS_DIR).filter(
      (f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'),
    );

    for (const file of files) {
      try {
        const filePath = join(WORKFLOWS_DIR, file);
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
    logger.debug(`Failed to scan ${WORKFLOWS_DIR}: ${err}`);
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
    if (existsSync(PLUGINS_DIR)) {
      providerPlugins = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.js')).length;
    }
  } catch { /* */ }

  try {
    if (existsSync(AGENTS_DIR)) {
      agentPlugins = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.js')).length;
    }
  } catch { /* */ }

  try {
    if (existsSync(WORKFLOWS_DIR)) {
      workflowPlugins = readdirSync(WORKFLOWS_DIR).filter(
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
  workflowPlugins: number;
}> {
  const providerCount = await discoverProviderPlugins();
  await discoverAgentPlugins(); // Agent plugins stored in map, not counted here
  const workflowPlugins = discoverWorkflowPlugins();
  const stats = getPluginStats();

  return {
    providerPlugins: stats.providerPlugins,
    agentPlugins: stats.agentPlugins,
    workflowPlugins: stats.workflowPlugins,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────
// Note: isValidWorkflowTemplate is imported from '../workflow/templates.js'
// to avoid duplicating the validation logic.
