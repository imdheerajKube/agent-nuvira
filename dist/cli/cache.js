import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import { getCache } from '../context/cache.js';
import { logger } from '../utils/logger.js';
/**
 * Cache command — manage inference cache
 * buff cache [clear|stats]
 */
export class CacheCommand extends BaseCommand {
    create() {
        const command = new Command('cache')
            .description('Manage inference cache')
            .addCommand(new Command('stats')
            .description('Show cache statistics')
            .action(async () => {
            await this.showStats();
        }))
            .addCommand(new Command('clear')
            .description('Clear all cached responses')
            .action(async () => {
            await this.clearCache();
        }))
            .action(() => {
            // Show stats by default
            this.showStats();
        });
        return command;
    }
    async showStats() {
        try {
            const cache = getCache();
            const stats = await cache.stats();
            logger.highlight('\nCache Statistics:\n');
            logger.info(`Total cached entries: ${stats.total}`);
            if (Object.keys(stats.providers).length > 0) {
                console.log('\nBy provider:');
                for (const [provider, count] of Object.entries(stats.providers)) {
                    console.log(`  ${provider}: ${count} entries`);
                }
            }
            console.log('');
        }
        catch (err) {
            logger.error(String(err));
        }
    }
    async clearCache() {
        try {
            const cache = getCache();
            await cache.clear();
            logger.success('Cache cleared successfully');
        }
        catch (err) {
            logger.error(String(err));
        }
    }
}
//# sourceMappingURL=cache.js.map