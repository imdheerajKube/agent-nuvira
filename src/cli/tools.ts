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
import { getToolsetStatus, setToolsetEnabled, validateToolsetCoverage } from '../tools/toolsets.js';
import { ConfigManager } from '../config/manager.js';

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
      )
      .addCommand(
        new Command('toolsets')
          .description('List toolset groups (capability gating) with enabled state; enable/disable a group')
          .option('-e, --enable <name>', 'Enable a toolset')
          .option('-d, --disable <name>', 'Disable a toolset (removes its tools from the model schema + blocks execution)')
          .action((opts) => this.toolsets(opts)),
      );

    return command;
  }

  private toolsets(opts: { enable?: string; disable?: string }): void {
    // One ConfigManager for the whole invocation: the status read must see the
    // file, not the empty all-enabled default (readToolsetsState(undefined) = {}).
    const cm = new ConfigManager();
    // Registry coverage integrity first — surface unassigned tools so a future
    // registry addition is never silently ungated.
    const { unassigned, duplicated } = validateToolsetCoverage(listTools().map((t) => t.name));
    if (unassigned.length > 0 || duplicated.length > 0) {
      logger.warn(
        `Toolset coverage: ${unassigned.length} unassigned tool(s) (${unassigned.join(', ')})` +
        `${duplicated.length > 0 ? `; ${duplicated.length} duplicated (${duplicated.join(', ')})` : ''}`,
      );
    }

    if (opts.enable && opts.disable) {
      logger.error('Pick one: --enable OR --disable, not both.');
      return;
    }
    try {
      if (opts.enable) setToolsetEnabled(opts.enable, true, cm);
      if (opts.disable) setToolsetEnabled(opts.disable, false, cm);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      return;
    }

    // Read/write through ONE ConfigManager so the status line always reflects
    // the real ~/.buff/buffconfig.json (a fresh instance would re-read anyway,
    // but sharing keeps this invocation consistent after a toggle).
    const status = getToolsetStatus(cm);
    logger.highlight('\n🧩 Toolsets (capability gating — the model schema is built from enabled groups only)');
    console.log('');
    for (const s of status) {
      console.log(`  ${s.enabled ? '🟢' : '⛔'} ${s.name.padEnd(12)} ${s.label.padEnd(22)} ${String(s.toolCount).padEnd(4)} ${s.description}`);
    }
    console.log('');
    logger.info('Enable/disable: `buff tools toolsets --enable <name>` | `--disable <name>` (persists to ~/.buff/buffconfig.json).');
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
