/**
 * `nuvira checkpoint` — snapshot a project's files, and roll a bad batch of edits
 * back.
 *
 * WHY A CLI AND NOT (ONLY) A TOOL. The rollback is needed by the person watching
 * the turn, and it is needed AFTER the turn has ended — the agent that made the
 * mess is not the one asked to undo it. A command also works when the agent is
 * the thing that failed, which is exactly the case a checkpoint is for.
 *
 * THE TWO OPERATIONS ARE DELIBERATELY ASYMMETRIC. `create` is cheap and safe and
 * takes no confirmation. `restore` overwrites files, so it prints what it will do,
 * supports `--dry-run`, and only deletes files the checkpoint never saw when
 * `--clean --yes` are BOTH given: removing files is the half of a rollback that
 * cannot be undone by another checkpoint.
 *
 * OPTIONS ARE READ FROM THE COMMAND (`command.opts()`), not from the handler's
 * last parameter. With an OPTIONAL positional argument commander omits the
 * trailing `undefined`, so `create --dir X` handed the options object to `label`
 * and snapshotted the process's own cwd instead — which is how a test run
 * checkpointed (and a `--clean` restore then pruned) the repository it was
 * launched from. One shape for every subcommand, and it cannot be got wrong by
 * omitting an argument.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  createWorkspaceCheckpoint,
  deleteCheckpoint,
  formatBytes,
  listCheckpoints,
  pruneCheckpoints,
  resolveCheckpoint,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from '../learning/workspace-checkpoint.js';
import { normalizeProjectPath } from '../learning/working-state.js';

/** `3m ago` / `2h ago` / `4d ago` — the vocabulary the state command uses. */
function ageLabel(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function summaryLine(checkpoint: WorkspaceCheckpoint): string {
  const size = formatBytes(checkpoint.totals.bytes);
  const skipped = checkpoint.totals.skipped > 0 ? `, ${checkpoint.totals.skipped} skipped` : '';
  return `${checkpoint.entries.length} entry(s), ${size}${skipped}`;
}

interface DirOptions {
  dir?: string;
}

/**
 * The `--dir` a subcommand was given, wherever commander recorded it.
 *
 * THE PARENT PARSES IT, NOT THE SUBCOMMAND. The root program does not enable
 * positional options, so `checkpoint create --dir X` sets `dir` on the CHECKPOINT
 * command before `create` ever sees the argument list — measured on the built CLI:
 * `--dir` was silently ignored, and a "checkpoint of /tmp/smoke" was in fact a
 * snapshot of the whole repository. Read both; the subcommand's own value wins
 * when it has one.
 */
function dirFlag(command: Command): string | undefined {
  const own = command.opts<DirOptions>().dir;
  const parent = command.parent?.opts<DirOptions>().dir;
  return own || parent;
}

export class CheckpointCommand extends BaseCommand {
  create(): Command {
    const command = new Command('checkpoint')
      .description('Snapshot a project\u2019s files and roll a bad batch of edits back')
      .option('-d, --dir <path>', 'Project directory (default: the current directory)')
      .addCommand(this.createCommand())
      .addCommand(this.listCommand())
      .addCommand(this.showCommand())
      .addCommand(this.restoreCommand())
      .addCommand(this.deleteCommand())
      .addCommand(this.pruneCommand());
    command.action(async () => {
      await this.list(normalizeProjectPath(dirFlag(command) || process.cwd()), command.opts<{ all?: boolean; limit?: string; json?: boolean }>(), true);
    });
    return command;
  }

  private createCommand(): Command {
    const command = new Command('create')
      .description('Snapshot the project\u2019s files now (cheap; unchanged files are stored once)')
      .argument('[label]', 'a name to remember this point by')
      .option('-d, --dir <path>', 'Project directory (default: the current directory)')
      .option('--max-file-bytes <n>', 'Skip files larger than this', String(2 * 1024 * 1024))
      .option('--json', 'Print the checkpoint manifest as JSON');
    command.action(async (label?: string) => {
      const options = command.opts<DirOptions & { maxFileBytes?: string; json?: boolean }>();
      const dir = normalizeProjectPath(dirFlag(command) || process.cwd());
      const checkpoint = createWorkspaceCheckpoint(dir, {
        label,
        ...(options.maxFileBytes ? { maxFileBytes: Number(options.maxFileBytes) } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(checkpoint, null, 2));
        return;
      }
      logger.success(`checkpoint ${checkpoint.id} (${checkpoint.label}) — ${summaryLine(checkpoint)}`);
      console.log(`  in ${checkpoint.cwd}`);
      // A skipped file is stated at creation, not discovered during a restore.
      for (const skipped of checkpoint.skipped.slice(0, 5)) {
        console.log(`  skipped ${skipped.path}: ${skipped.reason}`);
      }
      if (checkpoint.skipped.length > 5) {
        console.log(`  … and ${checkpoint.skipped.length - 5} more skipped (see \`checkpoint show ${checkpoint.id}\`)`);
      }
    });
    return command;
  }

  private listCommand(): Command {
    const command = new Command('list')
      .description('List this project\u2019s checkpoints, newest first')
      .option('-d, --dir <path>', 'Project directory (default: the current directory)')
      .option('-a, --all', 'Every project\u2019s checkpoints, not only this directory\u2019s')
      .option('-n, --limit <n>', 'Show at most this many', '20')
      .option('--json', 'Print as JSON');
    command.action(async () => {
      await this.list(
        normalizeProjectPath(dirFlag(command) || process.cwd()),
        command.opts<DirOptions & { all?: boolean; limit?: string; json?: boolean }>(),
        false,
      );
    });
    return command;
  }

  private async list(
    dir: string,
    options: { all?: boolean; limit?: string; json?: boolean },
    isDefault: boolean,
  ): Promise<void> {
    const checkpoints = listCheckpoints(options.all ? {} : { cwd: dir });
    const limit = Number(options.limit ?? 20);
    const shown = Number.isFinite(limit) && limit > 0 ? checkpoints.slice(0, limit) : checkpoints;

    if (options.json) {
      console.log(JSON.stringify(shown, null, 2));
      return;
    }
    if (shown.length === 0) {
      logger.info(`no checkpoints for ${dir} — \`nuvira checkpoint create\` makes one`);
      return;
    }
    logger.highlight(`\nCheckpoints${options.all ? '' : ` for ${dir}`} (newest first):\n`);
    const now = Date.now();
    for (const checkpoint of shown) {
      console.log(
        `  ${checkpoint.id}  ${ageLabel(checkpoint.createdAt, now).padEnd(9)} ` +
          `${checkpoint.label.padEnd(24)} ${summaryLine(checkpoint)}`,
      );
      if (options.all) console.log(`      ${checkpoint.cwd}`);
    }
    if (isDefault) console.log('\n  restore with: nuvira checkpoint restore <id>');
  }

  private showCommand(): Command {
    const command = new Command('show')
      .description('Show one checkpoint: what it recorded, and what it skipped')
      .argument('<id>', 'checkpoint id (a unique prefix works) or "latest"')
      .option('-d, --dir <path>', 'Restrict to this project directory')
      .option('--json', 'Print the manifest as JSON');
    command.action(async (ref: string) => {
      const options = command.opts<DirOptions & { json?: boolean }>();
      const cwd = dirFlag(command) ? normalizeProjectPath(dirFlag(command)!) : undefined;
      const checkpoint = resolveCheckpoint(ref, cwd ? { cwd } : {});
      if (!checkpoint) {
        logger.error(`checkpoint not found: ${ref}`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(checkpoint, null, 2));
        return;
      }
      logger.highlight(`\n${checkpoint.id} (${checkpoint.label})\n`);
      console.log(`  taken    ${new Date(checkpoint.createdAt).toISOString()} in ${checkpoint.cwd}`);
      console.log(`  contents ${summaryLine(checkpoint)}`);
      if (checkpoint.skipped.length > 0) {
        console.log(`  skipped  ${checkpoint.skipped.length} path(s) — restore will NOT recreate these:`);
        for (const skipped of checkpoint.skipped) console.log(`    ${skipped.path}: ${skipped.reason}`);
      }
    });
    return command;
  }

  private restoreCommand(): Command {
    const command = new Command('restore')
      .description('Put the files recorded by a checkpoint back')
      .argument('<id>', 'checkpoint id (a unique prefix works) or "latest"')
      .option('-d, --dir <path>', 'Restore into this directory (must match the checkpoint unless --force)')
      .option('--clean', 'Also delete files created after the checkpoint (requires --yes)')
      .option('--yes', 'Confirm the deletions --clean performs')
      .option('--force', 'Restore a checkpoint into a different directory than it was taken in')
      .option('--dry-run', 'Report what would change without touching disk')
      .option('--json', 'Print the result as JSON');
    command.action(async (ref: string) => {
      const options = command.opts<
        DirOptions & { clean?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean; json?: boolean }
      >();
      if (options.clean && !options.yes) {
        // Deleting files is the one part of a restore no checkpoint undoes.
        logger.error('--clean deletes files that were created after the checkpoint; re-run with --clean --yes to confirm');
        process.exitCode = 1;
        return;
      }
      const cwd = dirFlag(command) ? normalizeProjectPath(dirFlag(command)!) : undefined;
      const checkpoint = resolveCheckpoint(ref, cwd ? { cwd } : {});
      if (!checkpoint) {
        logger.error(`checkpoint not found: ${ref}`);
        process.exitCode = 1;
        return;
      }
      try {
        const result = restoreWorkspaceCheckpoint(checkpoint.id, {
          ...(cwd ? { cwd } : {}),
          clean: options.clean === true,
          force: options.force === true,
          dryRun: options.dryRun === true,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const prefix = result.dryRun ? 'would restore' : 'restored';
        logger.highlight(
          `\n${prefix} ${result.restored} file(s)` + (result.links > 0 ? ` + ${result.links} symlink(s)` : ''),
        );
        console.log(`  from ${checkpoint.id} into ${result.cwd}`);
        if (result.removed.length > 0) {
          console.log(
            `  ${result.dryRun ? 'would remove' : 'removed'} ${result.removed.length} file(s) created after the checkpoint:`,
          );
          for (const path of result.removed.slice(0, 20)) console.log(`    ${path}`);
          if (result.removed.length > 20) console.log(`    … and ${result.removed.length - 20} more`);
        }
        if (result.leftBehind.length > 0) {
          console.log(
            `  ${result.leftBehind.length} file(s) created after the checkpoint were LEFT IN PLACE — ` +
              're-run with --clean --yes to remove them',
          );
        }
      } catch (err) {
        logger.error((err as Error).message);
        process.exitCode = 1;
      }
    });
    return command;
  }

  private deleteCommand(): Command {
    const command = new Command('delete')
      .description('Delete one checkpoint (its files are not touched)')
      .argument('<id>', 'checkpoint id (a unique prefix works)');
    command.action(async (ref: string) => {
      const checkpoint = resolveCheckpoint(ref);
      if (!checkpoint) {
        logger.error(`checkpoint not found: ${ref}`);
        process.exitCode = 1;
        return;
      }
      deleteCheckpoint(checkpoint.id);
      logger.success(`deleted checkpoint ${checkpoint.id}`);
    });
    return command;
  }

  private pruneCommand(): Command {
    const command = new Command('prune')
      .description('Keep the newest N checkpoints and delete the rest')
      .option('-k, --keep <n>', 'How many to keep', '10');
    command.action(async () => {
      const keep = Number(command.opts<{ keep?: string }>().keep ?? 10);
      const deleted = pruneCheckpoints({ keep });
      if (deleted.length === 0) {
        logger.info(`nothing to prune (keeping the newest ${keep})`);
        return;
      }
      logger.success(`pruned ${deleted.length} checkpoint(s), kept the newest ${keep}`);
      for (const id of deleted) console.log(`  ${id}`);
    });
    return command;
  }
}
