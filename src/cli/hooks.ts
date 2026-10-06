/**
 * HooksCommand — `nuvira hooks` — the declarative lifecycle hooks, from the CLI.
 *
 * A hook here is a RULE, not code: it binds to one of nuvira's four lifecycle
 * seams (`before_tool_call`, `after_tool_call`, `failed_tool_call`,
 * `on_session_end`) and its only possible actions are `deny`, `notify` and
 * `scan-args` — a fixed, native allow-list. Installing one can therefore never
 * execute third-party code. See `docs/HOOKS.md` and
 * `src/gateway/hook-contract.ts`.
 *
 * This is the CLI face of the same `<config-dir>/hooks.json` the dashboard's
 * Hooks page edits, and the same contract the runtime reads live. Both surfaces
 * share `hook-contract.ts`, so the vocabulary cannot drift.
 *
 * Subcommands:
 *   nuvira hooks list                       — built-in + user hooks, with state
 *   nuvira hooks add --id … --label … …     — declare a hook
 *   nuvira hooks remove <id>                — remove a user hook
 *   nuvira hooks enable <id>                — turn a hook on (also a built-in)
 *   nuvira hooks disable <id>               — turn a hook off
 *
 * The built-in starter set (block `rm -rf`, catch secrets in writes/commands)
 * ships DISABLED; `enable` on a built-in materializes it into the file.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  HOOK_ACTION_KINDS,
  HOOK_EVENTS,
  builtinHookById,
  hookDeclarationsFile,
  listHookDeclarations,
  readHookDeclarations,
  setHookDeclarations,
  type HookAction,
  type HookDeclaration,
  type HookEvent,
  type HookMatcher,
} from '../gateway/hook-contract.js';

/** Repeatable `--arg key=glob` collector. */
function collectArg(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/** `key=glob` lines → the `argsMatch` record. Blank / malformed entries drop. */
function parseArgsMatch(values: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const key = raw.slice(0, eq).trim();
    const glob = raw.slice(eq + 1).trim();
    if (key && glob) out[key] = glob;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A one-line, human summary of what a declaration matches and does. */
function describeHook(hook: HookDeclaration): string {
  const when = hook.when ?? {};
  const parts: string[] = [];
  if (when.tool) parts.push(`tool ${when.tool}`);
  if (when.surface) parts.push(`surface ${when.surface}`);
  if (when.cwdPrefix) parts.push(`cwd ${when.cwdPrefix}*`);
  if (when.argsMatch) for (const [k, v] of Object.entries(when.argsMatch)) parts.push(`${k}=${v}`);
  const target = parts.length > 0 ? parts.join(' · ') : 'every call';
  switch (hook.action.kind) {
    case 'deny':
      return `${target} → deny${hook.action.reason ? `: ${hook.action.reason}` : ''}`;
    case 'notify':
      return `${target} → notify: ${hook.action.message}`;
    case 'scan-args':
      return `${target} → scan args for secrets${hook.action.denyOnHit ? ' (deny on hit)' : ''}`;
  }
}

export class HooksCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('hooks')
      .description(
        'Declarative lifecycle hooks — list/add/remove the rules that deny, notify or secret-scan tool calls (the same hooks.json the dashboard Hooks page edits; a hook is data, never code)',
      )
      .option('-v, --verbose', 'verbose output');

    cmd
      .command('list')
      .description('List built-in and user hooks with their seam, action and state')
      .action(() => {
        const all = listHookDeclarations();
        logger.highlight('\n🪝 Hooks');
        if (all.length === 0) {
          logger.info('   No hooks declared.');
          console.log('');
          return;
        }
        for (const hook of all) {
          const state = hook.enabled ? '✅ enabled ' : '⭕ disabled';
          const source = hook.source === 'builtin' ? 'builtin' : 'user';
          console.log(`   ${state}  ${hook.id} [${source}] (${hook.event})`);
          console.log(`        ${hook.label}`);
          console.log(`        ${describeHook(hook)}`);
        }
        console.log('');
        logger.info(`   File: ${hookDeclarationsFile()}`);
        console.log('');
      });

    cmd
      .command('add')
      .description('Declare a new hook (it is enabled unless --disabled is given)')
      .requiredOption('--id <id>', 'unique id: lowercase letters, digits and hyphens')
      .requiredOption('--label <label>', 'human label')
      .requiredOption('--event <event>', `seam: ${HOOK_EVENTS.join(' | ')}`)
      .requiredOption('--action <kind>', `action: ${HOOK_ACTION_KINDS.join(' | ')}`)
      .option('--tool <glob>', 'tool-name glob to match (e.g. run_terminal, run_*)')
      .option('--surface <glob>', 'surface glob to match (e.g. cli-chat)')
      .option('--cwd <prefix>', 'only match calls whose cwd starts with this prefix')
      .option('--arg <key=glob>', 'shallow arg matcher, repeatable (e.g. --arg "command=*rm -rf*")', collectArg, [] as string[])
      .option('--reason <text>', 'reason shown when a deny (or deny-on-hit) blocks the call')
      .option('--message <text>', 'notify message ({tool} / {surface} / {event} interpolated)')
      .option('--deny-on-hit', 'scan-args: block the call when a secret shape is found')
      .option('--disabled', 'add it switched off (the dashboard adds them on by default)')
      .action((opts: Record<string, unknown>) => {
        const id = String(opts.id ?? '');
        const label = String(opts.label ?? '');
        const event = String(opts.event ?? '') as HookEvent;
        const kind = String(opts.action ?? '') as HookAction['kind'];

        if (!HOOK_EVENTS.includes(event)) {
          logger.error(`Unknown --event '${event}'. Choose one of: ${HOOK_EVENTS.join(', ')}`);
          return;
        }
        if (!HOOK_ACTION_KINDS.includes(kind)) {
          logger.error(`Unknown --action '${kind}'. Choose one of: ${HOOK_ACTION_KINDS.join(', ')}`);
          return;
        }

        const when: HookMatcher = {
          ...(typeof opts.tool === 'string' && opts.tool ? { tool: opts.tool } : {}),
          ...(typeof opts.surface === 'string' && opts.surface ? { surface: opts.surface } : {}),
          ...(typeof opts.cwd === 'string' && opts.cwd ? { cwdPrefix: opts.cwd } : {}),
          ...(parseArgsMatch((opts.arg as string[]) ?? []) ? { argsMatch: parseArgsMatch((opts.arg as string[]) ?? []) } : {}),
        };
        const reason = typeof opts.reason === 'string' && opts.reason ? opts.reason : undefined;
        const message = typeof opts.message === 'string' && opts.message ? opts.message : undefined;

        const action: HookAction =
          kind === 'deny'
            ? { kind: 'deny', ...(reason ? { reason } : {}) }
            : kind === 'notify'
              ? { kind: 'notify', message: message ?? 'hook fired: {tool}' }
              : { kind: 'scan-args', denyOnHit: Boolean(opts.denyOnHit), ...(reason ? { reason } : {}) };

        const declaration: HookDeclaration = {
          id,
          label,
          event,
          enabled: !opts.disabled,
          ...(Object.keys(when).length > 0 ? { when } : {}),
          action,
          source: 'user',
          updatedAt: Date.now(),
        };

        const user = readHookDeclarations();
        if (user.some((h) => h.id === id)) {
          logger.error(`A hook with id '${id}' already exists. Remove it, or use 'enable'/'disable'.`);
          console.log('');
          return;
        }
        const saved = setHookDeclarations([...user, declaration]);
        if (!saved.ok) {
          logger.error(`Rejected: ${saved.error}`);
          console.log('');
          return;
        }
        logger.success(`➕ Added hook '${id}' (${declaration.enabled ? 'enabled' : 'disabled'}).`);
        logger.info(`   In force on the next tool call. Inspect it: nuvira hooks list`);
        console.log('');
      });

    cmd
      .command('remove <id>')
      .description('Remove a user hook (a built-in cannot be deleted — disable it instead)')
      .action((id: string) => {
        const user = readHookDeclarations();
        if (!user.some((h) => h.id === id)) {
          if (builtinHookById(id)) {
            logger.warn(`'${id}' is a built-in default and cannot be removed. Turn it off with: nuvira hooks disable ${id}`);
          } else {
            logger.warn(`No user hook '${id}'.`);
          }
          console.log('');
          return;
        }
        const isBuiltin = Boolean(builtinHookById(id));
        const saved = setHookDeclarations(user.filter((h) => h.id !== id));
        if (!saved.ok) {
          logger.error(saved.error);
          console.log('');
          return;
        }
        logger.success(
          isBuiltin
            ? `↺ Reset built-in '${id}' to its default (disabled).`
            : `🗑️  Removed hook '${id}'.`,
        );
        console.log('');
      });

    const setEnabled = (enabled: boolean) => (id: string) => {
      const user = readHookDeclarations();
      const existing = user.find((h) => h.id === id);
      let next: HookDeclaration[];
      if (existing) {
        next = user.map((h) => (h.id === id ? { ...h, enabled, updatedAt: Date.now() } : h));
      } else {
        const builtin = builtinHookById(id);
        if (!builtin) {
          logger.warn(`No hook '${id}'. Declare it first: nuvira hooks add --id ${id} …`);
          console.log('');
          return;
        }
        // Enabling a built-in materializes it into the file so the runtime —
        // which follows the user set — actually sees it.
        next = [...user, { ...builtin, enabled, updatedAt: Date.now() }];
      }
      const saved = setHookDeclarations(next);
      if (!saved.ok) {
        logger.error(saved.error);
        console.log('');
        return;
      }
      logger.success(`${enabled ? '✅ Enabled' : '⭕ Disabled'} '${id}'.`);
      console.log('');
    };

    cmd.command('enable <id>').description('Turn a hook on (works on a built-in too)').action(setEnabled(true));
    cmd.command('disable <id>').description('Turn a hook off').action(setEnabled(false));

    return cmd;
  }
}
