/**
 * Feedback command — Record, view, and manage user feedback on agent outputs.
 *
 * Usage:
 *   buff feedback record <trajectory-id>  — Rate a trajectory (👍/👎)
 *   buff feedback list                     — Show recent feedback entries
 *   buff feedback stats                    — Show aggregated feedback statistics
 *   buff feedback clear                    — Clear all feedback data
 *
 * Feedback helps the self-improvement system learn which outputs are
 * useful and tune provider/model routing accordingly.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import { getFeedbackStore, type Rating, type FeedbackEntry, type FeedbackStats } from '../learning/feedback.js';
import { logger } from '../utils/logger.js';

export class FeedbackCommand extends BaseCommand {
  create(): Command {
    const command = new Command('feedback')
      .description('Record, view, and manage user feedback on agent outputs');

    // ── record ───────────────────────────────────────────────────────────
    command
      .command('record')
      .description('Record feedback for a trajectory (interactive)')
      .argument('[trajectory-id]', 'Trajectory ID to provide feedback on')
      .option('--positive', 'Mark as positive feedback')
      .option('--negative', 'Mark as negative feedback')
      .option('--neutral', 'Mark as neutral feedback')
      .option('-c, --comment <text>', 'Optional comment')
      .action(async (trajectoryId?: string, options?: {
        positive?: boolean;
        negative?: boolean;
        neutral?: boolean;
        comment?: string;
      }) => {
        await this.recordFeedback(trajectoryId, options || {});
      });

    // ── list ─────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('Show recent feedback entries')
      .option('-n, --limit <count>', 'Number of entries to show', parseInt, 10)
      .option('--trajectory <id>', 'Filter by trajectory ID')
      .action(async (options?: { limit?: number; trajectory?: string }) => {
        await this.listFeedback(options || {});
      });

    // ── stats ────────────────────────────────────────────────────────────
    command
      .command('stats')
      .description('Show aggregated feedback statistics')
      .action(async () => {
        await this.showStats();
      });

    // ── clear ────────────────────────────────────────────────────────────
    command
      .command('clear')
      .description('Clear all feedback data')
      .action(async () => {
        await this.clearFeedback();
      });

    return command;
  }

  private async recordFeedback(
    trajectoryId: string | undefined,
    options: {
      positive?: boolean;
      negative?: boolean;
      neutral?: boolean;
      comment?: string;
    },
  ): Promise<void> {
    const store = getFeedbackStore();

    // Resolve trajectory ID
    const id = trajectoryId || `trajectory-${Date.now()}`;

    // Resolve rating from CLI flags or interactive prompt
    let rating: Rating;

    if (options.positive) {
      rating = 'positive';
    } else if (options.negative) {
      rating = 'negative';
    } else if (options.neutral) {
      rating = 'neutral';
    } else {
      // Interactive rating prompt
      console.log('');
      logger.info(`Rating trajectory: ${id}`);
      console.log('');

      const answer = await inquirer.prompt<{ rating: string }>([
        {
          type: 'list',
          name: 'rating',
          message: 'How was the output?',
          prefix: '⭐',
          choices: [
            { name: '👍  Positive — Great result, would use again', value: 'positive' },
            { name: '😐  Neutral — Acceptable but not great', value: 'neutral' },
            { name: '👎  Negative — Not useful', value: 'negative' },
            { name: '⏭️  Skip', value: 'skip' },
          ],
        },
      ]);

      rating = answer.rating as Rating;
    }

    if (rating === 'skip') {
      logger.info('Feedback skipped.');
      return;
    }

    // Record the feedback
    const entry = store.record(id, rating, {
      goal: 'cli-feedback',
      provider: 'unknown',
      model: 'unknown',
      comment: options.comment,
    });

    logger.success(`Feedback recorded: ${rating} (${entry.id})`);

    // Show score impact
    const delta = store.ratingToScoreDelta(rating);
    if (delta !== 0) {
      const sign = delta > 0 ? '+' : '';
      logger.info(`   Score impact: ${sign}${delta.toFixed(1)} for trajectory '${id}'`);
    }

    console.log('');
  }

  private async listFeedback(options: { limit?: number; trajectory?: string }): Promise<void> {
    const store = getFeedbackStore();
    let entries: FeedbackEntry[];

    if (options.trajectory) {
      entries = store.getByTrajectory(options.trajectory);
      if (entries.length === 0) {
        logger.info(`No feedback found for trajectory '${options.trajectory}'.`);
        return;
      }
    } else {
      entries = store.getAll();
      if (entries.length === 0) {
        logger.info('No feedback recorded yet. Use `buff feedback record` to add some.');
        return;
      }
    }

    // Sort most recent first, apply limit
    const sorted = entries
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, options.limit || 10);

    const modeLabel = options.trajectory ? ` for '${options.trajectory}'` : '';
    logger.highlight(`⭐ Feedback Entries${modeLabel} (${sorted.length} shown)`);
    console.log('');

    for (const entry of sorted) {
      const ratingIcon = entry.rating === 'positive' ? '👍' :
                         entry.rating === 'negative' ? '👎' :
                         entry.rating === 'neutral' ? '😐' : '⏭️';
      const date = new Date(entry.createdAt).toLocaleString();
      const commentStr = entry.comment ? ` — "${entry.comment.slice(0, 80)}"` : '';

      console.log(`  ${ratingIcon}  ${entry.trajectoryId.slice(0, 40).padEnd(42)} ${date}`);
      console.log(`     Goal: ${entry.goal.slice(0, 60)} | Provider: ${entry.provider}/${entry.model}${commentStr}`);
      console.log('');
    }

    logger.info(`Total entries: ${entries.length}`);
    console.log('');
  }

  private async showStats(): Promise<void> {
    const store = getFeedbackStore();
    const stats = store.getStats();

    logger.highlight('⭐ Feedback Statistics');
    console.log('');

    if (stats.totalRatings === 0) {
      logger.info('No feedback recorded yet. Use `buff feedback record <trajectory-id>` to add some.');
      console.log('');
      return;
    }

    console.log(`  Total ratings: ${stats.totalRatings}`);
    console.log('');

    // Visual bar for positive/negative ratio
    const barWidth = 30;
    const posBars = Math.round(stats.positiveRatio * barWidth);
    const negBars = Math.round(stats.negativeRatio * barWidth);
    const neuBars = barWidth - posBars - negBars;

    const posBar = '🟢'.repeat(Math.max(0, posBars));
    const negBar = '🔴'.repeat(Math.max(0, negBars));
    const neuBar = '⚪'.repeat(Math.max(0, neuBars));
    console.log(`  ${posBar}${negBar}${neuBar}`);
    console.log('');

    console.log(`  👍 Positive:  ${(stats.positiveRatio * 100).toFixed(1)}%`);
    console.log(`  👎 Negative:  ${(stats.negativeRatio * 100).toFixed(1)}%`);
    console.log(`  😐 Neutral:   ${(stats.neutralRatio * 100).toFixed(1)}%`);
    console.log('');

    // Trend
    const trendIcon = stats.recentTrend === 'improving' ? '📈' :
                      stats.recentTrend === 'declining' ? '📉' : '📊';
    console.log(`  ${trendIcon} Recent trend: ${stats.recentTrend}`);
    console.log('');
  }

  private async clearFeedback(): Promise<void> {
    const store = getFeedbackStore();

    const answer = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to clear all feedback data?',
        default: false,
        prefix: '⚠️',
      },
    ]);

    if (!answer.confirm) {
      logger.info('Clear cancelled.');
      return;
    }

    store.clear();
    logger.success('All feedback data cleared.');
  }
}
