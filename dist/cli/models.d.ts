import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Models command — list available models from providers
 * agent-baba-d models [--provider nim]
 *
 * Subcommands:
 *   buff models refresh [provider]  — probe + spot-check, update the registry
 *   buff models status [--json]     — show the Model Availability Registry
 *   buff models watch [--interval N]— background daemon keeping the registry fresh
 */
export declare class ModelsCommand extends BaseCommand {
    create(): Command;
    private execute;
}
//# sourceMappingURL=models.d.ts.map