/**
 * SkillsCommand — J3 skills hub + sync (mirrors Hermes `skills_hub.py` +
 * Freebuff `npx skills add`).
 *
 * Subcommands:
 *   buff skills search <query>                — Search the skills registry
 *   buff skills install <name>                — Install a skill from the registry
 *   buff skills update                        — Update installed skills to newer versions
 *   buff skills list [--origin registry|local] — List installed skills with provenance
 *
 * Distinct from `buff skill` (singular): that manages INTERNAL skills compiled
 * from trajectories; `buff skills` manages EXTERNAL community skills installed
 * into `<project>/.agents/skills/` (sandboxed, provenance + checksum recorded).
 */

import { Command } from 'commander';
import ora from 'ora';

import { guardRbacAction } from './rbac-guard.js';

import {
  searchHubSkills,
  installHubSkill,
  updateHubSkills,
  listHubSkills,
  getHubSkillEntry,
  isValidSkillName,
  clearSkillsIndexCache,
} from '../learning/skills-hub.js';
import { logger } from '../utils/logger.js';

export class SkillsCommand {
  create(): Command {
    const cmd = new Command('skills')
      .description('Skills hub — search, install, update, and audit community skills (J3)');

    cmd
      .command('search <query>')
      .description('Search the skills registry (DuckDuckGo-free: index from the configured registry)')
      .option('--refresh', 'Ignore the cached registry index and re-fetch', false)
      .action(async (query, opts) => {
        if (opts.refresh) clearSkillsIndexCache();
        const spinner = ora({ text: 'Searching skills registry...', spinner: 'dots' }).start();
        const results = await searchHubSkills(query);
        spinner.stop();
        if (results.length === 0) {
          logger.info(`No skills found matching '${query}'.`);
          logger.info('  Tip: check BUFF_SKILLS_REGISTRY or the default registry index.');
          return;
        }
        console.log(`\n🔎 ${results.length} skill(s) matching '${query}':\n`);
        for (const r of results) {
          console.log(`  • ${r.name} v${r.version}  (${r.source})`);
          console.log(`    ${r.description}`);
          if (r.tags.length > 0) console.log(`    tags: ${r.tags.join(', ')}`);
          console.log('');
        }
        console.log(`Install one with: buff skills install <name>`);
      });

    cmd
      .command('install <name>')
      .description('Install a skill from the registry into <project>/.agents/skills/ (sandboxed, checksummed)')
      .option('--project <path>', 'Project root for .agents/skills/ (default: cwd)')
      .action(async (name, opts) => {
        if (!isValidSkillName(name)) {
          logger.error(`Refused: skill name '${name}' is not in [a-z0-9-].`);
          return;
        }
        const spinner = ora({ text: `Installing '${name}'...`, spinner: 'dots' }).start();
        const entry = await getHubSkillEntry(name);
        if (!entry) {
          spinner.fail(`Skill '${name}' not found in the registry.`);
          logger.info('  Search available skills: buff skills search <query>');
          return;
        }
        const result = await installHubSkill(entry, opts.project || process.cwd());
        spinner.stop();
        if (result.ok) {
          if (result.reason === 'already up to date') {
            logger.info(`✅ ${name} v${result.version} is already up to date.`);
          } else {
            logger.success(`✅ Installed ${name} v${result.version} (${result.source}).`);
          }
        } else if (result.quarantined) {
          logger.error(`⛔ ${result.reason}`);
        } else {
          logger.error(`❌ ${result.reason || 'install failed'}`);
        }
      });

    cmd
      .command('update')
      .description('Update installed skills to newer registry versions (checksum-verified)')
      .option('--project <path>', 'Project root for .agents/skills/ (default: cwd)')
      .action(async (opts) => {
        // K4 parity: update force-overwrites installed content — gate like
        // `buff skill gc` / `clear` (skill.remove), not a silent write.
        if (!guardRbacAction('skill.remove')) return;
        const spinner = ora({ text: 'Checking installed skills against the registry...', spinner: 'dots' }).start();
        const { updated, current, failed } = await updateHubSkills(opts.project || process.cwd());
        spinner.stop();
        if (updated.length === 0 && current.length === 0 && failed.length === 0) {
          logger.info('No skills installed yet — install one with `buff skills install <name>`.');
          return;
        }
        if (updated.length > 0) {
          logger.success(`Updated: ${updated.join(', ')}`);
        }
        if (current.length > 0) {
          logger.info(`Already current: ${current.join(', ')}`);
        }
        if (failed.length > 0) {
          logger.warn(`Skipped: ${failed.join('; ')}`);
        }
      });

    cmd
      .command('list')
      .description('List installed skills with provenance (origin: registry vs local)')
      .option('--origin <origin>', 'Filter by origin: registry | local')
      .option('--project <path>', 'Project root for .agents/skills/ (default: cwd)')
      .action((opts) => {
        if (opts.origin !== undefined && opts.origin !== 'registry' && opts.origin !== 'local') {
          logger.warn(`Unknown --origin '${opts.origin}' — expected 'registry' or 'local'; showing all.`);
        }
        const origin = opts.origin === 'registry' || opts.origin === 'local' ? opts.origin : undefined;
        const items = listHubSkills(origin, opts.project || process.cwd());
        if (items.length === 0) {
          logger.info('No skills installed.');
          logger.info('  Search available skills: buff skills search <query>');
          return;
        }
        console.log(`\n🧠 ${items.length} installed skill(s):\n`);
        for (const s of items) {
          const originBadge = s.origin === 'registry' ? '🌐 registry' : '📁 local';
          const installedBadge = s.installed ? '✅ on disk' : '⚠️  record only';
          console.log(`  • ${s.name} v${s.version}  [${originBadge}] ${installedBadge}`);
          console.log(`    source: ${s.source} · installed: ${s.installedAt ? new Date(s.installedAt).toLocaleDateString() : 'n/a'}`);
          console.log('');
        }
      });

    return cmd;
  }
}
