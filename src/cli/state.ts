/**
 * `nuvira state` — the ONE-READ project state surface.
 *
 * WHY THIS EXISTS. Four honest records already exist for a project, and they
 * live in four places: the plan (`plan-store`), the resumable sessions
 * (`session-store`), the per-file verification debt (`working-state`), and the
 * repository's own drift (`git-digest`). Answering "where does this project
 * stand?" meant running four commands and mentally joining them — and the cost
 * of that was visible in the measured failures this programme fixed: the plan
 * froze at "1/7 steps" for two days, and a debt that only lived in the ledger
 * never reached the trace. This command prints all four, in order, from those
 * same modules — no second implementation, no new state, no model call.
 *
 * IT IS READ-ONLY. Nothing here writes a plan, a session, a ledger or a git
 * ref; `--json` prints the same facts for a script.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { planFilePath, readPlanFile } from '../tools/plan-store.js';
import { buildGitStateDigest } from '../tools/git-digest.js';
import { listSessionSnapshots } from '../learning/session-store.js';
import {
  getWorkingState,
  normalizeProjectPath,
  reconcileWithWorkspace,
} from '../learning/working-state.js';

/** `3m ago` / `2h ago` / `4d ago` — the same vocabulary the ledger block uses. */
function ageLabel(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STEP_GLYPH: Record<string, string> = { done: '✅', running: '🔄', blocked: '⛔', pending: '⬜' };

export class StateCommand extends BaseCommand {
  create(): Command {
    return new Command('state')
      .description('Print this project\u2019s tracked state in one read: plan, open sessions, per-file verification debt, git drift')
      .option('-d, --dir <path>', 'Project directory (default: the current directory)')
      .option('--json', 'Print the same facts as JSON (for scripts)')
      .action(async (options?: { dir?: string; json?: boolean }) => {
        const dir = normalizeProjectPath(options?.dir || process.cwd());
        const now = Date.now();

        // ── The plan. Scope matches the CLI's own store key (`cli:<cwd>`), so
        //    this reads the SAME plan the chat turns advance — not a copy.
        const plan = readPlanFile(planFilePath(`cli:${dir}`));
        // ── The ledger + the world behind it.
        const state = getWorkingState(dir);
        const reconciled = reconcileWithWorkspace(state, dir, now);
        // ── Open sessions for THIS directory (a closed session is history, not
        //    a resume point — the store's own rule).
        const openSessions = listSessionSnapshots().filter(
          (s) => s.open && normalizeProjectPath(s.cwd) === dir,
        );
        const gitLines = buildGitStateDigest(dir);

        if (options?.json) {
          console.log(
            JSON.stringify(
              {
                dir,
                plan,
                ledger: state,
                workspace: reconciled,
                openSessions: openSessions.map((s) => ({
                  id: s.id,
                  goal: s.goal,
                  savedAt: s.savedAt,
                  steps: s.accumulators.steps,
                  mutatedPaths: s.accumulators.mutatedPaths,
                })),
                git: gitLines,
              },
              null,
              2,
            ),
          );
          return;
        }

        logger.highlight('═'.repeat(60));
        logger.highlight(`  📍  Project state — ${dir}`);
        logger.highlight('═'.repeat(60));
        console.log('');

        // ── Plan ──────────────────────────────────────────────────────────
        if (plan) {
          const done = plan.steps.filter((s) => s.status === 'done').length;
          const percent = plan.steps.length === 0 ? 0 : Math.round((100 * done) / plan.steps.length);
          logger.info(`🗂️  Plan — ${plan.goal}  (${done}/${plan.steps.length} done, ${percent}%)`);
          for (const [i, s] of plan.steps.entries()) {
            const note = s.note ? `  — ${s.note}` : '';
            console.log(`    ${STEP_GLYPH[s.status] ?? '⬜'} ${i + 1}. ${s.description}${note}`);
          }
          const open = plan.steps.filter((s) => s.status !== 'done').length;
          if (open > 0) {
            logger.info(`    ${open} step(s) still open — advance it with the \`plan_todo\` tool or ` +
              'they will keep reading as outstanding work.');
          }
        } else {
          logger.info('🗂️  Plan — none tracked for this directory.');
        }
        console.log('');

        // ── Open sessions ─────────────────────────────────────────────────
        if (openSessions.length === 0) {
          logger.info('🔓 Open sessions — none (every recorded turn in this directory finished).');
        } else {
          logger.info(`🔓 Open sessions — ${openSessions.length} resumable:`);
          for (const s of openSessions) {
            console.log(
              `    ${s.id}  (${ageLabel(s.savedAt, now)}, ${s.accumulators.steps} step(s), ` +
                `${s.accumulators.mutatedPaths.length} path(s) changed)`,
            );
            if (s.goal) console.log(`      goal: ${s.goal.slice(0, 140)}`);
          }
        }
        console.log('');

        // ── Per-file verification debt ────────────────────────────────────
        const owed = state?.unverifiedPaths ?? [];
        if (owed.length === 0) {
          logger.info(
            '⚠️  Unverified changes — none outstanding' +
              (state?.lastVerifiedAt !== undefined
                ? ` (last verified ${ageLabel(state.lastVerifiedAt, now)}).`
                : '.'),
          );
        } else {
          logger.info(`⚠️  Unverified changes — ${owed.length} path(s) no check has exercised:`);
          for (const u of owed) console.log(`    • ${u.path}  (${ageLabel(u.at, now)})`);
          if (state && state.unverifiedEdits > 0) {
            logger.info(`    ${state.unverifiedEdits} turn(s) ended without a verification.`);
          }
        }
        console.log('');

        // ── Git drift ─────────────────────────────────────────────────────
        if (gitLines.length === 0) {
          logger.info('🌿 Git drift — not a git repository (or git is unavailable).');
        } else {
          const [, head, ...rest] = gitLines;
          // `## main...origin/main` is git's own branch header — present the branch
          // name, not the porcelain marker, since a reader wants the branch.
          const branch = (head ?? '').replace(/^[-\s]+/, '').replace(/^##\s*/, '');
          logger.info(`🌿 Git drift — ${branch || 'unknown'}`);
          for (const line of rest) console.log(`    ${line.trim()}`);
        }
        // The ledger's own disagreement with the world, when there is one: an
        // edit made outside the agent, or a turn killed before it recorded.
        if (reconciled.isGitRepo) {
          if (reconciled.staleSinceVerification.length > 0) {
            logger.info(
              `    ⚠️ ${reconciled.staleSinceVerification.length} file(s) changed on disk AFTER the last verification.`,
            );
          }
          if (reconciled.unrecorded.length > 0) {
            logger.info(
              `    ${reconciled.unrecorded.length} changed file(s) the ledger never recorded.`,
            );
          }
        }
        console.log('');
        logger.info('Read-only — nothing above was modified by this command.');
        console.log('');
      });
  }
}
