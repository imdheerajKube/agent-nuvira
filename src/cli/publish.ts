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
 *   nuvira publish                    — Interactive: choose bump type, collect creds, execute
 *   nuvira publish --patch            — Non-interactive: patch bump, auto-detect credentials
 *   nuvira publish --minor            — Minor version bump
 *   nuvira publish --major            — Major version bump
 *   nuvira publish --dry-run          — Preview what would happen
 *   nuvira publish --skip-tests       — Skip test phase
 *   nuvira publish --provider groq    — Use specific provider for LLM agents
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import {
  PhaseExecutionEngine,
  adoptSavedProgress,
  skipPhasesBefore,
  type PhaseDefinition,
} from '../agents/phase-engine.js';
import { CredentialStore, type PublishCredentials } from '../agents/credential-store.js';
import { createReleaseRunners, bumpVersionString, readVersion, type BumpType } from '../agents/release-runner.js';
import {
  probeProviderModel,
  reportPreflight,
  runReleasePreflight,
} from '../agents/release-preflight.js';
import { logger } from '../utils/logger.js';

/** Options the `publish` command accepts (commander's parsed shape). */
export interface PublishOptions {
  patch?: boolean;
  minor?: boolean;
  major?: boolean;
  dryRun?: boolean;
  skipTests?: boolean;
  /** `--no-preflight` sets this to false. */
  preflight?: boolean;
  force?: boolean;
  fresh?: boolean;
  from?: string;
  provider?: string;
  model?: string;
  verbose?: boolean;
}

/**
 * The publish pipeline's PHASE LIST — one shared source for the CLI command
 * AND the H1 `publish` tool (E3c model-decides vocabulary). Both entry points
 * build the exact same phases from the same credentials, so a chat-loop
 * publish can never diverge from `nuvira publish` (STANDING RULE).
 *
 * Every phase also carries its DETERMINISTIC runner (see release-runner.ts).
 * A release is mechanical — bump, changelog, commit, tag, push, publish — and
 * delegating those to the LLM orchestrator made them depend on plan quality and
 * provider health. The runner is attached HERE so both entry points run the
 * same implementation, not just the same phase names.
 */
export function buildPublishPhases(
  bumpType: string,
  skipTests: boolean,
  creds: PublishCredentials,
): PhaseDefinition[] {
  const phases: PhaseDefinition[] = [];
  const runners = createReleaseRunners(bumpType as BumpType);

  // Phase 1: Tests (optional)
  if (!skipTests) {
    phases.push({
      id: 'phase-1-tests',
      goal: 'Run the full test suite to verify the codebase is healthy',
      description: 'Test Verification',
    });
  }

  // Phase 2: Version bump + changelog
  phases.push({
    id: 'phase-2-version',
    goal: `Bump version (${bumpType}), update CHANGELOG.md with release notes`,
    description: `Version Bump (${bumpType})`,
  });

  // Phase 3: Git commit, tag, and push
  if (creds.git.token || creds.git.sshKeyPath) {
    phases.push({
      id: 'phase-3-git',
      goal: 'Commit version bump and changelog changes to git, create annotated tag, push commit and tag to remote',
      description: 'Git Commit, Tag & Push',
    });
  }

  // Phase 4: npm build + publish
  if (creds.npm.token) {
    phases.push({
      id: 'phase-4-npm',
      goal: `Full npm publish: build project, publish to npm registry (${bumpType} version)`,
      description: 'npm Build & Publish',
    });
  }

  // Phase 5: GitHub release
  if (creds.git.token || process.env.GITHUB_API_KEY || process.env.GH_TOKEN) {
    phases.push({
      id: 'phase-5-github',
      goal: 'Create GitHub release with auto-generated release notes from git log',
      description: 'GitHub Release',
    });
  }

  // One lookup, at the end, so a phase added above cannot be left without its
  // runner by accident while the two lists drift apart.
  for (const phase of phases) {
    const runner = runners[phase.id];
    if (runner) phase.runner = runner;
  }

  return phases;
}

export class PublishCommand extends BaseCommand {
  create(): Command {
    const command = new Command('publish')
      .description('Autonomous publish workflow — version, build, publish to npm & GitHub');

    command
      .argument('[goal]', 'Optional publish goal (e.g., "Release v1.2.0")')
      .option('--patch', 'Patch version bump (default)', false)
      .option('--minor', 'Minor version bump', false)
      .option('--major', 'Major version bump', false)
      .option('--dry-run', 'Preview changes without publishing', false)
      .option('--skip-tests', 'Skip test verification phase', false)
      .option('--no-preflight', 'Skip the pre-release checks (registry, tag, route)')
      .option('--force', 'Run even when the preflight finds a definitive blocker', false)
      .option('--fresh', 'Ignore an unfinished release and start a new one', false)
      .option('--from <phaseId>', 'Start at this phase id (continue a release)')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model override')
      .option('-v, --verbose', 'Show detailed agent output', false)
      .action(async (goal: string | undefined, options: PublishOptions) => {
        await this.publishRelease(goal, options);
      });

    return command;
  }

  private async publishRelease(goal: string | undefined, options: PublishOptions): Promise<void> {
    // ── Step 1: Determine bump type ─────────────────────────────────────
    let bumpType = 'patch';
    if (options.major) bumpType = 'major';
    else if (options.minor) bumpType = 'minor';
    else if (options.patch) bumpType = 'patch';

    if (!goal) {
      goal = `Publish ${bumpType} release`;
    }

    if (options.verbose) {
      logger.info(`Publish goal: ${goal}`);
      logger.info(`Bump type: ${bumpType}`);
      if (options.dryRun) logger.info('Mode: DRY RUN (no changes will be published)');
    }

    // ── Step 2: Check environment / collect credentials ─────────────────
    const credStore = new CredentialStore();
    const creds = await credStore.collectAll();

    if (!creds.git.token && !creds.git.sshKeyPath) {
      logger.warn('  ⚠️  No git credentials — git push will be skipped');
    }
    if (!creds.npm.token) {
      logger.warn('  ⚠️  No npm credentials — npm publish will be skipped');
    }

    // Set up credentials for the session
    try {
      credStore.setupGitCredentials();
      credStore.setupNpmAuth();
    } catch (err) {
      logger.warn(`  ⚠️  Credential setup issue: ${err}`);
    }

    // ── Step 3: Define the publish pipeline as phases (shared core — the
    // H1 `publish` tool builds the exact same list from the same creds) ──
    const phases = buildPublishPhases(bumpType, options.skipTests ?? false, creds);

    if (options.verbose) {
      logger.info(`\n  Publish pipeline: ${phases.length} phase(s)`);
      for (const p of phases) {
        logger.info(`    ▶ ${p.description}: ${p.goal.slice(0, 60)}`);
      }
    }

    // ── Step 3b: PREFLIGHT — the one cheap moment a release has ───────────
    // Everything the pipeline does after this is irreversible: a commit, a tag,
    // a push, a publish. The live 3.3.2 run bumped, committed, tagged and pushed
    // and only then found it could not publish (a stale version-pinned artifact
    // failed `prepublishOnly`'s test run). Check first instead.
    const currentVersion = readVersion();
    const targetVersion = currentVersion ? bumpVersionString(currentVersion, bumpType as BumpType) : '';

    if (options.preflight !== false) {
      // Only check the route when a phase will actually use one. Since the release
      // phases became deterministic that is normally zero phases, and reporting a
      // verified route nothing will call would be a decorative check.
      const needsModel = phases.some((p) => !p.runner);
      const preflight = await runReleasePreflight({
        targetVersion,
        needsModel,
        probeModel: needsModel
          ? () => probeProviderModel(this.configManager, options.provider, options.model)
          : undefined,
      });
      reportPreflight(preflight);
      if (preflight.blocked) {
        if (!options.force) {
          logger.error(
            `  ❌ Stopped before phase 1. ${targetVersion ? `Target: v${targetVersion}. ` : ''}` +
              'Nothing was committed, tagged or published. Fix the blocker, or pass --force to run anyway.',
          );
          return;
        }
        logger.warn('  ⚠️  --force: running despite a definitive preflight blocker');
      }
      console.log('');
    }

    // ── Step 4: Execute phases ───────────────────────────────────────────
    const engine = new PhaseExecutionEngine(credStore);

    // In dry-run mode, just show what would happen
    if (options.dryRun) {
      console.log('');
      logger.highlight(`${'═'.repeat(50)}`);
      logger.highlight('  📋  DRY RUN — Publish Pipeline Preview');
      logger.highlight(`${'═'.repeat(50)}`);
      console.log('');

      for (const phase of phases) {
        const icon = phase.description.includes('Test') ? '🧪' :
                     phase.description.includes('Version') ? '🔖' :
                     phase.description.includes('Git') ? '📡' :
                     phase.description.includes('npm') ? '📦' :
                     phase.description.includes('GitHub') ? '🐙' : '▶';
        console.log(`  ${icon} ${phase.description}`);
        console.log(`     ${phase.goal}`);
        console.log('');
      }

      logger.info(`  CLI would execute: nuvira execute "${phases.map(p => p.description).join(' → ')}"`);
      if (options.provider) logger.info(`  Provider: ${options.provider}`);
      if (options.model) logger.info(`  Model: ${options.model}`);
      console.log('');
      logger.success('  ✅ Dry-run complete — no changes were made');
      return;
    }

    // ── Step 4b: Resume, or start a new release ──────────────────────────
    // A release is a multi-step, partly-irreversible process that can be killed
    // halfway. The scope was always SAVED and never read, so a second run always
    // started over — which, after a successful version bump, means bumping twice
    // (3.3.2 → 3.3.3) on top of an unfinished release. The scope's `running`
    // status is what makes continuation possible: it is the mark a killed process
    // leaves behind, and it counts as incomplete.
    const scopeName = `Publish: ${goal}`;
    const scope = engine.createScope({
      name: scopeName,
      phases,
      targetVersion,
      options: {
        provider: options.provider,
        model: options.model,
        verbose: options.verbose,
        skipTests: options.skipTests,
        autoCredentials: false, // Already collected above
      },
    });

    const saved = options.fresh ? null : engine.loadScope(scopeName);
    const resumedFrom = adoptSavedProgress(scope, saved);
    if (resumedFrom > 0) {
      logger.info(
        `  ↻ Resuming the unfinished release v${scope.targetVersion}: ${resumedFrom} of ${scope.phases.length} ` +
          'phase(s) already done — the version will NOT be bumped again.',
      );
    } else if (saved && !saved.completed && saved.targetVersion && saved.targetVersion !== targetVersion) {
      logger.warn(
        `  ⚠️  An unfinished release v${saved.targetVersion} exists; this run targets v${targetVersion}. ` +
          'Use --fresh to acknowledge, or complete the other release first.',
      );
    }

    if (options.from) {
      const index = skipPhasesBefore(scope, options.from);
      if (index === -1) {
        logger.error(
          `  ❌ --from '${options.from}': no such phase. Known phases: ` +
            scope.phases.map((p) => `${p.id} (${p.description})`).join(' · '),
        );
        return;
      }
      logger.info(`  ⏭️  Starting at phase ${index + 1}/${scope.phases.length}: ${scope.phases[index].description}`);
    }

    console.log('');
    logger.highlight(`${'═'.repeat(50)}`);
    logger.highlight('  🚀  Starting Publish Pipeline');
    logger.highlight(`${'═'.repeat(50)}`);

    const orchestrator = new Orchestrator(this.configManager);

    // The runners cannot live on the scope (state is JSON-serialized for
    // resume), so they are looked up by phase id from the list above.
    const runners = new Map(
      phases.filter((p) => p.runner).map((p) => [p.id, p.runner!] as const),
    );

    let hasFailure = false;

    for (let i = 0; i < scope.phases.length; i++) {
      const phase = scope.phases[i];
      // Already done in the run being resumed — re-running the version bump
      // would create the next version instead of completing this one.
      if (phase.status === 'completed' || phase.status === 'skipped') {
        scope.currentPhaseIndex = i;
        continue;
      }
      phase.status = 'running';
      phase.startedAt = new Date().toISOString();

      console.log('');
      logger.highlight(`  📦 Phase ${i + 1}/${scope.phases.length}: ${phase.description}`);
      console.log('');

      const runner = runners.get(phase.id);
      const spinner = ora({
        text: `${runner ? 'Running' : 'Planning'}: ${phase.goal.slice(0, 60)}...`,
        spinner: 'dots',
      }).start();

      try {
        const result = runner
          ? await runner()
          : await orchestrator.execute(phase.goal, {
              provider: options.provider,
              model: options.model,
              verbose: options.verbose,
              dryRun: false,
              skipTests: options.skipTests,
            });

        spinner.stop();

        if (result.success) {
          phase.status = 'completed';
          phase.summary = result.summary;
          logger.success(`  ✅ ${phase.description} — completed`);
          console.log('');
          if (options.verbose && result.summary) {
            console.log(result.summary.slice(0, 500));
          }
        } else {
          phase.status = 'failed';
          phase.error = result.error;
          hasFailure = true;
          console.log('');
          logger.error(`  ❌ ${phase.description} — failed`);
          if (result.error) {
            logger.error(`     ${result.error.slice(0, 300)}`);
          }

          // Ask if user wants to continue. Only when there IS a user to ask:
          // `inquirer` throws ERR_USE_AFTER_CLOSE on a closed/non-TTY stdin,
          // which is how a scripted `nuvira publish --patch` died mid-pipeline
          // instead of reporting the failure it had just detected.
          if (i < scope.phases.length - 1 && !process.stdin.isTTY) {
            logger.error('  stdin is not a terminal — aborting rather than guessing. Fix the phase above and re-run.');
            break;
          }
          if (i < scope.phases.length - 1) {
            const { action } = await inquirer.prompt<{ action: string }>([
              {
                type: 'list',
                name: 'action',
                message: `Phase ${i + 1} failed. Continue with remaining phases?`,
                choices: [
                  { name: '✅ Skip failed phase and continue', value: 'continue' },
                  { name: '❌ Abort publish pipeline', value: 'abort' },
                ],
              },
            ]);
            if (action === 'abort') break;
            // Mark as skipped and continue
            phase.status = 'skipped';
          }
        }
      } catch (err) {
        spinner.fail(`Phase ${i + 1} errored`);
        const msg = err instanceof Error ? err.message : String(err);
        phase.status = 'failed';
        phase.error = msg;
        hasFailure = true;
        logger.error(`  ${msg.slice(0, 300)}`);
        break;
      }

      phase.completedAt = new Date().toISOString();
      scope.currentPhaseIndex = i;
      engine.saveScope(scope);
    }

    // ── Step 5: Show final summary ──────────────────────────────────────
    console.log('');
    logger.highlight(`${'═'.repeat(50)}`);
    logger.highlight(`  ${hasFailure ? '⚠️  ' : '🎉  '}Publish Pipeline ${hasFailure ? 'Completed with Issues' : 'Complete!'}`);
    logger.highlight(`${'═'.repeat(50)}`);
    console.log('');

    for (const phase of scope.phases) {
      const icon = phase.status === 'completed' ? '✅' :
                   phase.status === 'failed' ? '❌' :
                   phase.status === 'skipped' ? '⏭️' : '⏳';
      console.log(`  ${icon} ${phase.description}`);
      if (phase.summary) {
        console.log(`     ${phase.summary.slice(0, 100)}`);
      }
    }

    console.log('');
    if (hasFailure) {
      logger.info('  💡 Some phases failed. You can retry:');
      logger.info(`     nuvira publish --verbose`);
    } else {
      logger.success('  ✅ All phases completed successfully!');
    }

    // Clean up credentials
    credStore.cleanup();
  }
}
