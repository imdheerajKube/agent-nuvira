/**
 * WebsiteCommand — `nuvira website` — open the Agent-Nuvira site in a browser.
 *
 * The product's capabilities, command reference, architecture and setup guides
 * live at https://www.agent-nuvira.com. A user who just installed the CLI has no
 * reason to know that, and no reason to trust a link printed only in a README
 * they may never open. This command makes the site reachable in one step:
 *
 *   nuvira website            — open the site in the default browser
 *   nuvira website --url      — print the URL only (no browser; for scripts/headless)
 *   nuvira website docs       — open the documentation site directly
 *
 * Best-effort: a machine with no browser launcher still prints the URL, so the
 * command is never a dead end.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { openInBrowser } from '../utils/open-url.js';

/** The project's public site — the capability/setup/command reference home. */
export const WEBSITE_URL = 'https://www.agent-nuvira.com';

/** The hosted documentation (built from this repo's docs). */
export const DOCS_URL = 'https://docs.agent-nuvira.com';

export class WebsiteCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('website')
      .description('Open the Agent-Nuvira website — capabilities, commands, docs, setup')
      .option('--url', 'print the URL instead of opening a browser (scripts/headless)');

    cmd
      .argument('[target]', 'what to open: site (default) or docs')
      .action((target: string | undefined, options: { url?: boolean }) => {
        const which = (target || 'site').toLowerCase();
        const url = which === 'docs' ? DOCS_URL : WEBSITE_URL;

        if (which !== 'site' && which !== 'docs') {
          logger.warn(`Unknown target '${target}' — opening the site. Use 'site' or 'docs'.`);
        }

        if (options.url) {
          // Headless / scripted: the URL is the whole output.
          console.log(url);
          return;
        }

        logger.highlight('\n🌐 Agent-Nuvira');
        logger.info('   Capabilities, the command reference, architecture and setup guides:');
        console.log(`   ${url}`);

        const opened = openInBrowser(url);
        if (opened) {
          logger.success('   Opened in your default browser.');
        } else {
          logger.info('   Could not launch a browser automatically — open the URL above.');
        }
        console.log('');
        logger.info('Docs only: `nuvira website docs`   ·   Just the link: `nuvira website --url`');
      });

    return cmd;
  }
}
