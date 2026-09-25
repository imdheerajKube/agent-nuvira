/**
 * E3c — Publish workflow as a TOOL (`src/tools/publish-tool.ts`).
 *
 * The model-decides vocabulary: a chat turn can run the SAME publish pipeline
 * as `nuvira publish` by calling the `publish` tool — no mode selection, no
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CredentialStore } from '../agents/credential-store.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { buildPublishPhases } from '../cli/publish.js';
import { maskSecret } from '../enterprise/secrets.js';
import { logger } from '../utils/logger.js';
import type { ToolContext } from './registry.js';

/**
 * One masked line naming the credentials the release will ACTUALLY use.
 *
 * The failure this exists to prevent: a release ran its whole pipeline and
 * reported "complete" while holding no credentials at all, so every push and
 * publish silently no-opped. Saying which token is in play (masked — never the
 * value) makes that state visible in the tool result the model reads back.
 */
function describeReleaseCredentials(store: CredentialStore): string {
  const gitToken = store.git?.token;
  const sshKey = store.git?.sshKeyPath;
  const npmToken = store.npm?.token;
  const parts = [
    gitToken ? `git ✓ (${maskSecret(gitToken)})` : sshKey ? 'git ✓ (ssh key)' : 'git ✗',
    npmToken ? `npm ✓ (${maskSecret(npmToken)})` : 'npm ✗',
  ];
  return `🔑 Credentials: ${parts.join('   ')}`;
}

/** P5a — post-publish release-sync (website/docs kept at release level). */
function currentPackageVersion(): string {
  try {
    // Static ESM imports — the previous inline `require('node:fs')` threw
    // `require is not defined` in the published build, and because this sits in
    // a try/catch the version silently read as '' rather than failing loudly.
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf-8');
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
    // NON-INTERACTIVE init FIRST. `setupGitCredentials()` / `setupNpmAuth()`
    // both refuse to run until the store is collected, and this tool never
    // prompts — so before `initialize()` existed these two calls threw on
    // every tool-driven release AND a single shared try/catch hid the pair.
    // The pipeline then ran with no credentials while reporting success.
    credStore.initialize();
    // Separate catches: a failure to set up git auth must not swallow the npm
    // one (and vice versa) — that is exactly how the pair went missing before.
    try {
      credStore.setupGitCredentials();
    } catch (err) {
      logger.warn(`  ⚠️  Git credential setup issue: ${err}`);
    }
    try {
      credStore.setupNpmAuth();
    } catch (err) {
      logger.warn(`  ⚠️  npm credential setup issue: ${err}`);
    }
  }

  const phases = buildPublishPhases(bump, skip_tests, {
    git: credStore.git,
    npm: credStore.npm,
  });

  // ── PREFLIGHT before anything irreversible ───────────────────────────────
  // The same checks the CLI runs, for the same reason: a tool-driven release is
  // MORE likely to be unattended, so starting one that cannot finish is worse
  // here than at a terminal. Non-interactive by construction — a definitive
  // blocker is reported back to the model, which can fix it or ask the user;
  // "unanswerable" (offline) warns and proceeds.
  if (!dry_run) {
    const { runReleasePreflight, formatPreflight } = await import('../agents/release-preflight.js');
    const { bumpVersionString, readVersion } = await import('../agents/release-runner.js');
    const current = readVersion();
    const targetVersion = current ? bumpVersionString(current, bump) : '';
    const needsModel = phases.some((p) => !p.runner);
    const preflight = await runReleasePreflight({ targetVersion, needsModel });
    if (preflight.blocked) {
      return [
        formatPreflight(preflight),
        '',
        '❌ The release was NOT started: the checks above are definitive, so nothing was committed, tagged or published.',
        '   Fix the blocker (or bump to a free version) and call this tool again.',
      ].join('\n');
    }
  }

  if (dry_run) {
    return [
      `📋 Publish DRY RUN — "${publishGoal}" (${bump} bump)`,
      ...phases.map((p) => `   ▶ ${p.description}: ${p.goal.slice(0, 80)}`),
      '   (no changes were made)',
    ].join('\n');
  }

  const orchestrator = new Orchestrator(ctx.configManager);
  const lines: string[] = [
    // State the credentials up front, so the model (and the user reading the
    // transcript) can see a release that is about to no-op for want of a token
    // BEFORE it reports itself complete.
    describeReleaseCredentials(credStore),
  ];
  let hasFailure = false;
  // P5a — capture the PRE-publish version so a post-publish sync check can
  // diff the release markers against what was actually bumped.
  const versionBeforePublish = currentPackageVersion();

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    lines.push(`📦 ${i + 1}/${phases.length}: ${phase.description}`);
    try {
      // A phase with a runner is a mechanical step with a known-correct
      // outcome (bump, tag, push, publish) and runs deterministically; only a
      // phase without one needs the orchestrator to plan it.
      const result = phase.runner
        ? await phase.runner()
        : await orchestrator.execute(phase.goal, {
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
