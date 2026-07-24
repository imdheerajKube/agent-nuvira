import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Config command — manage buff configuration
 * buff config [set|get|list]
 */
export declare class ConfigCommand extends BaseCommand {
    create(): Command;
    private createSetCommand;
    private createGetCommand;
    private createListCommand;
    private createInitCommand;
    private displayConfig;
    private getValue;
    private setValue;
    private listProviders;
    private initConfig;
}
//# sourceMappingURL=config.d.ts.map