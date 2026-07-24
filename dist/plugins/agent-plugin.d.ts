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
import type { AgentContext, AgentResult } from '../agents/agent.js';
import type { WorkflowTemplate } from '../workflow/templates.js';
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
export declare function discoverProviderPlugins(): Promise<number>;
/**
 * Scan ~/.buff/agents/ for plugin .js files and load them.
 * Returns a map of agent type → AgentPlugin.
 */
export declare function discoverAgentPlugins(): Promise<Map<string, AgentPlugin>>;
/**
 * Scan ~/.buff/workflows/ for custom workflow template files.
 * Supports .json, .yaml, and .yml files.
 */
export declare function discoverWorkflowPlugins(): WorkflowTemplate[];
/**
 * Get plugin statistics.
 */
export declare function getPluginStats(): {
    providerPlugins: number;
    agentPlugins: number;
    workflowPlugins: number;
};
/**
 * Run all auto-discovery scanners at startup.
 * Called once when the CLI boots up.
 *
 * @returns Summary of discovered plugins
 */
export declare function runAutoDiscovery(): Promise<{
    providerPlugins: number;
    agentPlugins: number;
    workflowPlugins: number;
}>;
//# sourceMappingURL=agent-plugin.d.ts.map