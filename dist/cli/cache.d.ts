import { Command } from 'commander';
import { BaseCommand } from './commands.js';
/**
 * Cache command — manage inference cache
 * nuvira cache [clear|stats]
 */
export declare class CacheCommand extends BaseCommand {
    create(): Command;
    private showStats;
    private clearCache;
}
//# sourceMappingURL=cache.d.ts.map