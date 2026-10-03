/**
 * ContinuityCommand — `nuvira continuity` — inspect and forget what the
 * continuity features store on disk.
 *
 * Continuity is ON by default (like checkpointing): the loop persists session
 * transcripts across process death (`session-store.ts`) and indexes finished asks
 * for semantic recall (`session-recall.ts`). A feature that writes to the user's
 * home without being asked must be inspectable and erasable from the CLI, not
 * only from the dashboard.
 *
 * Subcommands:
 *   nuvira continuity list            — the switches, the snapshots, the recall index
 *   nuvira continuity clear [--sessions] [--recall]
 *                                     — forget stored continuity data (no flags = both)
 *
 * The switches themselves live in config (`memory.sessionStore` /
 * `memory.sessionRecall`), the environment (`NUVIRA_SESSION_STORE` /
 * `NUVIRA_SESSION_RECALL`), and per-run flags on `execute`; `list` reports the
 * EFFECTIVE state through the same resolvers the engine uses, so it cannot lie.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  clearSession,
  listSessionSnapshots,
  resolveSessionStore,
  type SessionSnapshot,
} from '../learning/session-store.js';
import {
  clearSessionRecallIndex,
  listRecallEntries,
  resolveSessionRecall,
  type RecallEntry,
} from '../learning/session-recall.js';

/** Relative age, spelled for a human reader. */
function relativeAge(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export class ContinuityCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('continuity')
      .description('Session continuity — what is stored, and how to forget it');

    cmd
      .command('list')
      .description('Show the continuity switches, stored sessions, and the semantic recall index')
      .action(async () => {
        const { sessionStore: storeOn, sessionRecall: recallOn, sessions, recall } =
          buildContinuitySummary(this.configManager);

        logger.highlight('\n🔗 Continuity');
        logger.info(
          `   Session store: ${storeOn ? 'ON' : 'OFF'}   Semantic recall: ${recallOn ? 'ON' : 'OFF'}`,
        );
        logger.info('   Toggle: memory.sessionStore / memory.sessionRecall, NUVIRA_SESSION_STORE / NUVIRA_SESSION_RECALL, or --[no-]session-store / --[no-]session-recall');

        console.log('');
        console.log(`   Stored sessions:      ${sessions.length}`);
        for (const s of sessions.slice(0, 20)) {
          const state = s.open ? 'OPEN ' : 'closed';
          console.log(`     • [${state}] ${s.goal}  —  ${s.accumulators.steps} step(s), ${relativeAge(s.savedAt)}`);
        }
        if (sessions.length > 20) console.log(`     … and ${sessions.length - 20} more`);

        console.log('');
        console.log(`   Recall index entries: ${recall.length}`);
        for (const r of recall.slice(0, 20)) {
          console.log(`     • ${r.outcome}: ${r.goal}  —  ${relativeAge(r.savedAt)}`);
        }
        if (recall.length > 20) console.log(`     … and ${recall.length - 20} more`);
        console.log('');
        logger.info('Forget with: `nuvira continuity clear [--sessions] [--recall]`');
      });

    cmd
      .command('clear')
      .description('Forget stored continuity data (no flags = both sessions and recall)')
      .option('--sessions', 'forget stored session snapshots only')
      .option('--recall', 'forget the semantic recall index only')
      .action((options: { sessions?: boolean; recall?: boolean }) => {
        const { removedSessions, removedRecall, wantSessions, wantRecall } = clearContinuity(options);

        const parts: string[] = [];
        if (wantSessions) parts.push(`${removedSessions} session snapshot(s)`);
        if (wantRecall) parts.push(`${removedRecall} recall index`);
        logger.success(`   Cleared ${parts.join(' and ')}.`);
      });

    return cmd;
  }
}

/** The data `continuity list` renders, for tests and future surfaces. */
export interface ContinuitySummary {
  sessionStore: boolean;
  sessionRecall: boolean;
  sessions: SessionSnapshot[];
  recall: RecallEntry[];
}

/** Structural config shape, so the summary needs no ConfigManager import. */
interface ConfigManagerLike {
  getAll(): { memory?: { sessionStore?: boolean; sessionRecall?: boolean } };
}

/** Build the data `continuity list` renders — one place, so it cannot drift. */
export function buildContinuitySummary(cm: ConfigManagerLike): ContinuitySummary {
  return {
    sessionStore: resolveSessionStore({ configManager: cm }),
    sessionRecall: resolveSessionRecall({ configManager: cm }),
    sessions: listSessionSnapshots(),
    recall: listRecallEntries(),
  };
}

/**
 * Forget continuity data. No flag = both (the safe, complete reset); `--sessions`
 * or `--recall` narrows it. Exported so a test can drive it without commander and
 * so a future surface (the dashboard) can reuse the exact same semantics.
 */
export function clearContinuity(options: { sessions?: boolean; recall?: boolean } = {}): {
  removedSessions: number;
  removedRecall: number;
  wantSessions: boolean;
  wantRecall: boolean;
} {
  const noFlags = options.sessions !== true && options.recall !== true;
  const wantSessions = options.sessions === true || noFlags;
  const wantRecall = options.recall === true || noFlags;

  let removedSessions = 0;
  if (wantSessions) {
    for (const s of listSessionSnapshots()) if (clearSession(s.id)) removedSessions += 1;
  }
  const removedRecall = wantRecall && clearSessionRecallIndex() ? 1 : 0;
  return { removedSessions, removedRecall, wantSessions, wantRecall };
}
