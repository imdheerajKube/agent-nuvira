/**
 * Team command — Team collaboration with shared memory, config, and review workflow.
 *
 * Usage:
 *   buff team init [name]                       — Initialize team config in working directory
 *   buff team init --repo <url>                 — Init with remote team repository
 *   buff team join <repo-url>                   — Clone and join an existing team repo
 *   buff team sync                              — Sync team memory with remote (pull + push)
 *   buff team status                            — Show team configuration and memory status
 *   buff team share                             — Share local trajectories with team
 *   buff team review list                       — List all review bundles
 *   buff team review show <id>                  — Show a specific review bundle
 *   buff team review approve <id>               — Approve a review
 *   buff team review reject <id> [reason]       — Reject a review
 *   buff team review merge <id>                 — Merge an approved review into working dir
 *   buff team review create <title> <goal>      — Create a review bundle from files
 *
 * The team system enables multiple developers to:
 *   - Share agent execution trajectories via git
 *   - Use project-level .buffconfig.json for shared provider defaults
 *   - Review agent-generated changes before applying them
 *   - Collaborate on workflow templates and coding patterns
 */

import { Command } from 'commander';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';

import {
  findProjectConfig,
  getTeamConfig,
  hasProjectConfig,
  getTeamDataDir,
} from '../team/config.js';

import {
  initTeamMemory,
  syncTeamMemory,
  shareTrajectories,
  getTeamMemoryStats,
} from '../team/memory.js';

import {
  getReview,
  listReviews,
  addReviewComment,
  mergeReview,
  rejectReview,
  createReview,
} from '../team/review.js';

import type { ReviewBundle, ReviewFileChange } from '../team/review.js';

export class TeamCommand extends BaseCommand {
  create(): Command {
    const command = new Command('team')
      .description('Team collaboration — shared config, git-synced memory, and review workflow');

    // ── init ───────────────────────────────────────────────────────────────
    const initCmd = new Command('init')
      .description('Initialize team configuration in the working directory')
      .argument('[name]', 'Team name (saved to .buffconfig.json)')
      .option('-r, --repo <url>', 'Remote repository URL for the team memory repo')
      .option('-b, --branch <branch>', 'Git branch to use (default: main)')
      .action(async (name?: string, options?: { repo?: string; branch?: string }) => {
        await this.handleInit(name, options || {});
      });
    command.addCommand(initCmd);

    // ── join ───────────────────────────────────────────────────────────────
    command
      .command('join <repo-url>')
      .description('Clone and join an existing team repository')
      .action(async (repoUrl: string) => {
        await this.handleJoin(repoUrl);
      });

    // ── sync ───────────────────────────────────────────────────────────────
    command
      .command('sync')
      .description('Sync team memory with remote (pull latest + push local changes)')
      .action(async () => {
        await this.handleSync();
      });

    // ── status ─────────────────────────────────────────────────────────────
    command
      .command('status')
      .description('Show team configuration and memory status')
      .action(async () => {
        await this.handleStatus();
      });

    // ── share ──────────────────────────────────────────────────────────────
    command
      .command('share')
      .description('Share local trajectories and patterns with the team')
      .action(async () => {
        await this.handleShare();
      });

    // ── review ─────────────────────────────────────────────────────────────
    const reviewCmd = new Command('review')
      .description('Manage review bundles — agent PR → review → merge workflow');

    reviewCmd
      .command('list')
      .description('List all review bundles')
      .option('-l, --limit <count>', 'Maximum number of reviews to show', parseInt)
      .action(async (options?: { limit?: number }) => {
        await this.handleReviewList(options || {});
      });

    reviewCmd
      .command('show <id>')
      .description('Show a specific review bundle with full details')
      .action(async (id: string) => {
        await this.handleReviewShow(id);
      });

    reviewCmd
      .command('approve <id>')
      .description('Approve a review bundle (sets status to approved)')
      .option('-m, --message <comment>', 'Optional approval comment')
      .action(async (id: string, options?: { message?: string }) => {
        await this.handleReviewApprove(id, options || {});
      });

    reviewCmd
      .command('request-changes <id>')
      .description('Request changes on a review bundle')
      .argument('<reason>', 'Reason for requesting changes')
      .action(async (id: string, reason: string) => {
        await this.handleReviewRequestChanges(id, reason);
      });

    reviewCmd
      .command('reject <id>')
      .description('Reject a review bundle')
      .argument('[reason]', 'Optional rejection reason')
      .action(async (id: string, reason?: string) => {
        await this.handleReviewReject(id, reason);
      });

    reviewCmd
      .command('merge <id>')
      .description('Merge an approved review into the working directory')
      .action(async (id: string) => {
        await this.handleReviewMerge(id);
      });

    reviewCmd
      .command('create <title> <goal>')
      .description('Create a review bundle from specified files')
      .option('-f, --files <paths>', 'Comma-separated file paths to include')
      .option('--provider <provider>', 'Provider used')
      .option('--model <model>', 'Model used')
      .action(async (title: string, goal: string, options?: { files?: string; provider?: string; model?: string }) => {
        await this.handleReviewCreate(title, goal, options || {});
      });

    command.addCommand(reviewCmd);

    // Default action: show status
    command.action(async () => {
      await this.handleStatus();
    });

    return command;
  }

  // ── init ─────────────────────────────────────────────────────────────────

  private async handleInit(
    name?: string,
    options?: { repo?: string; branch?: string },
  ): Promise<void> {
    const cwd = process.cwd();
    const configPath = join(cwd, '.buffconfig.json');

    if (existsSync(configPath) || hasProjectConfig(cwd)) {
      logger.warn('.buffconfig.json already exists in the working directory.');
      logger.info('Use `buff team join <url>` to clone a team repo, or edit .buffconfig.json directly.');
      return;
    }

    // Create a new .buffconfig.json with team settings
    const buffConfig: {
      defaultProvider: string;
      providers: Record<string, unknown>;
      team: {
        repository?: string;
        branch: string;
        autoSyncMinutes: number;
        shareTrajectories: boolean;
      };
    } = {
      defaultProvider: 'openrouter',
      providers: {},
      team: {
        repository: options?.repo,
        branch: options?.branch || 'main',
        autoSyncMinutes: 0,
        shareTrajectories: true,
      },
    };

    // If repo URL is provided, also initialize team memory
    if (options?.repo) {
      try {
        await initTeamMemory(options.repo, cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to initialize team memory: ${msg}`);
        return;
      }
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(buffConfig, null, 2), 'utf-8');
    logger.success(`Created .buffconfig.json${name ? ` for team "${name}"` : ''}`);
    logger.info('Edit this file to customize team settings.');
  }

  // ── join ─────────────────────────────────────────────────────────────────

  private async handleJoin(repoUrl: string): Promise<void> {
    const cwd = process.cwd();

    logger.info(`Joining team repository: ${repoUrl}`);
    try {
      await initTeamMemory(repoUrl, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to join team: ${msg}`);
      return;
    }

    // If no project config exists yet, create one
    if (!hasProjectConfig(cwd)) {
      const configPath = join(cwd, '.buffconfig.json');
      const config = {
        defaultProvider: 'openrouter',
        providers: {},
        team: {
          repository: repoUrl,
          branch: 'main',
          autoSyncMinutes: 0,
          shareTrajectories: true,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      logger.success(`Created .buffconfig.json with team repo reference`);
    }

    logger.success(`Successfully joined team! Run \`buff team sync\` to pull latest.`);
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  private async handleSync(): Promise<void> {
    logger.info('Syncing team memory...');

    const projectConfig = findProjectConfig();
    if (!projectConfig?.team?.repository) {
      logger.warn('No remote repository configured for this team.');
      logger.info('Set "team.repository" in .buffconfig.json or run `buff team join <url>`.');
      return;
    }

    try {
      const result = await syncTeamMemory();

      if (result.conflicts.length > 0) {
        logger.warn(`Sync completed with ${result.conflicts.length} conflict(s).`);
        for (const conflict of result.conflicts) {
          console.log(`  ⚠️  ${conflict.slice(0, 200)}`);
        }
        return;
      }

      if (result.errors.length > 0) {
        logger.warn(`Sync completed with ${result.errors.length} error(s).`);
        for (const err of result.errors) {
          console.log(`  ⚠️  ${err}`);
        }
        return;
      }

      logger.success('Team memory is up to date.');
      if (result.pulled > 0) logger.info(`  Pulled latest changes from remote.`);
      if (result.pushed > 0) logger.info(`  Pushed local changes to remote.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Sync failed: ${msg}`);
    }
  }

  // ── status ───────────────────────────────────────────────────────────────

  private async handleStatus(): Promise<void> {
    const cwd = process.cwd();

    logger.highlight('═'.repeat(60));
    logger.highlight('  👥  Team Status');
    logger.highlight('═'.repeat(60));

    // ── Config Status ────────────────────────────────────────────────────
    console.log('\n  ── Configuration ──');

    const projectConfig = findProjectConfig(cwd);
    if (projectConfig?.team) {
      console.log(`  📄  Project config: ${join(cwd, '.buffconfig.json')}`);
      console.log(`  Repo:   ${projectConfig.team.repository || '(not set)'}`);
      console.log(`  Branch: ${projectConfig.team.branch || 'main'}`);
      console.log(`  Auto-sync: ${projectConfig.team.autoSyncMinutes ? `every ${projectConfig.team.autoSyncMinutes}m` : 'disabled'}`);
      console.log(`  Share trajectories: ${projectConfig.team.shareTrajectories ? 'yes' : 'no'}`);
    } else {
      console.log('  ℹ️  No team configuration found. Run `buff team init` or `buff team join <url>`.');
    }

    // ── Memory Status ────────────────────────────────────────────────────
    console.log('\n  ── Team Memory ──');

    const teamDir = getTeamDataDir(cwd);
    console.log(`  📁  Directory: ${teamDir}`);

    try {
      const stats = getTeamMemoryStats(cwd);

      if (!stats.gitConfigured) {
        console.log('  ℹ️  Team memory not initialized.');
        console.log('     Run `buff team init --repo <url>` or `buff team join <url>`.');
      } else {
        console.log(`  Branch: ${stats.branch}`);
        console.log(`  Trajectories:  ${stats.trajectoryCount}`);
        console.log(`  Patterns:      ${stats.patternCount}`);
        console.log(`  Templates:     ${stats.templateCount}`);
        console.log(`  Uncommitted:   ${stats.uncommittedChanges} change(s)`);

        if (stats.lastSync) {
          console.log(`  Last commit:   ${stats.lastSync.slice(0, 25)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${msg}`);
    }

    // ── Recent Reviews ───────────────────────────────────────────────────
    console.log('\n  ── Recent Reviews ──');

    try {
      const reviews = listReviews(5);
      if (reviews.length === 0) {
        console.log('  No review bundles yet.');
      } else {
        for (const review of reviews) {
          const statusIcon = this.reviewStatusIcon(review.status);
          const date = new Date(review.createdAt).toLocaleDateString();
          console.log(`  ${statusIcon} ${review.id} — ${review.title.slice(0, 60)} (${date})`);
        }
      }
    } catch {
      console.log('  Could not load reviews.');
    }

    console.log('');
    logger.info('Run `buff team sync` to pull/push team memory.');
    console.log('');
  }

  // ── share ────────────────────────────────────────────────────────────────

  private async handleShare(): Promise<void> {
    const config = getTeamConfig();
    if (!config.shareTrajectories) {
      logger.warn('Sharing trajectories is disabled in team config.');
      logger.info('Set "team.shareTrajectories": true in .buffconfig.json to enable.');
      return;
    }

    try {
      const shared = await shareTrajectories();
      if (shared > 0) {
        logger.info('Run `buff team sync` to publish shared files to the team remote.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to share trajectories: ${msg}`);
    }
  }

  // ── review ───────────────────────────────────────────────────────────────

  private async handleReviewList(options?: { limit?: number }): Promise<void> {
    const limit = options?.limit || 20;
    const reviews = listReviews(limit);

    if (reviews.length === 0) {
      logger.info('No review bundles found.');
      return;
    }

    logger.highlight('═'.repeat(60));
    logger.highlight(`  📋  Review Bundles (showing ${Math.min(limit, reviews.length)} of ${reviews.length})`);
    logger.highlight('═'.repeat(60));

    for (const review of reviews) {
      const statusIcon = this.reviewStatusIcon(review.status);
      const date = new Date(review.createdAt).toLocaleDateString();
      console.log(`\n  ${statusIcon} ${review.id}`);
      console.log(`     Title:     ${review.title}`);
      console.log(`     Author:    ${review.author}`);
      console.log(`     Status:    ${review.status}`);
      console.log(`     Date:      ${date}`);
      console.log(`     Changes:   ${review.changes.length} file(s)`);
    }
    console.log('');
  }

  private async handleReviewShow(id: string): Promise<void> {
    const bundle = getReview(id);
    if (!bundle) {
      logger.error(`Review not found: ${id}`);
      return;
    }

    logger.highlight('═'.repeat(60));
    logger.highlight(`  📋  Review: ${bundle.id}`);
    logger.highlight('═'.repeat(60));

    console.log(`\n  Title:    ${bundle.title}`);
    console.log(`  Status:   ${this.reviewStatusIcon(bundle.status)} ${bundle.status}`);
    console.log(`  Author:   ${bundle.author}`);
    console.log(`  Goal:     ${bundle.goal.slice(0, 120)}`);
    console.log(`  Provider: ${bundle.provider} / ${bundle.model}`);
    console.log(`  Created:  ${new Date(bundle.createdAt).toLocaleString()}`);
    console.log(`  Tags:     ${bundle.tags.join(', ') || '(none)'}`);

    // File changes
    console.log('\n  ── File Changes ──');
    for (const change of bundle.changes) {
      const icon = change.status === 'created' ? '🆕' : change.status === 'modified' ? '📝' : '🗑️';
      console.log(`  ${icon} ${change.path} (${change.status})`);
    }

    // Comments
    if (bundle.comments.length > 0) {
      console.log('\n  ── Comments ──');
      for (const comment of bundle.comments) {
        const icon = comment.status === 'approve' ? '✅' : comment.status === 'request-changes' ? '🔧' : '💬';
        const date = new Date(comment.timestamp).toLocaleString();
        console.log(`\n  ${icon} ${comment.reviewer} (${date}):`);
        console.log(`     ${comment.comment}`);
      }
    }

    // Summary
    if (bundle.summary) {
      console.log('\n  ── Summary ──');
      console.log(`  ${bundle.summary.slice(0, 500)}`);
    }

    console.log('');
    logger.info(`Run \`buff team review <approve|reject|merge> ${id}\` to act on this review.`);
    console.log('');
  }

  private async handleReviewApprove(
    id: string,
    options?: { message?: string },
  ): Promise<void> {
    const bundle = getReview(id);
    if (!bundle) {
      logger.error(`Review not found: ${id}`);
      return;
    }

    const reviewer = process.env.USER || 'unknown';
    const result = addReviewComment(id, reviewer, 'approve', options?.message || 'Approved.');

    if (result) {
      logger.success(`Review ${id} approved.`);
      logger.info(`Run \`buff team review merge ${id}\` to apply the changes.`);
    }
  }

  private async handleReviewRequestChanges(id: string, reason: string): Promise<void> {
    const bundle = getReview(id);
    if (!bundle) {
      logger.error(`Review not found: ${id}`);
      return;
    }

    const reviewer = process.env.USER || 'unknown';
    const result = addReviewComment(id, reviewer, 'request-changes', reason);

    if (result) {
      logger.info(`Changes requested on review ${id}: "${reason}"`);
    }
  }

  private async handleReviewReject(id: string, reason?: string): Promise<void> {
    const success = rejectReview(id, reason);
    if (success) {
      const suffix = reason ? ` — Reason: "${reason}"` : '';
      logger.info(`Review ${id} rejected.${suffix}`);
    }
  }

  private async handleReviewMerge(id: string): Promise<void> {
    const count = mergeReview(id);
    if (count > 0) {
      logger.success(`Merged ${count} file change(s) from review ${id}.`);
      logger.info('Run `buff team review list` to see updated status.');
    }
  }

  private async handleReviewCreate(
    title: string,
    goal: string,
    options?: { files?: string; provider?: string; model?: string },
  ): Promise<void> {
    const cwd = process.cwd();

    // Parse file paths from option
    const filePaths = options?.files
      ? options.files.split(',').map((f) => f.trim()).filter(Boolean)
      : [];

    if (filePaths.length === 0) {
      logger.error('No files specified. Use --files "file1.ts,file2.ts" to include files.');
      return;
    }

    const changes: ReviewFileChange[] = [];

    for (const filePath of filePaths) {
      const fullPath = resolve(cwd, filePath);

      if (!existsSync(fullPath)) {
        logger.warn(`File not found: ${filePath} — skipping`);
        continue;
      }

      const content = readFileSync(fullPath, 'utf-8');
      changes.push({
        path: filePath,
        newContent: content,
        status: 'modified',
      });
    }

    if (changes.length === 0) {
      logger.error('No valid files to include in the review bundle.');
      return;
    }

    const bundle = createReview(title, goal, changes, {
      provider: options?.provider || 'unknown',
      model: options?.model || 'unknown',
      author: process.env.USER || 'unknown',
      tags: ['manual'],
    });

    if (bundle) {
      logger.success(`Created review bundle ${bundle.id} with ${changes.length} file(s).`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private reviewStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return '⏳';
      case 'approved': return '✅';
      case 'changes-requested': return '🔧';
      case 'merged': return '📦';
      case 'rejected': return '❌';
      default: return '❓';
    }
  }
}
