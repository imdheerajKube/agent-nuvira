import { Command } from 'commander';
import { resolve } from 'node:path';
import { BaseCommand } from './commands.js';
import { getCache } from '../context/cache.js';
import { logger } from '../utils/logger.js';

/**
 * Cache command — manage inference cache
 * nuvira cache [clear|stats]
 */
export class CacheCommand extends BaseCommand {
  create(): Command {
    const command = new Command('cache')
      .description('Manage inference cache')
      .addCommand(
        new Command('stats')
          .description('Show cache statistics')
          .action(async () => {
            await this.showStats();
          })
      )
      .addCommand(
        new Command('clear')
          .description('Clear cached responses — all of them, or one workspace (project folder)')
          // Clearing ONE workspace is the case that matters: answers are scoped
          // to the folder they are about, so a project that changed needs its
          // own answers dropped, not everyone else's.
          .argument('[workspace]', 'only clear the answers cached for this project folder')
          .option('--unscoped', 'clear the answers cached with no workspace attached')
          .action(async (workspace?: string, options?: { unscoped?: boolean }) => {
            await this.clearCache(workspace, options?.unscoped === true);
          })
      )
      .action(() => {
        // Show stats by default
        this.showStats();
      });

    return command;
  }

  private async showStats(): Promise<void> {
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

      // By WORKSPACE — the folder each answer is about. An answer is a statement
      // about a directory, so this is the grouping that tells you whether a stale
      // reply is possible and which project to clear.
      const workspaces = await cache.listByWorkspace();
      if (workspaces.length > 0) {
        console.log('\nBy workspace:');
        for (const w of workspaces) {
          const label = w.scope ?? '(no workspace attached)';
          console.log(`  ${label}: ${w.count} entr${w.count === 1 ? 'y' : 'ies'}`);
        }
        console.log('\nClear one with: agent-nuvira cache clear <workspace>\n');
      }
      console.log('');
    } catch (err) {
      logger.error(String(err));
    }
  }

  private async clearCache(workspace?: string, unscoped = false): Promise<void> {
    try {
      const cache = getCache();
      if (unscoped) {
        const removed = await cache.clearWorkspace(null);
        logger.success(`Cleared ${removed} cached answer(s) with no workspace attached`);
        return;
      }
      if (workspace) {
        // Resolved to an absolute path so the match is the same directory the
        // cache stored (a relative path would silently clear nothing).
        const removed = await cache.clearWorkspace(resolve(workspace));
        logger.success(`Cleared ${removed} cached answer(s) for ${resolve(workspace)}`);
        return;
      }
      await cache.clear();
      logger.success('Cache cleared successfully');
    } catch (err) {
      logger.error(String(err));
    }
  }
}
