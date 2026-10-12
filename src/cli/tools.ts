/**
 * H1 — `nuvira tools` command.
 *
 * The H1 acceptance surface: every registered tool is visible here, and the
 * registry is consumed by every action command (chat/execute/plan/run/ci/
 * workflow) — a tool registered once works everywhere with zero per-command
 * re-implementation (STANDING RULE).
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { runShellSync } from '../utils/shell.js';
import { listTools, getTool, toolJsonSchemas } from '../tools/registry.js';
import { getToolsetStatus, setToolsetEnabled, validateToolsetCoverage } from '../tools/toolsets.js';
import { OPTIONAL_TOOL_RECIPES, describeOptionalTools, getOptionalToolRecipe } from '../tools/optional-deps.js';
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
      )
      .addCommand(
        new Command('install')
          .description('Install the optional dependency an optional tool needs (see `nuvira tools optional`)')
          .argument('[name]', 'Optional tool to install (e.g. browser); omit to list them')
          .option('--package-only', 'Install the npm package but skip its one-time binary download')
          .action((name: string | undefined, opts: { packageOnly?: boolean }) => this.installOptional(name, opts)),
      )
      .addCommand(
        new Command('optional')
          .description('List tools that are shipped but need an optional dependency installed')
          .action(() => this.listOptional()),
      );

    return command;
  }

  /**
   * Is an optional tool actually available? Delegates to the TOOL's own probe for
   * `browser` (so "installed" means the same thing here as it does at call time)
   * and resolves the recipe's package otherwise. The probe cache is cleared first
   * so the answer reflects THIS moment, not the first check of the process.
   */
  private async optionalInstalled(recipeId: string, packageName: string): Promise<boolean> {
    if (recipeId === 'browser') {
      const { isBrowserAvailable, resetBrowserAvailability } = await import('../tools/modality/browser.js');
      resetBrowserAvailability();
      return isBrowserAvailable();
    }
    try {
      createRequire(import.meta.url).resolve(packageName);
      return true;
    } catch {
      return false;
    }
  }

  /** `nuvira tools optional` — what is optional, and whether it is installed. */
  private async listOptional(): Promise<void> {
    logger.highlight('\n📦 Optional tools (shipped, but not usable until their dependency is installed)');
    console.log('');
    for (const recipe of OPTIONAL_TOOL_RECIPES) {
      const installed = await this.optionalInstalled(recipe.id, recipe.packageName);
      console.log(`  ${installed ? '🟢 installed' : '⛔ not installed'}  ${recipe.id.padEnd(10)} ${recipe.enables}`);
    }
    console.log('');
    logger.info('Install one with `nuvira tools install <name>`.');
  }

  /**
   * `nuvira tools install <name>` — run the recipe, then VERIFY by re-probing
   * the same availability check the tool itself uses. The command reports what
   * it ran and what the probe says afterwards; it never reports success on the
   * strength of the install command's exit code alone.
   */
  private async installOptional(name: string | undefined, opts: { packageOnly?: boolean }): Promise<void> {
    const recipe = name ? getOptionalToolRecipe(name) : null;
    if (!recipe) {
      logger.error(name ? `Unknown optional tool: ${name}` : 'Name which optional tool to install.');
      for (const line of describeOptionalTools()) console.log(`  ${line}`);
      return;
    }

    // Verify with the tool's OWN probe, not with our own bookkeeping.
    const probe = (): Promise<boolean> => this.optionalInstalled(recipe.id, recipe.packageName);
    const already = await probe();
    logger.highlight(`\n📦 ${recipe.id} — ${recipe.enables}`);
    logger.info(`${recipe.packageName}: ${already ? 'already installed' : 'not installed'}`);

    if (!already) {
      logger.info(`Running: ${recipe.installPackage}`);
      const install = runShellSync(recipe.installPackage, { timeoutMs: 600_000, source: 'tools-install' });
      if (!install.success) {
        logger.error(`Install failed (exit ${install.exitCode}).`);
        const detail = (install.stderr || install.stdout).trim().split('\n').slice(-6).join('\n');
        if (detail) console.log(detail);
        logger.info(recipe.manualHint);
        return;
      }
      logger.success(`${recipe.packageName} installed.`);
    }

    if (recipe.installBinaries && !opts.packageOnly) {
      // The npm package is only the DRIVER — playwright cannot open a page until
      // its browser binary is downloaded, so this step is part of "installed".
      logger.info(`Running: ${recipe.installBinaries} (one-time browser download)`);
      const binaries = runShellSync(recipe.installBinaries, { timeoutMs: 900_000, source: 'tools-install' });
      if (!binaries.success) {
        logger.warn(`Could not download the browser binary (exit ${binaries.exitCode}).`);
        logger.info(`Finish it with: ${recipe.installBinaries}`);
      }
    } else if (recipe.installBinaries) {
      logger.warn(`Skipped the binary download (--package-only). Finish with: ${recipe.installBinaries}`);
    }

    // Verify with the tool's OWN probe, not with our own bookkeeping.
    const available = await probe();
    if (available) {
      logger.success(`${recipe.id} tool is now available.`);
      if (recipe.id === 'browser') {
        logger.info('Try it: ask the agent to open a page, and the session stays open across steps (close it with action "close").');
      }
    } else {
      logger.warn(`${recipe.id} is still reported unavailable by the tool's own check.`);
      logger.info(recipe.manualHint);
    }
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
    // the real ~/.nuvira/buffconfig.json (a fresh instance would re-read anyway,
    // but sharing keeps this invocation consistent after a toggle).
    const status = getToolsetStatus(cm);
    logger.highlight('\n🧩 Toolsets (capability gating — the model schema is built from enabled groups only)');
    console.log('');
    for (const s of status) {
      console.log(`  ${s.enabled ? '🟢' : '⛔'} ${s.name.padEnd(12)} ${s.label.padEnd(22)} ${String(s.toolCount).padEnd(4)} ${s.description}`);
    }
    console.log('');
    logger.info('Enable/disable: `nuvira tools toolsets --enable <name>` | `--disable <name>` (persists to ~/.nuvira/buffconfig.json).');
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
    logger.info('Run `nuvira tools show <name>` to see a tool\'s input schema.');
  }

  private showTool(name: string): void {
    const tool = getTool(name);
    if (!tool) {
      logger.error(`Unknown tool: ${name}`);
      logger.info(`Run \`nuvira tools list\` to see all ${listTools().length} registered tools.`);
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
