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
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { PhaseExecutionEngine } from '../agents/phase-engine.js';
import { CredentialStore } from '../agents/credential-store.js';
import { logger } from '../utils/logger.js';
export class PublishCommand extends BaseCommand {
    create() {
        const command = new Command('publish')
            .description('Autonomous publish workflow — version, build, publish to npm & GitHub');
        command
            .argument('[goal]', 'Optional publish goal (e.g., "Release v1.2.0")')
            .option('--patch', 'Patch version bump (default)', false)
            .option('--minor', 'Minor version bump', false)
            .option('--major', 'Major version bump', false)
            .option('--dry-run', 'Preview changes without publishing', false)
            .option('--skip-tests', 'Skip test verification phase', false)
            .option('-p, --provider <provider>', 'Inference provider')
            .option('-m, --model <model>', 'Model override')
            .option('-v, --verbose', 'Show detailed agent output', false)
            .action(async (goal, options) => {
            await this.publishRelease(goal, options);
        });
        return command;
    }
    async publishRelease(goal, options) {
        // ── Step 1: Determine bump type ─────────────────────────────────────
        let bumpType = 'patch';
        if (options.major)
            bumpType = 'major';
        else if (options.minor)
            bumpType = 'minor';
        else if (options.patch)
            bumpType = 'patch';
        if (!goal) {
            goal = `Publish ${bumpType} release`;
        }
        if (options.verbose) {
            logger.info(`Publish goal: ${goal}`);
            logger.info(`Bump type: ${bumpType}`);
            if (options.dryRun)
                logger.info('Mode: DRY RUN (no changes will be published)');
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
        }
        catch (err) {
            logger.warn(`  ⚠️  Credential setup issue: ${err}`);
        }
        // ── Step 3: Define the publish pipeline as phases ───────────────────
        const phases = [];
        // Phase 1: Tests (optional)
        if (!options.skipTests) {
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
        if (options.verbose) {
            logger.info(`\n  Publish pipeline: ${phases.length} phase(s)`);
            for (const p of phases) {
                logger.info(`    ▶ ${p.description}: ${p.goal.slice(0, 60)}`);
            }
        }
        // ── Step 4: Execute phases via orchestrator ─────────────────────────
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
            logger.info(`  CLI would execute: buff execute "${phases.map(p => p.description).join(' → ')}"`);
            if (options.provider)
                logger.info(`  Provider: ${options.provider}`);
            if (options.model)
                logger.info(`  Model: ${options.model}`);
            console.log('');
            logger.success('  ✅ Dry-run complete — no changes were made');
            return;
        }
        // Execute each phase via the orchestrator
        const scope = engine.createScope({
            name: `Publish: ${goal}`,
            phases,
            options: {
                provider: options.provider,
                model: options.model,
                verbose: options.verbose,
                skipTests: options.skipTests,
                autoCredentials: false, // Already collected above
            },
        });
        console.log('');
        logger.highlight(`${'═'.repeat(50)}`);
        logger.highlight('  🚀  Starting Publish Pipeline');
        logger.highlight(`${'═'.repeat(50)}`);
        const orchestrator = new Orchestrator(this.configManager);
        let hasFailure = false;
        for (let i = 0; i < scope.phases.length; i++) {
            const phase = scope.phases[i];
            phase.status = 'running';
            phase.startedAt = new Date().toISOString();
            console.log('');
            logger.highlight(`  📦 Phase ${i + 1}/${scope.phases.length}: ${phase.description}`);
            console.log('');
            const spinner = ora({
                text: `Running: ${phase.goal.slice(0, 60)}...`,
                spinner: 'dots',
            }).start();
            try {
                const result = await orchestrator.execute(phase.goal, {
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
                }
                else {
                    phase.status = 'failed';
                    phase.error = result.error;
                    hasFailure = true;
                    console.log('');
                    logger.error(`  ❌ ${phase.description} — failed`);
                    if (result.error) {
                        logger.error(`     ${result.error.slice(0, 300)}`);
                    }
                    // Ask if user wants to continue
                    if (i < scope.phases.length - 1) {
                        const { action } = await inquirer.prompt([
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
                        if (action === 'abort')
                            break;
                        // Mark as skipped and continue
                        phase.status = 'skipped';
                    }
                }
            }
            catch (err) {
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
            logger.info(`     buff publish --verbose`);
        }
        else {
            logger.success('  ✅ All phases completed successfully!');
        }
        // Clean up credentials
        credStore.cleanup();
    }
}
//# sourceMappingURL=publish.js.map