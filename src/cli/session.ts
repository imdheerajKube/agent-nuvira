/**
 * Session command — Debug surface for project-scoped session continuity (G1).
 *
 * The PRIMARY path is D1 auto-recall (a bare `continue` resumes everything);
 * this command is the explicit/scriptable surface for the same machinery:
 *
 *   nuvira session list [--project <id>] [--since "last week"] [--limit N]
 *       — Recent sessions, optionally filtered by project + temporal phrase
 *   nuvira session summarize <id>
 *       — Metadata + summary for one session (not raw messages — use
 *         `nuvira history show` for the transcript)
 *   nuvira session resume [--project <id>]
 *       — Run D1 autoRecall and print the recall card (facts + checkpoint +
 *         last goal) for the project
 *
 * Everything reuses the D1 modules (searchSessions, autoRecall, recallCard,
 * textRangeToEpoch) — this is a debug/scripting surface, never a second
 * implementation of recall.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { getChatHistory } from '../context/history.js';
import { autoRecall, recallCard, textRangeToEpoch } from '../context/session-recall.js';
import { logger } from '../utils/logger.js';

export class SessionCommand extends BaseCommand {
  create(): Command {
    const command = new Command('session')
      .description('Project-scoped session continuity (debug surface — `continue` is the primary path)');

    // ── list ─────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List recent sessions, optionally filtered by project + time range')
      .option('--project <id>', 'Only sessions for this project (git slug or cwd:<hash>)')
      .option('--since <phrase>', 'Temporal filter, e.g. "last week" / "yesterday" (no LLM)', '')
      .option('-l, --limit <number>', 'Maximum results', parseInt, 10)
      .action(async (options?: { project?: string; since?: string; limit?: number }) => {
        await this.listSessions({
          project: options?.project,
          since: options?.since || '',
          limit: options?.limit || 10,
        });
      });

    // ── summarize ────────────────────────────────────────────────────────
    command
      .command('summarize')
      .description('Show summary + metadata for one session (transcript: nuvira history show)')
      .argument('<id>', 'Session ID (prefix matching allowed)')
      .action((id: string) => {
        this.summarizeSession(id);
      });

    // ── resume ───────────────────────────────────────────────────────────
    command
      .command('resume')
      .description('Run D1 auto-recall for a project and print the recall card')
      .option('--project <id>', 'Project id (default: derived from cwd)')
      .option('--since <phrase>', 'Temporal filter, e.g. "last week"', '')
      .action(async (options?: { project?: string; since?: string }) => {
        await this.resumeProject({ project: options?.project, since: options?.since || '' });
      });

    return command;
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  private async listSessions(opts: {
    project?: string;
    since?: string;
    limit: number;
  }): Promise<void> {
    const history = getChatHistory();
    const projectId = opts.project || (await this.resolveProjectId());
    const timeRange = opts.since ? textRangeToEpoch(opts.since) : undefined;

    const sessions = history.searchSessions({
      projectId: projectId || undefined,
      timeRange,
      limit: opts.limit,
    });

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  📚  Sessions' + (projectId ? ` — project ${projectId}` : ' (all projects)'));
    logger.highlight(`${'═'.repeat(60)}`);
    console.log('');

    if (sessions.length === 0) {
      logger.info('  No sessions found.'
        + (projectId ? ' Try `nuvira session list` without --project to see all.' : '')
        + (opts.since ? ` Nothing within "${opts.since}".` : ''));
      console.log('');
      return;
    }

    for (const s of sessions) {
      console.log(history.formatSessionSummary(s));
    }
    console.log('');
    logger.info('Full transcript:  nuvira history show <id>');
    logger.info('Resume a project: nuvira session resume [--project <id>]');
    console.log('');
  }

  private summarizeSession(id: string): void {
    const history = getChatHistory();
    const sessions = history.getAllSessions(200);
    const match = sessions.find(
      (s) => s.id === id || s.id.startsWith(id) || s.id.includes(id),
    );

    if (!match) {
      logger.error(`Session not found: ${id}`);
      logger.info('Use `nuvira session list` to see available sessions.');
      return;
    }

    const date = new Date(match.startedAt).toLocaleString();
    const tags = match.tags.length > 0 ? ` [${match.tags.join(', ')}]` : '';

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  💬  ${match.summary.slice(0, 60)}`);
    logger.highlight(`${'═'.repeat(60)}`);
    console.log(`  ID:       ${match.id}`);
    console.log(`  Project:  ${match.projectId || '(unknown)'}`);
    console.log(`  Provider: ${match.provider}  |  Model: ${match.model}`);
    console.log(`  Started:  ${date}${tags}`);
    console.log(`  Messages: ${match.messages.length}`);
    console.log('');
    console.log(`  Summary: ${match.summary}`);
    console.log('');
    logger.info('Full transcript: nuvira history show ' + match.id);
    console.log('');
  }

  private async resumeProject(opts: { project?: string; since?: string }): Promise<void> {
    const result = await autoRecall({
      projectId: opts.project || (await this.resolveProjectId()),
      ...(opts.since ? { timeRangeText: opts.since } : {}),
    });

    if (result.sessionCount === 0 && result.factCount === 0 && !result.project) {
      logger.info('Nothing to recall for this project yet — it will appear here after the first session.');
      console.log('');
      return;
    }

    console.log(recallCard(result));
  }

  private async resolveProjectId(): Promise<string | undefined> {
    try {
      const { deriveProjectId } = await import('../config/workspace.js');
      return deriveProjectId(process.cwd()).id;
    } catch {
      return undefined;
    }
  }
}
