/**
 * `nuvira credentials` — store and inspect the credentials a release needs.
 *
 * Why a dedicated surface: the publish pipeline could only ever see credentials
 * that happened to be exported into the environment or written into `.npmrc`,
 * and `nuvira publish` asked for the rest interactively — every session. There
 * was no way to say "here is my token, remember it". This command is that way.
 *
 * Storage is the nuvira env file (0600, outside the repository), the same store
 * the skill-secret path writes, so there is exactly one place a credential
 * lives and exactly one place to look when a release cannot authenticate.
 *
 * Subcommands:
 *   nuvira credentials                 — status (default)
 *   nuvira credentials set <KEY>       — prompt for and store a value
 *   nuvira credentials forget <KEY>    — delete a stored value
 *   nuvira credentials verify          — check the tokens against GitHub/npm
 */

import { Command } from 'commander';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import {
  RELEASE_CREDENTIAL_KEYS,
  forgetReleaseCredential,
  isReleaseCredentialKey,
  releaseCredentialStatus,
  storeReleaseCredential,
} from '../agents/credential-store.js';
import { CredentialStore } from '../agents/credential-store.js';
import { logger } from '../utils/logger.js';

/** The key names a user may store, with a one-line explanation each. */
const KEY_HELP: Record<string, string> = {
  [RELEASE_CREDENTIAL_KEYS.gitToken]: 'GitHub PAT / OAuth token — used for the HTTPS push',
  [RELEASE_CREDENTIAL_KEYS.gitUsername]: 'GitHub username paired with the token',
  [RELEASE_CREDENTIAL_KEYS.npmToken]: 'npm automation token — used for `npm publish`',
  [RELEASE_CREDENTIAL_KEYS.npmRegistry]: 'Alternative npm registry (default: registry.npmjs.org)',
};

export class CredentialsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('credentials')
      .description('Store GitHub/npm release credentials so the agent can release without re-entering them');

    command
      .command('status', { isDefault: true })
      .description('Show which release credentials are available, and where each came from')
      .action(async () => {
        await this.status();
      });

    command
      .command('set')
      .argument('<key>', `Credential to store (${Object.keys(KEY_HELP).join(' | ')})`)
      .option('--value <value>', 'Value to store. Omit to be prompted (keeps it out of your shell history)')
      .option('--stdin', 'Read the value from stdin — for scripts and CI, where a token in argv would land in `ps` output')
      .description('Store a credential in the nuvira credential store')
      .action(async (key: string, options: { value?: string; stdin?: boolean }) => {
        await this.set(key, options);
      });

    command
      .command('forget')
      .argument('<key>', 'Credential to delete from the store')
      .description('Delete a stored credential')
      .action(async (key: string) => {
        this.forget(key);
      });

    command
      .command('verify')
      .description('Check the stored GitHub and npm tokens against the live services')
      .action(async () => {
        await this.verify();
      });

    return command;
  }

  private async status(): Promise<void> {
    const status = releaseCredentialStatus();

    console.log('');
    logger.highlight('  🔑  Release credentials');
    logger.info(`  Store: ${status.storePath}`);
    console.log('');

    for (const row of status.rows) {
      const mark = row.set ? '✅' : '❌';
      const where = row.set ? `  (${row.origin})` : '';
      const value = row.masked ? `  ${row.masked}` : '';
      console.log(`  ${mark} ${row.key.padEnd(16)}${value}${where}`);
      const help = KEY_HELP[row.key];
      if (help) console.log(`     ${help}`);
    }

    console.log('');
    logger.info(`  📡 Git remote: ${status.git.remoteUrl || 'not configured'}`);
    logger.info(`  📦 npm registry: ${status.npm.registry}`);
    console.log('');

    if (status.git.canPush && status.npm.canPublish) {
      logger.success('  ✅ A release can run: git push and npm publish are both credentialed.');
    } else {
      logger.warn('  ⚠️  A release would be incomplete:');
      if (!status.git.canPush) {
        logger.warn(`     • no git credentials — store ${RELEASE_CREDENTIAL_KEYS.gitToken}, or configure an SSH key`);
      }
      if (!status.npm.canPublish) {
        logger.warn(`     • no npm token — store ${RELEASE_CREDENTIAL_KEYS.npmToken}`);
      }
      console.log('');
      logger.info('  Store one with:');
      logger.info('     nuvira credentials set NPM_TOKEN');
    }
    console.log('');
  }

  private async set(key: string, options: { value?: string; stdin?: boolean }): Promise<void> {
    if (!isReleaseCredentialKey(key)) {
      logger.error(`  ❌ Unknown credential '${key}'.`);
      logger.info(`     Known keys: ${Object.keys(KEY_HELP).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    let value = options.value?.trim() ?? '';

    // --stdin: the script/CI path (e.g. `gh auth token | nuvira credentials
    // set GITHUB_TOKEN --stdin`). Compiled by reading the stream directly rather
    // than via the prompt, so nothing is echoed.
    if (!value && options.stdin) {
      if (process.stdin.isTTY) {
        logger.error('  ❌ --stdin was given but no input is piped in.');
        logger.info('     Pipe the value, or omit --stdin to be prompted.');
        process.exitCode = 1;
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      value = Buffer.concat(chunks).toString('utf-8').trim();
      if (!value) {
        logger.error('  ❌ No value arrived on stdin.');
        process.exitCode = 1;
        return;
      }
    }

    // Prompt by default: a token typed as a CLI argument lands in shell history
    // and in `ps` output for the lifetime of the process.
    if (!value) {
      const answer = await inquirer.prompt<{ value: string }>([
        {
          type: key === RELEASE_CREDENTIAL_KEYS.gitUsername ? 'input' : 'password',
          name: 'value',
          message: `Value for ${key}:`,
          mask: '*',
          validate: (input: string) => input.trim().length > 0 || 'A value is required',
        },
      ]);
      value = answer.value.trim();
    }

    const result = storeReleaseCredential(key, value);
    if (!result.success) {
      logger.error(`  ❌ Could not store ${key} (${result.reason ?? 'unknown error'})`);
      process.exitCode = 1;
      return;
    }

    logger.success(`  ✅ Stored ${key} in ${result.path}`);
    logger.info('     Releases will now find it without an environment export.');
  }

  private forget(key: string): void {
    if (!isReleaseCredentialKey(key)) {
      logger.error(`  ❌ Unknown credential '${key}'.`);
      logger.info(`     Known keys: ${Object.keys(KEY_HELP).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const result = forgetReleaseCredential(key);
    if (!result.success) {
      logger.error(`  ❌ Could not delete ${key} (${result.reason ?? 'unknown error'})`);
      process.exitCode = 1;
      return;
    }

    if (result.removed) {
      logger.success(`  ✅ Removed ${key} from ${result.path}`);
    } else {
      logger.info(`  ℹ️  ${key} was not stored — nothing to remove.`);
    }
  }

  private async verify(): Promise<void> {
    const store = new CredentialStore();
    store.initialize();

    if (!store.canPush && !store.canPublish) {
      logger.error('  ❌ No credentials to verify.');
      logger.info('     Store one with: nuvira credentials set NPM_TOKEN');
      process.exitCode = 1;
      return;
    }

    console.log('');
    logger.info('  Checking credentials against the live services...');
    const result = await store.verify();

    const report = (label: string, probe: { checked: boolean; ok: boolean; detail: string }): boolean => {
      if (probe.checked && probe.ok) {
        logger.success(`  ✅ ${label}: ${probe.detail}`);
        return true;
      }
      if (probe.checked && !probe.ok) {
        logger.error(`  ❌ ${label}: ${probe.detail}`);
        return false;
      }
      // Inconclusive — warn, never fail. A preflight must not call a good token
      // bad because the network was briefly unavailable.
      logger.warn(`  ⚠️  ${label}: ${probe.detail}`);
      return true;
    };

    console.log('');
    const gitOk = report('git', result.git);
    const npmOk = report('npm', result.npm);
    console.log('');

    if (gitOk && npmOk) {
      logger.success('  ✅ Credentials look usable.');
    } else {
      logger.error('  ❌ Fix the rejected credentials above before releasing.');
      process.exitCode = 1;
    }
    console.log('');
  }
}
