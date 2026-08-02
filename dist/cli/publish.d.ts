/**
 * Publish command — Autonomous publish workflow with credential management.
 *
 * Chains the full release pipeline:
 *   1. Test verification (optional)
 *   2. Version bump + changelog
 *   3. Git commit + tag + push
 *   4. npm build + publish
 *   5. GitHub release
 *
 * Credentials are collected interactively or from environment variables.
 * Each step is a phase with progress tracking and error recovery.
 *
 * Usage:
 *   buff publish                    — Interactive: choose bump type, collect creds, execute
 *   buff publish --patch            — Non-interactive: patch bump, auto-detect credentials
 *   buff publish --minor            — Minor version bump
 *   buff publish --major            — Major version bump
 *   buff publish --dry-run          — Preview what would happen
 *   buff publish --skip-tests       — Skip test phase
 *   buff publish --provider groq    — Use specific provider for LLM agents
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class PublishCommand extends BaseCommand {
    create(): Command;
    private publishRelease;
}
//# sourceMappingURL=publish.d.ts.map