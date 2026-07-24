/**
 * Plugins command — Lists and manages agent plugins and workflow templates.
 *
 * Usage:
 *   buff plugins list          — Show discovered plugins and workflow templates
 *   buff plugins scan          — Force re-scan of ~/.buff/agents/ and ~/.buff/workflows/
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class PluginsCommand extends BaseCommand {
    create(): Command;
    private listPlugins;
    private scanPlugins;
}
//# sourceMappingURL=plugins.d.ts.map