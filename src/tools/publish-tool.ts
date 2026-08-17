/**
 * E3c — Publish workflow as a TOOL (`src/tools/publish-tool.ts`).
 *
 * The model-decides vocabulary: a chat turn can run the SAME publish pipeline
 * as `buff publish` by calling the `publish` tool — no mode selection, no
 * command the user must type. The CLI command (src/cli/publish.ts) and this
 * tool share `buildPublishPhases` (one phase list, zero divergence).
 *
 * Tool semantics (credentialed, irreversible action):
 * - NON-INTERACTIVE: credentials come from the environment / detected config
 *   ONLY (the CLI's interactive collectAll prompts never run inside a tool
 *   call — the model asks the user for tokens via `ask_user` instead).
 * - Missing credentials are reported back as a tool result so the model can
 *   ask for them and retry.
 * - `dry_run: true` previews the phases without touching anything.
 * - Returns a summary text fed back to the model (never throws).
 */

import { CredentialStore } from '../agents/credential-store.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { buildPublishPhases } from '../cli/publish.js';
import { logger } from '../utils/logger.js';
import type { ToolContext } from './registry.js';

/** P5a — post-publish release-sync (website/docs kept at release level). */
function currentPackageVersion(): string {
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const raw = readFileSync(require('node:path').join(process.cwd(), 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

/**
 * Run the publish workflow as a tool — returns model-feedable text.
 * The input schema lives in the registry (single source, never hand-kept) —
 * loaded lazily here so registry.ts stays import-light (STANDING RULE).
 */
export async function runPublishTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { publishToolSchema } = await import('./registry.js');
  const { goal, bump, dry_run, skip_tests } = publishToolSchema.parse(args);
  const publishGoal = goal?.trim() || `Publish ${bump} release`;

  // Auto-detect credentials from env/config — NEVER the interactive
  // collectAll() prompts (a tool call must not block on a TTY).
  const credStore = new CredentialStore();

  if (!dry_run && !credStore.canPush && !credStore.canPublish) {
    return [
      '❌ No publishing credentials detected (no git credentials and no npm token).',
      '   Ask the user for the missing tokens via ask_user, then retry:',
      '   - GITHUB_TOKEN (or an SSH key configured for git) to push + create the GitHub release',
      '   - NPM_TOKEN to publish to the npm registry',
    ].join('\n');
  }

  if (!dry_run) {
    // Set up the detected credentials for the session (best-effort — the CLI
    // does the same before running phases).
    try {
      credStore.setupGitCredentials();
      credStore.setupNpmAuth();
    } catch (err) {
      logger.warn(`  ⚠️  Credential setup issue: ${err}`);
    }
  }

  const phases = buildPublishPhases(bump, skip_tests, {
    git: credStore.git,
    npm: credStore.npm,
  });

  if (dry_run) {
    return [
      `📋 Publish DRY RUN — "${publishGoal}" (${bump} bump)`,
      ...phases.map((p) => `   ▶ ${p.description}: ${p.goal.slice(0, 80)}`),
      '   (no changes were made)',
    ].join('\n');
  }

  const orchestrator = new Orchestrator(ctx.configManager);
  const lines: string[] = [];
  let hasFailure = false;
  // P5a — capture the PRE-publish version so a post-publish sync check can
  // diff the release markers against what was actually bumped.
  const versionBeforePublish = currentPackageVersion();

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    lines.push(`📦 ${i + 1}/${phases.length}: ${phase.description}`);
    try {
      const result = await orchestrator.execute(phase.goal, {
        verbose: false,
        skipTests: skip_tests,
      });
      if (result.success) {
        lines.push(`   ✅ ${result.summary ? result.summary.slice(0, 120) : 'completed'}`);
      } else {
        hasFailure = true;
        lines.push(`   ❌ ${result.error ? result.error.slice(0, 200) : 'failed'}`);
      }
    } catch (err) {
      hasFailure = true;
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`   ❌ ${msg.slice(0, 200)}`);
      break;
    }
  }

  credStore.cleanup();

  // P5a — after a SUCCESSFUL publish, run the release-sync check (best-effort:
  // a sync failure must never mark the publish failed). The published version
  // is the bumped package.json version (phase 2 bumped it); the pre-publish
  // capture is kept for a future version-drift comparison.
  let syncLine: string | null = null;
  if (!hasFailure) {
    try {
      const { runReleaseSync } = await import('./release-sync.js');
      const published = currentPackageVersion() || versionBeforePublish;
      syncLine = runReleaseSync(published, ctx);
      if (versionBeforePublish) lines.push(`   ℹ️ Pre-publish version: v${versionBeforePublish}`);
    } catch {
      syncLine = null; // best-effort — never breaks the publish result
    }
  }

  return [
    hasFailure
      ? `⚠️  Publish "${publishGoal}" completed with issues (${phases.length} phases)`
      : `🎉 Publish "${publishGoal}" complete (${phases.length} phases)`,
    ...lines,
    ...(syncLine ? [syncLine] : []),
  ].join('\n');
}
