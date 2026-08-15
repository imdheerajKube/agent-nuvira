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
    /**
     * Phase A1 secret vault: `buff config vault status|migrate-keys`.
     * Vault stores provider API keys in the OS keychain (or an AES-256-GCM
     * encrypted file fallback) so `buffconfig.json` holds `vault:` refs instead
     * of plaintext secrets.
     */
    private createVaultCommand;
    private displayConfig;
    private getValue;
    private setValue;
    private listProviders;
    private initConfig;
    private createGatewayCommand;
    /** `buff config gateway allow/disallow <platform> <user|group> <id...>` */
    private allowDisallow;
    /** `buff config gateway reply <platform> <polite|silent>` */
    private setReplyMode;
    /** `buff config gateway notify add|remove|list <target...>` */
    private manageStatusRecipients;
    private listPlatforms;
    private setPlatform;
    private removePlatform;
}
//# sourceMappingURL=config.d.ts.map