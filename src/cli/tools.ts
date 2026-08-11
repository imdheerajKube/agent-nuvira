/**
 * H1 — `buff tools` command.
 *
 * The H1 acceptance surface: every registered tool is visible here, and the
 * registry is consumed by every action command (chat/execute/plan/run/ci/
 * workflow) — a tool registered once works everywhere with zero per-command
 * re-implementation (STANDING RULE).
 */

import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { listTools, getTool, toolJsonSchemas } from '../tools/registry.js';

export class ToolsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('tools')
      .description('Inspect the agent tool registry (pipeline + experience tools)')
      .addCommand(
        new Command('list')
          .description('List every registered tool (the H1 tool-calling surface)')
          .action(() => this.listTools()),
      )
      .addCommand(
        new Command('show')
          .description('Show a tool\'s description and input schema')
          .argument('<name>', 'Tool name')
          .action((name: string) => this.showTool(name)),
      );

    return command;
  }

  private listTools(): void {
    const tools = listTools();
    logger.highlight(`\n🔧 Tool registry — ${tools.length} tools (H1: chat/execute/plan/run/ci/workflow share this surface)`);
    console.log('');

    const byCategory = new Map<string, typeof tools>();
    for (const t of tools) {
      const group = byCategory.get(t.category) || [];
      group.push(t);
      byCategory.set(t.category, group);
    }

    for (const [category, group] of byCategory) {
      const label =
        category === 'pipeline'
          ? '🏗️  Pipeline (build/resume/repair → orchestrator)'
          : category === 'workflow'
            ? '🧰 Workflow (publish · code_search · web_search · read_page)'
            : '✨ Experience (clarify + follow-ups + verify)';
      logger.highlight(`${label}:`);
      for (const t of group) {
        console.log(`  • ${t.name} — ${t.description}`);
      }
      console.log('');
    }
    logger.info('Run `buff tools show <name>` to see a tool\'s input schema.');
  }

  private showTool(name: string): void {
    const tool = getTool(name);
    if (!tool) {
      logger.error(`Unknown tool: ${name}`);
      logger.info(`Run \`buff tools list\` to see all ${listTools().length} registered tools.`);
      return;
    }
    const schema = toolJsonSchemas([name])[0];
    logger.highlight(`\n🔧 ${tool.name} (${tool.category})`);
    console.log('');
    console.log(tool.description);
    console.log('');
    if (schema) {
      logger.highlight('Input schema (JSON Schema — derived from the zod definition):');
      console.log(JSON.stringify(schema.parameters, null, 2));
    }
  }
}
