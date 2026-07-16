/**
 * History command — Browse and search conversation history.
 *
 * Usage:
 *   buff history              — Show recent conversations
 *   buff history list         — Show all saved conversations
 *   buff history search <q>   — Search conversations by keyword
 *   buff history show <id>    — Show a specific conversation
 *   buff history clear        — Clear all history
 *   buff history prune        — Remove conversations older than 30 days
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { getChatHistory } from '../context/history.js';
import { logger } from '../utils/logger.js';

export class HistoryCommand extends BaseCommand {
  create(): Command {
    const command = new Command('history')
      .description('Browse and search conversation history');

    // ── list ─────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('Show all saved conversations')
      .option('-l, --limit <number>', 'Maximum results to show', parseInt, 20)
      .action((options?: { limit?: number }) => {
        this.listHistory(options?.limit || 20);
      });

    // ── search ───────────────────────────────────────────────────────────
    command
      .command('search')
      .description('Search conversations by keyword')
      .argument('<query>', 'Search keyword or phrase')
      .option('-l, --limit <number>', 'Maximum results', parseInt, 10)
      .action((query: string, options?: { limit?: number }) => {
        this.searchHistory(query, options?.limit || 10);
      });

    // ── show ─────────────────────────────────────────────────────────────
    command
      .command('show')
      .description('Show a specific conversation')
      .argument('<id>', 'Session ID (e.g., session-1712345678-abc123)')
      .action((id: string) => {
        this.showSession(id);
      });

    // ── clear ────────────────────────────────────────────────────────────
    command
      .command('clear')
      .description('Clear all conversation history')
      .action(() => {
        this.clearHistory();
      });

    // ── prune ────────────────────────────────────────────────────────────
    command
      .command('prune')
      .description('Remove conversations older than the retention period')
      .option('-d, --days <number>', 'Retention period in days', parseInt, 30)
      .action((options?: { days?: number }) => {
        this.pruneHistory(options?.days || 30);
      });

    // Default: show recent conversations
    command.action(() => {
      this.listHistory(15);
    });

    return command;
  }

  private listHistory(limit: number): void {
    const history = getChatHistory();
    const sessions = history.getAllSessions(limit);

    if (sessions.length === 0) {
      logger.info('No conversation history found.');
      return;
    }

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  📝  Conversation History (${history.count()} total)`);
    logger.highlight(`${'═'.repeat(60)}`);

    console.log('');
    for (const session of sessions) {
      console.log(history.formatSessionSummary(session));
    }
    console.log(`\n  Show a conversation: buff history show <session-id>`);
    console.log('');
  }

  private searchHistory(query: string, limit: number): void {
    const history = getChatHistory();
    const results = history.search(query, limit);

    if (results.length === 0) {
      logger.info(`No conversations found matching "${query}".`);
      return;
    }

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  🔍  Search Results: "${query}" (${results.length} found)`);
    logger.highlight(`${'═'.repeat(60)}`);

    console.log('');
    for (const session of results) {
      console.log(history.formatSessionSummary(session));
    }
    console.log('');
  }

  private showSession(id: string): void {
    const history = getChatHistory();

    // Support partial ID matching
    const sessions = history.getAllSessions(100);
    const match = sessions.find(
      (s) => s.id === id || s.id.startsWith(id) || s.id.includes(id),
    );

    if (!match) {
      logger.error(`Session not found: ${id}`);
      logger.info('Use `buff history list` to see available sessions.');
      return;
    }

    const date = new Date(match.startedAt).toLocaleString();
    const tags = match.tags.length > 0 ? ` [${match.tags.join(', ')}]` : '';

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  💬  Conversation: ${match.summary.slice(0, 50)}`);
    logger.highlight(`${'═'.repeat(60)}`);
    console.log(`  Provider: ${match.provider}  |  Model: ${match.model}  |  Date: ${date}${tags}`);
    console.log(`  ${match.messages.length} messages`);
    console.log('');

    // Show messages (truncate long outputs)
    for (const msg of match.messages) {
      const prefix = msg.role === 'user' ? '👤 You:' : '🤖 AI:';
      const content = msg.content.length > 500
        ? msg.content.slice(0, 500) + '...\n  (truncated, use buff history show <id> to see full)'
        : msg.content;
      console.log(`  ${prefix}`);
      console.log(`  ${content}`);
      console.log('');
    }

    logger.highlight(`${'═'.repeat(60)}`);
    console.log('');
  }

  private clearHistory(): void {
    getChatHistory().clear();
    logger.success('Conversation history cleared.');
  }

  private pruneHistory(days: number): void {
    const history = getChatHistory();
    const removed = history.prune(days);
    logger.success(`Removed ${removed} old conversation(s) older than ${days} days.`);
  }
}
