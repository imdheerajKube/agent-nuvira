/**
 * Marketplace command — Browse and install community plugins and workflow templates.
 *
 * Usage:
 *   nuvira marketplace browse                   — Browse all available items
 *   nuvira marketplace browse --workflows       — Browse workflow templates only
 *   nuvira marketplace browse --plugins         — Browse plugins only
 *   nuvira marketplace search <query>            — Search across plugins and templates
 *   nuvira marketplace install <name>            — Install a workflow template
 *   nuvira marketplace info <name>               — Show details for a marketplace item
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