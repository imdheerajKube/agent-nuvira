/**
 * Agent command — Scaffold and manage custom agents for the agent-baba-d platform.
 *
 * Usage:
 *   buff agent create <name>    — Create a new custom agent project from a template
 *   buff agent list             — List all discovered custom agent plugins
 *   buff agent info <name>      — Show details about a discovered agent plugin
 *
 * The `buff agent create` command scaffolds a new project using the @agent-baba-d/sdk
 * package, providing a ready-to-develop custom agent with:
 * - package.json with SDK dependency
 * - TypeScript configuration
 * - Agent base class implementation
 * - Vitest test setup with testing utilities
 * - README with instructions
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class AgentCommand extends BaseCommand {
    create(): Command;
    private createAgent;
    private listAgents;
    private showAgentInfo;
}
//# sourceMappingURL=agent.d.ts.map