/**
 * Plugins command — Lists and manages agent plugins and workflow templates.
 *
 * Usage:
 *   nuvira plugins list          — Show discovered plugins and workflow templates
 *   nuvira plugins scan          — Force re-scan of ~/.nuvira/agents/ and ~/.nuvira/workflows/
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class PluginsCommand extends BaseCommand {
    create(): Command;
    private listPlugins;
    private scanPlugins;
}
//# sourceMappingURL=plugins.d.ts.map