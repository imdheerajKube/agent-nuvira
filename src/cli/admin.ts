/**
 * Admin command — P6 M6.5 governance policy surface for Auto routing.
 *
 * The M2.4 admin schema (routing.governance.*) is enforced inside the
 * auto-router's hard-constraint slot on every pick — violating providers are
 * ELIMINATED, never just scored lower. This command promotes that raw config
 * surface into a first-class admin API:
 *
 *   buff admin                        — Show the current policy (alias for `policy`)
 *   buff admin policy [--json]        — Current allow/deny policy + enforcement status
 *   buff admin allow <provider...>    — Add providers to governance.allowProviders
 *   buff admin deny <provider...>     — Add providers to governance.denyProviders
 *   buff admin allow-model <m...>     — Add models to governance.allowModels
 *   buff admin deny-model <m...>      — Add models to governance.denyModels
 *   buff admin max-cost <usd>         — Admin hard max cost per call (joins routing.maxCostUsd)
 *   buff admin pii-min <0..1>         — Min privacy score for PII-matching tasks (default 1.0)
 *   buff admin unblock on|off         — May `buff models unblock` override registry blocks?
 *   buff admin clear <field>          — Remove one governance field (policy becomes permissive on it)
 *
 * All writes go through ConfigManager.save() — the same file/path the config
 * CLI writes — so `buff config get routing.governance.<key>` agrees with the
 * admin surface. Everything is additive: an empty policy is fully permissive.
 */

import { Command } from 'commander';
import ora from 'ora';
import { BaseCommand, getCliName } from './commands.js';
import { guardRbacAction } from './rbac-guard.js';
import { logger } from '../utils/logger.js';
import { RbacManager, RbacError, ROLES } from '../enterprise/rbac.js';
import type { AdminAction, Role } from '../enterprise/rbac.js';
import type { BuffConfig, GovernanceConfig } from '../config/types.js';
import {
  addCronJob,
  listCronJobs,
  removeCronJob,
  dryRunCronJob,
  nextRunAt,
  runJobNow,
} from '../gateway/cron.js';

/** The governance fields `buff admin clear` accepts. */
const GOVERNANCE_FIELDS: ReadonlyArray<keyof GovernanceConfig> = [
  'allowProviders', 'denyProviders', 'allowModels', 'denyModels',
  'maxCostUsd', 'minPrivacyForPii', 'piiPatterns', 'allowUnblock',
];

/** Union-append to a comma/space list field (deduped, order preserved). */
function appendUnique(current: string[] | undefined, additions: string[]): string[] {
  return [...new Set([...(current || []), ...additions])];
}

export class AdminCommand extends BaseCommand {
  /** P6 M6.1 RBAC — local role file + OIDC adapter seam (see enterprise/rbac.ts). */
  private rbac = new RbacManager();

  /**
   * Enforce an RBAC action for the current identity; returns false (after
   * logging) when denied. Legacy single-user mode (no role file) stays fully
   * permissive — enabling RBAC never locks you out; once roles are assigned,
   * policy writes require `admin`. Callers abort on false.
   */
  private guard(action: AdminAction): boolean {
    // K4: single enforcement path — delegate to the shared guard so the
    // admin surface and every other guarded command can never drift.
    return guardRbacAction(action);
  }

  create(): Command {
    return new Command('admin')
      .description('Admin governance policy for Auto routing (P6 M6.5) — allow/deny providers & models, hard cost cap, PII privacy, unblock control')
      .addCommand(this.policyCommand())
      .addCommand(this.allowCommand())
      .addCommand(this.denyCommand())
      .addCommand(this.allowModelCommand())
      .addCommand(this.denyModelCommand())
      .addCommand(this.maxCostCommand())
      .addCommand(this.piiMinCommand())
      .addCommand(this.unblockCommand())
      .addCommand(this.clearCommand())
      .addCommand(this.roleCommand())
      .addCommand(this.whoamiCommand())
      .addCommand(this.cronCommand())
      .action(() => {
        this.showPolicy(false);
      });
  }

  // ─── policy ─────────────────────────────────────────────────────────────

  private policyCommand(): Command {
    return new Command('policy')
      .description('Show the current governance policy + enforcement status')
      .option('--json', 'Machine-readable JSON output')
      .action((options?: { json?: boolean }) => {
        this.showPolicy(options?.json === true);
      });
  }

  private showPolicy(json: boolean): void {
    const gov = this.configManager.getAll().routing?.governance || {};
    if (json) {
      console.log(JSON.stringify({ governance: gov, enforced: this.describeEnforcement() }, null, 2));
      return;
    }
    const hasAny = GOVERNANCE_FIELDS.some((f) => gov[f] !== undefined);
    logger.highlight('\n  ── Admin Governance Policy (P6 M6.5) ──\n');
    if (!hasAny) {
      console.log('  ⚖️  Policy is EMPTY — fully permissive. Auto routing may use any provider × model.');
      console.log('      Add rules with:  buff admin allow <provider> · buff admin deny <provider>');
      console.log('                      buff admin allow-model <model> · buff admin max-cost <usd>');
    } else {
      const row = (label: string, value: unknown): void => {
        const rendered = Array.isArray(value)
          ? (value as string[]).join(', ')
          : typeof value === 'number'
            ? label.toLowerCase().includes('cost')
              ? `$${value}`
              : String(value)
            : String(value);
        console.log(`  ${label}: ${rendered || '(none)'}`);
      };
      if (gov.allowProviders?.length) row('allowProviders', gov.allowProviders);
      else console.log('  allowProviders: (none — all providers allowed)');
      if (gov.denyProviders?.length) row('denyProviders', gov.denyProviders);
      else console.log('  denyProviders:  (none)');
      if (gov.allowModels?.length) row('allowModels', gov.allowModels);
      else console.log('  allowModels:    (none — all models allowed)');
      if (gov.denyModels?.length) row('denyModels', gov.denyModels);
      else console.log('  denyModels:     (none)');
      row('maxCostUsd', gov.maxCostUsd ?? '(none — no admin cost cap)');
      row('minPrivacyForPii', gov.minPrivacyForPii ?? '1.0 (local-only for PII)');
      if (gov.piiPatterns?.length) row('piiPatterns', gov.piiPatterns);
      else console.log('  piiPatterns:    (none — no PII domain guard)');
      row('allowUnblock', gov.allowUnblock ?? 'true (unblock escape hatch open)');
    }
    console.log(`\n  ${this.describeEnforcement()}`);
    console.log('  Rules are admin-HARD: violating providers are eliminated, never just scored lower.');
    console.log('');
  }

  private describeEnforcement(): string {
    const gov = this.configManager.getAll().routing?.governance;
    const rules = [
      gov?.allowProviders?.length ? 'provider allow-list' : null,
      gov?.denyProviders?.length ? 'provider deny-list' : null,
      gov?.allowModels?.length ? 'model allow-list' : null,
      gov?.denyModels?.length ? 'model deny-list' : null,
      gov?.maxCostUsd !== undefined ? 'admin cost cap' : null,
      gov?.piiPatterns?.length ? 'PII privacy guard' : null,
    ].filter(Boolean);
    return rules.length > 0
      ? `Enforced on every Auto pick (${rules.join(', ')})`
      : 'No rules active — every provider × model is eligible';
  }

  // ─── allow / deny providers ──────────────────────────────────────────────

  private allowCommand(): Command {
    return new Command('allow')
      .description('Add providers to the allow-list (empty = all providers allowed)')
      .argument('<providers...>', 'Provider ids (e.g. groq local)')
      .action((providers: string[]) => {
        if (!this.guard('policy.write')) return;
        this.setListField('allowProviders', providers);
      });
  }

  private denyCommand(): Command {
    return new Command('deny')
      .description('Add providers to the deny-list (wins over the allow-list)')
      .argument('<providers...>', 'Provider ids (e.g. gemini openrouter)')
      .action((providers: string[]) => {
        if (!this.guard('policy.write')) return;
        this.setListField('denyProviders', providers);
      });
  }

  // ─── allow-model / deny-model ────────────────────────────────────────────

  private allowModelCommand(): Command {
    return new Command('allow-model')
      .description('Add models to the allow-list — a provider survives only if one of its candidate models is listed')
      .argument('<models...>', 'Model ids (e.g. llama-3.3-70b-versatile)')
      .action((models: string[]) => {
        if (!this.guard('policy.write')) return;
        this.setListField('allowModels', models);
      });
  }

  private denyModelCommand(): Command {
    return new Command('deny-model')
      .description('Add models to the deny-list (wins over the allow-list)')
      .argument('<models...>', 'Model ids')
      .action((models: string[]) => {
        if (!this.guard('policy.write')) return;
        this.setListField('denyModels', models);
      });
  }

  private setListField(field: 'allowProviders' | 'denyProviders' | 'allowModels' | 'denyModels', values: string[]): void {
    const gov = this.configManager.getAll().routing?.governance || {};
    const merged = appendUnique(gov[field], values);
    this.configManager.save({
      routing: { governance: { ...gov, [field]: merged } },
    } as Partial<BuffConfig>);
    logger.success(`${field} = ${merged.join(', ')}`);
  }

  // ─── max-cost ────────────────────────────────────────────────────────────

  private maxCostCommand(): Command {
    return new Command('max-cost')
      .description('Set the admin hard max cost per call (USD); joins routing.maxCostUsd (stricter wins)')
      .argument('<usd>', 'Max cost per call in USD (e.g. 0.01)')
      .action((usd: string) => {
        if (!this.guard('policy.write')) return;
        const num = Number(usd);
        if (isNaN(num) || num < 0) {
          logger.error(`Invalid max-cost "${usd}". Must be a non-negative number (USD).`);
          return;
        }
        const gov = this.configManager.getAll().routing?.governance || {};
        this.configManager.save({
          routing: { governance: { ...gov, maxCostUsd: num } },
        } as Partial<BuffConfig>);
        logger.success(`governance.maxCostUsd = ${num}`);
      });
  }

  // ─── pii-min ─────────────────────────────────────────────────────────────

  private piiMinCommand(): Command {
    return new Command('pii-min')
      .description('Set the minimum privacy score (0-1) required when a task matches a PII pattern (default 1.0 = local-only)')
      .argument('<score>', '0 to 1 (1.0 = only fully-local providers may serve PII)')
      .action((score: string) => {
        if (!this.guard('policy.write')) return;
        const num = Number(score);
        if (isNaN(num) || num < 0 || num > 1) {
          logger.error(`Invalid pii-min "${score}". Must be between 0 and 1.`);
          return;
        }
        const gov = this.configManager.getAll().routing?.governance || {};
        this.configManager.save({
          routing: { governance: { ...gov, minPrivacyForPii: num } },
        } as Partial<BuffConfig>);
        logger.success(`governance.minPrivacyForPii = ${num}`);
      });
  }

  // ─── unblock on|off ──────────────────────────────────────────────────────

  private unblockCommand(): Command {
    return new Command('unblock')
      .description('Control whether `buff models unblock` may override REGISTRY-learned blocks (false = admin-hard)')
      .argument('<on|off>', 'on (escape hatch open, default) or off (admin-hard)')
      .action((mode: string) => {
        if (!this.guard('policy.write')) return;
        const lower = mode.trim().toLowerCase();
        if (lower !== 'on' && lower !== 'off') {
          logger.error(`Invalid unblock "${mode}". Use "on" or "off".`);
          return;
        }
        const gov = this.configManager.getAll().routing?.governance || {};
        this.configManager.save({
          routing: { governance: { ...gov, allowUnblock: lower === 'on' } },
        } as Partial<BuffConfig>);
        logger.success(`governance.allowUnblock = ${lower === 'on'} (${lower === 'on' ? 'unblock allowed' : 'registry blocks are admin-hard'})`);
      });
  }

  // ─── clear <field> ───────────────────────────────────────────────────────

  private clearCommand(): Command {
    return new Command('clear')
      .description('Remove one governance rule (the policy becomes permissive on that field)')
      .argument('<field>', `Field to clear: ${GOVERNANCE_FIELDS.join(', ')}`)
      .action((field: string) => {
        if (!this.guard('policy.write')) return;
        if (!(GOVERNANCE_FIELDS as ReadonlyArray<string>).includes(field)) {
          logger.error(`Unknown governance field "${field}". Valid: ${GOVERNANCE_FIELDS.join(', ')}`);
          return;
        }
        const gov = this.configManager.getAll().routing?.governance || {};
        const { [field as keyof GovernanceConfig]: _removed, ...rest } = gov;
        this.configManager.save({
          routing: { governance: rest },
        } as Partial<BuffConfig>);
        logger.success(`Cleared governance.${field}`);
      });
  }

  // ─── role add / remove / list (P6 M6.1 RBAC — admin only) ────────────────

  private roleCommand(): Command {
    return new Command('role')
      .description('Manage RBAC roles over the admin surface (P6 M6.1 — requires admin role)')
      .addCommand(new Command('add')
        .description('Assign a role to a user (first assignment exits legacy single-user mode)')
        .argument('<user>', 'Username (OS user, or the OIDC subject for token mode)')
        .argument('<role>', `Role: ${ROLES.join(' | ')}`)
        .action((user: string, role: string) => {
          if (!this.guard('role.manage')) return;
          try {
            const r = this.rbac.assignRole(user, role as Role, 'local');
            logger.success(`${user} → ${r.role}`);
            logger.info('Policy writes now require the admin role. Run `buff admin whoami` to confirm yours.');
          } catch (err) {
            if (err instanceof RbacError) logger.error(`⛔ ${err.message}`);
            else throw err;
          }
        }))
      .addCommand(new Command('remove')
        .description('Remove a user\'s role assignment (if none remain, legacy permissive mode resumes)')
        .argument('<user>', 'Username')
        .action((user: string) => {
          if (!this.guard('role.manage')) return;
          if (this.rbac.removeUser(user)) logger.success(`Removed role for ${user}`);
          else logger.error(`No role assignment found for ${user}`);
        }))
      .addCommand(new Command('list')
        .description('List all role assignments')
        .action(() => {
          if (!this.guard('role.manage')) return;
          const users = this.rbac.listUsers();
          logger.highlight('\n  ── RBAC Role Assignments (P6 M6.1) ──\n');
          if (users.length === 0) {
            console.log('  Legacy single-user mode — no roles assigned, everything allowed.');
          } else {
            for (const u of users) {
              console.log(`  ${u.user.padEnd(22)} ${u.role.padEnd(9)} via ${u.via || 'local'} · added ${new Date(u.addedAt).toLocaleString()}`);
            }
          }
          console.log('');
        }));
  }

  // ─── whoami ──────────────────────────────────────────────────────────────

  private whoamiCommand(): Command {
    return new Command('whoami')
      .description('Show the current identity and its effective RBAC permissions')
      .action(() => {
        const user = RbacManager.currentIdentity();
        const role = this.rbac.getRole(user);
        logger.highlight('\n  ── RBAC Identity (P6 M6.1) ──\n');
        console.log(`  User: ${user}`);
        if (role) {
          console.log(`  Role: ${role}`);
          console.log(`  Can:  ${this.rbac.permissionsFor(role).join(', ')}`);
        } else if (this.rbac.isLegacyMode()) {
          console.log('  Role: none (legacy single-user mode — full access)');
          console.log('  Can:  everything (until roles are assigned)');
        } else {        console.log('  Role: unassigned (viewer-equivalent — read-only)');
        console.log('  Can:  policy.read');
        }
        console.log('');
      });
  }

  // ─── cron (J2 — scheduled tool invocations) ─────────────────────────────

  private cronCommand(): Command {
    const cron = new Command('cron')
      .description('Scheduled tool invocations (J2 — cron/jobs.py)');

    cron
      .command('add <name> <schedule> <tool>')
      .description('Add a cron job: buff admin cron add nightly-build "0 3 * * *" build')
      .option('--args <json>', 'Tool arguments as JSON (e.g. {"goal":"build"})')
      .option('--channel <alias>', 'Deliver the result to a gateway channel alias (J1)')
      .option('--dry-run', 'Validate the schedule + tool WITHOUT saving', false)
      .action((name, schedule, tool, opts) => this.cronAdd(name, schedule, tool, opts));

    cron
      .command('list')
      .description('List cron jobs with schedule + next run')
      .action(() => this.cronList());

    cron
      .command('remove <name>')
      .description('Remove a cron job')
      .action((name) => this.cronRemove(name));

    cron
      .command('run <name>')
      .description('Run a cron job NOW (invoke its tool immediately)')
      .action(async (name) => this.cronRun(name));

    return cron;
  }

  private parseCronArgs(raw?: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!raw) return { ok: true, args: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '--args must be a JSON object' };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: `--args is not valid JSON: ${raw}` };
    }
  }

  private cronAdd(
    name: string,
    schedule: string,
    tool: string,
    opts: { args?: string; dryRun?: boolean; channel?: string },
  ): void {
    if (!this.guard('cron.manage')) return;
    const parsedArgs = this.parseCronArgs(opts.args);
    if (!parsedArgs.ok) {
      logger.error(parsedArgs.error);
      return;
    }
    if (opts.dryRun) {
      const dry = dryRunCronJob(name, schedule, tool, parsedArgs.args);
      if (!dry.ok) {
        logger.error(dry.error);
        return;
      }
      logger.info(`✅ DRY RUN: ${dry.description}`);
      logger.info(`   Next run: ${dry.nextRun}`);
      return;
    }
    const result = addCronJob(name, schedule, tool, parsedArgs.args, opts.channel);
    if (!result.ok) {
      logger.error(result.error);
      return;
    }
    logger.success(`✅ Added cron job '${result.job.name}' → ${result.job.tool} every '${result.job.schedule}'`);
  }

  private cronList(): void {
    const jobs = listCronJobs();
    if (jobs.length === 0) {
      logger.info('No cron jobs defined.');
      logger.info('  Add one: buff admin cron add <name> "0 3 * * *" <tool> [--args <json>]');
      return;
    }
    console.log(`\n⏱  ${jobs.length} cron job(s):\n`);
    for (const j of jobs) {
      const next = nextRunAt(j.schedule);
      const nextStr = next ? next.toLocaleString() : 'never';
      const enabled = j.enabled ? '✅' : '⏸️';
      const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never';
      console.log(`  ${enabled} ${j.name} — ${j.tool} every '${j.schedule}'`);
      console.log(`     next: ${nextStr} · last run: ${lastRun}`);
      console.log('');
    }
  }

  private cronRemove(name: string): void {
    if (!this.guard('cron.manage')) return;
    if (removeCronJob(name)) {
      logger.success(`✅ Removed cron job '${name}'.`);
    } else {
      logger.error(`No cron job named '${name}'.`);
    }
  }

  private async cronRun(name: string): Promise<void> {
    if (!this.guard('cron.manage')) return;
    const job = listCronJobs().find((j) => j.name === name);
    if (!job) {
      logger.error(`No cron job named '${name}'.`);
      return;
    }
    const spinner = ora({ text: `Running '${job.name}'...`, spinner: 'dots' }).start();
    const { ok, output } = await runJobNow(job);
    spinner.stop();
    if (ok) {
      logger.success(`✅ '${job.name}' completed.`);
      if (output) console.log(output);
    } else {
      logger.error(`❌ '${job.name}' failed: ${output}`);
    }
  }
}
