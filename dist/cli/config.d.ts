import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Config command — manage nuvira configuration
 * nuvira config [set|get|list]
 */
export declare class ConfigCommand extends BaseCommand {
    create(): Command;
    private createSetCommand;
    private createGetCommand;
    private createListCommand;
    private createInitCommand;
    /**
     * Phase A1 secret vault: `${getCliName()} config vault status|migrate-keys`.
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
    /**
     * `${getCliName()} config gateway send-authority <action> <platform> [id...]`
     *
     * The OUTBOUND gate. `allow` decides who may TRIGGER the agent; this decides
     * who may then direct it to deliver to SOMEONE ELSE. Absent = inherit the
     * inbound allow-list (open); an empty list = nobody; the Allow-All wildcard
     * = anyone.
     */
    private manageSendAuthority;
    /** `${getCliName()} config gateway allow/disallow <platform> <user|group> <id...>` */
    private allowDisallow;
    /** `${getCliName()} config gateway reply <platform> <polite|silent>` */
    private setReplyMode;
    /** `${getCliName()} config gateway notify add|remove|list <target...>` */
    private manageStatusRecipients;
    private listPlatforms;
    private setPlatform;
    private removePlatform;
}
//# sourceMappingURL=config.d.ts.map