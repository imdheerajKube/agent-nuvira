/**
 * Marketplace command — Browse and install community plugins and workflow templates.
 *
 * Usage:
 *   buff marketplace browse                   — Browse all available items
 *   buff marketplace browse --workflows       — Browse workflow templates only
 *   buff marketplace browse --plugins         — Browse plugins only
 *   buff marketplace search <query>            — Search across plugins and templates
 *   buff marketplace install <name>            — Install a workflow template
 *   buff marketplace info <name>               — Show details for a marketplace item
 *
 * This command wraps the existing workflow registry and plugin discovery into
 * a unified "marketplace" experience.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class MarketplaceCommand extends BaseCommand {
    create(): Command;
    private browse;
    private search;
    private install;
    private showInfo;
}
//# sourceMappingURL=marketplace.d.ts.map