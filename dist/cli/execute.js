/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Single-shot mode:
 *   buff execute "add JWT authentication to the Express app"
 *   buff execute "create a CLI tool" --provider gemini --dry-run
 *   buff execute "add tests" --verbose --memory
 *   buff execute "fix bug" --memory --memory-stats
 *   buff execute "run tests" --sandbox
 *
 * Interactive development mode (no goal argument):
 *   buff execute
 *     → Model picker (if no --model flag)
 *     → Interactive loop: goal → orchestrator → results → next goal
 *     → Type /exit to quit
 */
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { BaseCommand } from './commands.js';
import { ProviderFactory } from '../inference/factory.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { applyActiveModel } from './model.js';
import { showModelPicker } from './model-picker.js';
import { resolveProvider } from './router.js';
import { isAutoModel } from '../learning/auto-router.js';
import { recordRegistryFailure } from '../learning/provider-fallback.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { listCheckpoints } from '../agents/checkpoint-store.js';
import { logger, setSilent } from '../utils/logger.js';
import { PipelineBoard, PipelineEventStream } from './pipeline-board.js';
/**
 * Map the CLI's `--checkpoint` / `--resume [id]` flags onto the orchestrator's
 * checkpoint options. Bare `--resume` (value `true`) means "resume the auto id
 * for this goal + cwd" → resumeCheckpointId undefined, resumeRequested true.
 * `--checkpoint` alone saves forward without resuming. Extracted as a pure
 * exported helper so the mapping is unit-testable without a full orchestration.
 */
export function checkpointOptions(checkpoint, resume) {
    return {
        checkpoint: checkpoint === true || !!resume,
        resumeCheckpointId: resume === true ? undefined : resume || undefined,
        resumeRequested: !!resume,
    };
}
// ─── Pure Helpers ───────────────────────────────────────────────────────────
/**
 * Parse multi-line goal input into a single goal string.
 *
 * Used by readGoal() which collects lines from readline; extracted as a
 * pure function so it can be unit-tested without mocking stdin/stdout.
 *
 * @param lines       Lines collected from user input
 * @returns           The joined goal string (blank lines collapsed)
 */
export function parseGoalLines(lines) {
    if (lines.length === 0)
        return '';
    return lines.join('\n');
}
// ─── ExecuteCommand ─────────────────────────────────────────────────────────
/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export class ExecuteCommand extends BaseCommand {
    create() {
        const command = new Command('execute')
            .description('Run a multi-agent pipeline to accomplish a goal')
            .argument('[goal]', 'The goal to accomplish (omit for interactive development mode)')
            .option('-p, --provider <provider>', 'Inference provider for all agents')
            .option('-m, --model <model>', 'Model override for all agents')
            .option('--planner-model <model>', 'Model for the Planner agent')
            .option('--gatherer-model <model>', 'Model for the Context Gatherer agent')
            .option('--writer-model <model>', 'Model for the Writer agent')
            .option('--reviewer-model <model>', 'Model for the Reviewer agent')
            .option('--dry-run', 'Preview changes without writing to disk', false)
            .option('-v, --verbose', 'Show detailed agent output', false)
            .option('--memory', 'Enable persistent memory (learn from past sessions)', false)
            .option('--memory-stats', 'Show memory statistics and exit', false)
            .option('--memory-clear', 'Clear all stored memory trajectories', false)
            .option('--context-limit <tokens>', 'Max context tokens before pruning (default: 128000). Set higher for Gemini (1000000)', parseInt)
            .option('--context-prune <mode>', 'Pruning aggressiveness: soft | medium | aggressive (default: soft)')
            .option('--review', 'Create a review bundle capturing proposed changes (view with `buff team review show <id>`)', false)
            .option('--sandbox', 'Execute runner commands and tests inside a Docker sandbox', false)
            .option('--skip-tests', 'Skip tester and debugger steps (code generation only)', false)
            .option('--auto-branch', 'Enable branch automation hooks (install, commit, PR update, file watch)', false)
            .option('--max-repairs <number>', 'Max auto-repair attempts per failed task (default: 3, 0 = disabled)', parseInt)
            .option('--repair-mode <mode>', 'Repair mode: auto | prompt | off (default: auto)')
            .option('--repair-fallback-models <models>', 'Comma-separated fallback models for repair (e.g., groq/llama3,nim/mistral)')
            .option('--auto-route', 'Route each agent to the best provider/model automatically (Auto model)', false)
            .option('--checkpoint', 'Save a resume-able checkpoint after every task batch (in ~/.buff/memory/checkpoints/)', false)
            .option('--resume [id]', 'Resume a saved checkpoint (defaults to the auto id for this goal + cwd). Completed steps are skipped', false)
            .option('--checkpoint-list', 'List saved checkpoints and exit', false)
            .option('--json-events', 'Emit machine-readable NDJSON pipeline events on stdout (no human board)', false)
            .action(async (goal, options) => {
            await this.execute(goal, options || {});
        });
        return command;
    }
    async execute(goal, options) {
        // ── Handle memory management commands ─────────────────────────────────
        if (options.memoryStats) {
            await this.showMemoryStats();
            return;
        }
        if (options.memoryClear) {
            await this.clearMemory();
            return;
        }
        // ── List saved checkpoints ───────────────────────────────────────────
        if (options.checkpointList) {
            this.showCheckpointList();
            return;
        }
        // ── Apply active model from `buff model switch` as defaults ────────────
        const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });
        let mergedProvider = activeOpts.provider;
        let mergedModel = activeOpts.model;
        // ── If no goal provided, enter interactive development mode ────────────
        if (!goal) {
            await this.runInteractiveDevMode(mergedProvider, mergedModel, options);
            return;
        }
        if (options.skipTests) {
            logger.info('   🧪 Tests skipped (--skip-tests flag set)');
        }
        // ── Single-shot execution (goal was provided on command line) ──────────
        await this.runSingleGoal(goal, mergedProvider, mergedModel, options);
    }
    // ─── Interactive Development Mode ─────────────────────────────────────────
    /**
     * Interactive development mode — model picker → goal prompt → orchestrator → loop until exit.
     */
    async runInteractiveDevMode(provider, model, options) {
        // ── Pick a model if not already specified ──────────────────────────────
        let activeProvider = provider;
        let activeModel = model;
        if (!activeModel) {
            logger.highlight('\n🎯  Welcome to Development Mode!');
            logger.info("   First, let's pick a model to work with.\n");
            const picked = await showModelPicker(this.configManager);
            if (!picked) {
                logger.info('\nNo model selected. Exiting development mode.\n');
                return;
            }
            if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                // Auto picked — keep the auto provider so the orchestrator routes
                // per task instead of resolveProvider('auto') falling back silently.
                activeProvider = 'auto';
                activeModel = 'auto';
            }
            else {
                if (picked.provider !== activeProvider) {
                    const resolved = resolveProvider(this.configManager, picked.provider);
                    activeProvider = resolved.type;
                }
                activeModel = picked.model;
            }
        }
        // ── SIGINT handler for graceful exit ───────────────────────────────────
        const sigintHandler = () => {
            console.log('\n');
            process.exit(0);
        };
        process.on('SIGINT', sigintHandler);
        // ── Welcome banner ────────────────────────────────────────────────────
        console.log('');
        logger.highlight('═'.repeat(60));
        logger.highlight('  🚀  Development Mode');
        logger.highlight('═'.repeat(60));
        console.log(`\n  Model: ${activeModel}`);
        console.log('');
        logger.info('  Enter a goal for the AI to accomplish (or type /exit to quit).');
        logger.info('  Each goal runs the full multi-agent pipeline: Plan → Gather → Write → Review → Test.');
        console.log('');
        // ── Session tracking ──────────────────────────────────────────────────
        const sessionHistory = [];
        let lastFailedGoal = null;
        // ── Interactive loop ───────────────────────────────────────────────────
        while (true) {
            const goal = await this.readGoal();
            if (!goal)
                continue;
            if (goal.startsWith('/')) {
                const handled = await this.handleDevCommand(goal, {
                    activeModel,
                    activeProvider,
                    sessionHistory,
                    configManager: this.configManager,
                    lastFailedGoal,
                });
                if (handled.exit)
                    break;
                if (handled.newModel) {
                    const picked = await showModelPicker(this.configManager);
                    if (picked) {
                        if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                            activeProvider = 'auto';
                            activeModel = 'auto';
                        }
                        else {
                            if (picked.provider !== activeProvider) {
                                const resolved = resolveProvider(this.configManager, picked.provider);
                                activeProvider = resolved.type;
                            }
                            activeModel = picked.model;
                        }
                        logger.success(`\n✅ Switched to ${activeModel}`);
                        console.log('');
                    }
                }
                if (handled.restore) {
                    activeProvider = handled.restore.provider;
                    activeModel = handled.restore.model;
                    // Add restored history into the current session
                    for (const entry of handled.restore.history) {
                        sessionHistory.push(entry);
                    }
                    logger.success(`\n✅ Restored ${handled.restore.history.length} goal(s) from session`);
                    console.log('');
                }
                if (handled.fixGoal) {
                    // /fix: retry the last failed goal with failure context
                    logger.highlight('═'.repeat(60));
                    logger.highlight('  🔧  Retrying Last Failed Goal');
                    logger.highlight('═'.repeat(60));
                    console.log(`\n  Goal: ${handled.fixGoal.goal}`);
                    console.log(`  Applying failure context to guide the repair...`);
                    console.log('');
                    const fixResult = await this.runSingleGoal(handled.fixGoal.goal, activeProvider, activeModel, { ...options, verbose: true });
                    // Process the fix result through the shared post-execution handler
                    // (same as retry-fix does) so the user sees failure analysis / follow-ups
                    const fixPostExec = await this.handlePostExecution(handled.fixGoal.goal, fixResult, sessionHistory, lastFailedGoal, activeProvider, activeModel, options);
                    lastFailedGoal = fixPostExec.updatedLastFailed;
                    continue;
                }
                continue;
            }
            const result = await this.runSingleGoal(goal, activeProvider, activeModel, options);
            // ── Process the result through the shared post-execution handler ──
            const { action: nextAction, updatedLastFailed } = await this.handlePostExecution(goal, result, sessionHistory, lastFailedGoal, activeProvider, activeModel, options);
            lastFailedGoal = updatedLastFailed;
            // ── Dispatch the chosen action ────────────────────────────────────
            if (nextAction.type === 'exit') {
                break;
            }
            else if (nextAction.type === 'switch-model') {
                const picked = await showModelPicker(this.configManager);
                if (picked) {
                    if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                        activeProvider = 'auto';
                        activeModel = 'auto';
                    }
                    else {
                        if (picked.provider !== activeProvider) {
                            const resolved = resolveProvider(this.configManager, picked.provider);
                            activeProvider = resolved.type;
                        }
                        activeModel = picked.model;
                    }
                    logger.success(`✅ Switched to ${activeModel}\n`);
                }
            }
            else if (nextAction.type === 'history') {
                this.showSessionHistory(sessionHistory);
            }
            else if (nextAction.type === 'retry-fix' && lastFailedGoal) {
                // Auto-fix: retry the last failed goal with failure context
                logger.highlight('═'.repeat(60));
                logger.highlight('  🔧  Auto-fixing Last Failed Goal');
                logger.highlight('═'.repeat(60));
                console.log(`\n  Goal: ${lastFailedGoal.goal}`);
                console.log(`  Applying failure context to guide the repair...`);
                console.log('');
                const fixResult = await this.runSingleGoal(lastFailedGoal.goal, activeProvider, activeModel, { ...options, verbose: true });
                // Process the fix result through the post-execution handler too
                const fixPostExec = await this.handlePostExecution(lastFailedGoal.goal, fixResult, sessionHistory, lastFailedGoal, activeProvider, activeModel, options);
                lastFailedGoal = fixPostExec.updatedLastFailed;
            }
            else if (nextAction.type === 'followup') {
                // Execute a follow-up suggestion immediately
                logger.highlight('═'.repeat(60));
                logger.highlight('  💡  Executing Follow-up Goal');
                logger.highlight('═'.repeat(60));
                console.log(`\n  ${nextAction.goal}\n`);
                const followupGoal = nextAction.goal;
                const followupResult = await this.runSingleGoal(followupGoal, activeProvider, activeModel, options);
                // Track in session history (skip the "What next?" prompt — the user
                // already chose the followup, so auto-continue to the main goal loop)
                sessionHistory.push({
                    goal: followupGoal,
                    success: followupResult.success,
                    summary: followupResult.success
                        ? `Follow-up completed: ${followupGoal.slice(0, 80)}`
                        : `Follow-up failed: ${followupGoal.slice(0, 80)}`,
                    timestamp: Date.now(),
                });
                // Update lastFailedGoal tracking
                if (!followupResult.success && followupResult.orchestrationResult) {
                    lastFailedGoal = {
                        goal: followupGoal,
                        orchestrationResult: followupResult.orchestrationResult,
                    };
                }
                else if (followupResult.success) {
                    lastFailedGoal = null;
                }
                // Auto-continue to the main goal prompt
                // (runSingleGoal already prints the orchestration result)
                logger.success('\n💡  Follow-up complete. Enter your next goal below.\n');
            }
        }
        // Cleanup
        process.off('SIGINT', sigintHandler);
        logger.success('\nDevelopment mode ended. Happy coding! 🚀\n');
        process.exit(0);
    }
    /**
     * Display the session goal history.
     */
    showSessionHistory(history) {
        if (history.length === 0) {
            logger.info('No goals have been executed yet in this session.');
            return;
        }
        logger.highlight('═'.repeat(60));
        logger.highlight('  📜  Session History');
        logger.highlight('═'.repeat(60));
        console.log('');
        for (let i = 0; i < history.length; i++) {
            const entry = history[i];
            const icon = entry.success ? '✅' : '❌';
            const date = new Date(entry.timestamp).toLocaleTimeString();
            console.log(`  ${i + 1}. ${icon} [${date}] ${entry.goal.slice(0, 100)}`);
        }
        console.log('');
    }
    // ─── Goal Input ───────────────────────────────────────────────────────────
    /**
     * Prompt the user for a goal using readline (supports multi-line input).
     * Delegates to parseGoalLines() for the actual line-joining logic.
     */
    readGoal() {
        return new Promise((resolve) => {
            const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: '🎯  Goal > ',
                terminal: true,
            });
            const lines = [];
            let isFirstLine = true;
            // Handle SIGINT during input
            rl.on('SIGINT', () => {
                console.log('');
                lines.push('/exit');
                rl.close();
            });
            rl.on('line', (line) => {
                if (isFirstLine) {
                    isFirstLine = false;
                    if (line === '') {
                        rl.prompt();
                        isFirstLine = true;
                        return;
                    }
                    lines.push(line);
                    if (line.startsWith('/')) {
                        rl.close();
                        return;
                    }
                    rl.setPrompt('  ...  > ');
                    rl.prompt();
                }
                else {
                    if (line === '') {
                        rl.close();
                    }
                    else {
                        lines.push(line);
                        rl.prompt();
                    }
                }
            });
            rl.on('close', () => {
                resolve(parseGoalLines(lines));
            });
            rl.prompt();
        });
    }
    // ─── Dev Commands ─────────────────────────────────────────────────────────
    /**
     * Handle slash-commands in development mode.
     */
    async handleDevCommand(cmd, context) {
        const lower = cmd.toLowerCase().trim();
        const spaceIdx = lower.indexOf(' ');
        const baseCmd = spaceIdx > 0 ? lower.slice(0, spaceIdx) : lower;
        const arg = spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : '';
        switch (baseCmd) {
            case '/exit':
            case '/quit':
                console.log('Goodbye!');
                return { exit: true };
            case '/help': {
                const lines = [
                    'Commands:',
                    '  /exit, /quit           Exit development mode',
                    '  /model                 Switch to a different model',
                    '  /fix                   Retry the last failed goal with failure context',
                    '  /suggest [query]       Show similar past goals from memory',
                    '  /save <name>           Save current session for later resumption',
                    '  /resume <name>         Resume a saved session',
                    '  /history               Show goals executed in this session',
                    '  /help                  Show this help',
                    '',
                    'Enter any goal to run the AI pipeline.',
                    'Type on multiple lines, end with an empty line.',
                ];
                console.log('');
                for (const line of lines) {
                    console.log(`  ${line}`);
                }
                console.log('');
                return { exit: false };
            }
            case '/model':
                return { exit: false, newModel: true };
            case '/history': {
                if (context?.sessionHistory) {
                    this.showSessionHistory(context.sessionHistory);
                }
                else {
                    logger.info('No session history available.');
                }
                return { exit: false };
            }
            case '/fix': {
                if (context?.lastFailedGoal) {
                    logger.highlight('═'.repeat(60));
                    logger.highlight('  🔧  Retrying Last Failed Goal');
                    logger.highlight('═'.repeat(60));
                    console.log(`\n  Goal: ${context.lastFailedGoal.goal}`);
                    console.log(`  Failure: ${context.lastFailedGoal.orchestrationResult.error || 'Unknown error'}`);
                    console.log('');
                    logger.info('  Retrying with failure context to guide the repair...');
                    console.log('');
                    return { exit: false, fixGoal: context.lastFailedGoal };
                }
                else {
                    logger.info('No failed goal to fix. Run a goal that fails first.');
                    return { exit: false };
                }
            }
            case '/suggest': {
                await this.handleSuggest(arg, context);
                return { exit: false };
            }
            case '/save': {
                await this.handleSave(arg, context);
                return { exit: false };
            }
            case '/resume': {
                const loaded = await this.handleResume(arg);
                if (loaded) {
                    logger.success(`\n✅ Resumed session: ${arg}`);
                    console.log(`   Provider: ${loaded.provider}`);
                    console.log(`   Model: ${loaded.model}`);
                    console.log(`   Goals in session: ${loaded.history?.length || 0}`);
                    console.log('');
                    // Return restore data so the interactive loop can update its state
                    return {
                        exit: false,
                        restore: {
                            provider: loaded.provider || '',
                            model: loaded.model || '',
                            history: loaded.history || [],
                        },
                    };
                }
                return { exit: false };
            }
            default:
                logger.warn(`Unknown command: ${baseCmd}. Type /help`);
                return { exit: false };
        }
    }
    // ─── Session Save/Resume ──────────────────────────────────────────────────
    /**
     * Save the current development session to disk.
     */
    async handleSave(name, context) {
        if (!name) {
            logger.error('Usage: /save <session-name>');
            return;
        }
        if (!context) {
            logger.error('No session state to save.');
            return;
        }
        const sessionsDir = join(homedir(), '.buff', 'sessions');
        if (!existsSync(sessionsDir)) {
            mkdirSync(sessionsDir, { recursive: true });
        }
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeName) {
            logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
            return;
        }
        const sessionData = {
            name,
            provider: context.activeProvider,
            model: context.activeModel,
            history: context.sessionHistory,
            savedAt: Date.now(),
        };
        const filePath = join(sessionsDir, `${safeName}.json`);
        writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
        logger.success(`Session saved as "${name}"`);
        logger.info(`  Path: ${filePath}`);
        logger.info(`  Goals: ${context.sessionHistory.length}`);
        logger.info(`  Model: ${context.activeModel}`);
        console.log('');
        logger.info('Run /resume <name> to restore this session later.');
        console.log('');
    }
    /**
     * Resume a saved development session.
     */
    async handleResume(name) {
        if (!name) {
            logger.error('Usage: /resume <session-name>');
            return null;
        }
        const sessionsDir = join(homedir(), '.buff', 'sessions');
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeName) {
            logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
            return null;
        }
        const filePath = join(sessionsDir, `${safeName}.json`);
        if (!existsSync(filePath)) {
            logger.error(`Session "${name}" not found.`);
            logger.info(`  Available sessions in: ${sessionsDir}`);
            if (existsSync(sessionsDir)) {
                const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
                if (files.length > 0) {
                    console.log('');
                    logger.info('  Available sessions:');
                    for (const f of files) {
                        console.log(`    • ${f.replace('.json', '')}`);
                    }
                    console.log('');
                }
            }
            return null;
        }
        try {
            const raw = readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            const date = new Date(data.savedAt).toLocaleString();
            logger.highlight('═'.repeat(60));
            logger.highlight(`  📂  Session: ${name}`);
            logger.highlight('═'.repeat(60));
            console.log(`\n  Saved: ${date}`);
            console.log(`  Provider: ${data.provider || 'default'}`);
            console.log(`  Model: ${data.model || 'default'}`);
            if (data.history && data.history.length > 0) {
                console.log(`  Goals (${data.history.length}):`);
                for (const h of data.history) {
                    const icon = h.success ? '✅' : '❌';
                    console.log(`    ${icon} ${h.goal.slice(0, 100)}`);
                }
            }
            console.log('');
            return {
                provider: data.provider,
                model: data.model,
                history: data.history,
            };
        }
        catch (err) {
            logger.error(`Failed to load session: ${err}`);
            return null;
        }
    }
    // ─── Goal Suggestions ─────────────────────────────────────────────────────
    /**
     * Show suggestions from past trajectories (auto-completion via /suggest).
     */
    async handleSuggest(query, context) {
        const searchQuery = query || context?.sessionHistory?.[context.sessionHistory.length - 1]?.goal;
        if (!searchQuery) {
            logger.info('Usage: /suggest <goal description>');
            logger.info('  Shows similar past goals from memory to inspire your next task.');
            console.log('');
            logger.info('Examples:');
            logger.info('  /suggest authentication');
            logger.info('  /suggest add database');
            return;
        }
        logger.highlight('🔍  Searching memory for similar past goals...');
        console.log('');
        try {
            const store = getTrajectoryStore();
            const allTrajectories = store.getAll();
            if (allTrajectories.length === 0) {
                logger.info('No past trajectories found in memory.');
                logger.info('  Run goals with --memory enabled to build up a trajectory history.');
                return;
            }
            const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
            const scored = allTrajectories
                .map((t) => {
                const goalLower = t.goal.toLowerCase();
                const matchCount = queryWords.filter((w) => goalLower.includes(w)).length;
                return { trajectory: t, score: matchCount / Math.max(1, queryWords.length) };
            })
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);
            if (scored.length === 0) {
                logger.info(`No past goals found matching "${searchQuery}".`);
                logger.info('  Try running goals with --memory to build up a trajectory history.');
                return;
            }
            logger.success(`Found ${scored.length} similar past goal(s):`);
            console.log('');
            for (let i = 0; i < scored.length; i++) {
                const { trajectory, score } = scored[i];
                const pct = Math.round(score * 100);
                const date = new Date(trajectory.timestamp).toLocaleDateString();
                console.log(`  ${i + 1}. [${pct}% match] ${trajectory.goal.slice(0, 120)}`);
                console.log(`     📁 ${trajectory.projectFingerprint || 'N/A'}  |  ${date}  |  ${trajectory.tasksCompleted}/${trajectory.tasksTotal} tasks`);
                console.log('');
            }
        }
        catch (err) {
            logger.error(`Failed to search memory: ${err}`);
        }
    }
    // ─── Post-Execution Handler ───────────────────────────────────────────────
    /**
     * Shared handler for post-execution tasks:
     * 1. Track the goal in session history
     * 2. Update lastFailedGoal tracking (returns the updated value since params are passed by value)
     * 3. Generate dynamic choices (analysis + follow-ups)
     * 4. Prompt the user
     * 5. Return the parsed action + updated lastFailedGoal
     *
     * Called after EVERY goal execution (main, follow-up, retry-fix)
     * so that the interactive UX is consistent.
     */
    async handlePostExecution(goal, result, sessionHistory, currentLastFailed, activeProvider, activeModel, options) {
        // ── Track in session history ───────────────────────────────────────
        sessionHistory.push({
            goal,
            success: result.success,
            summary: result.success ? `Completed: ${goal.slice(0, 80)}` : `Failed: ${goal.slice(0, 80)}`,
            timestamp: Date.now(),
        });
        // ── Update lastFailedGoal tracking (returned to caller) ────────────
        let updatedLastFailed = currentLastFailed;
        if (!result.success && result.orchestrationResult) {
            updatedLastFailed = {
                goal,
                orchestrationResult: result.orchestrationResult,
            };
        }
        else if (result.success) {
            updatedLastFailed = null;
        }
        // ── Generate dynamic post-execution choices and prompt ─────────────
        console.log('');
        const actions = await this.generatePostExecutionActions(result, activeProvider, activeModel, options);
        const answer = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What next?',
                prefix: '🚀',
                choices: actions,
            },
        ]);
        console.log('');
        // ── Parse the answer into a structured action ──────────────────────
        let action;
        if (answer.action === 'exit') {
            action = { type: 'exit' };
        }
        else if (answer.action === 'switch-model') {
            action = { type: 'switch-model' };
        }
        else if (answer.action === 'history') {
            action = { type: 'history' };
        }
        else if (answer.action === 'retry-fix') {
            action = { type: 'retry-fix' };
        }
        else if (answer.action.startsWith('followup:')) {
            action = {
                type: 'followup',
                goal: answer.action.slice('followup:'.length),
            };
        }
        else {
            // Default: continue (enter another goal)
            action = { type: 'continue' };
        }
        return { action, updatedLastFailed };
    }
    // ─── Dynamic Post-Execution Actions ───────────────────────────────────────
    /**
     * Generate context-aware choices for the post-execution prompt.
     *
     * After a SUCCESS: shows LLM-generated follow-up suggestions
     * After a FAILURE: shows failure analysis and specific recovery options
     * Always includes: enter another goal, switch model, history, exit
     */
    async generatePostExecutionActions(result, activeProvider, activeModel, _options) {
        const actions = [];
        if (result.success && result.orchestrationResult) {
            // ── Success: Show follow-up suggestions ─────────────────────────
            const followups = await this.generateFollowUpSuggestions(result.orchestrationResult, activeProvider, activeModel);
            if (followups.length > 0) {
                // Show top 3 follow-up suggestions
                const shown = followups.slice(0, 3);
                for (const f of shown) {
                    const label = `💡  ${f.label}`;
                    actions.push({ name: label, value: `followup:${f.goal}` });
                }
                actions.push({ name: '───────────', value: 'separator' });
            }
            actions.push({ name: '💬  Enter another goal', value: 'continue' });
        }
        else {
            // ── Failure: Show analysis + recovery options ───────────────────
            if (result.orchestrationResult) {
                const analysis = this.analyzeFailure(result.orchestrationResult);
                this.showFailureAnalysis(analysis);
                // Add specific recovery actions based on failure analysis
                for (const recovery of analysis.recoveryActions) {
                    actions.push({ name: recovery.label, value: recovery.action });
                }
                actions.push({ name: '───────────', value: 'separator' });
            }
            else {
                // Orchestration threw an exception — we have no agent-level detail
                logger.highlight('═'.repeat(60));
                logger.highlight('  ❌  Execution Failed');
                logger.highlight('═'.repeat(60));
                console.log('');
                logger.error('  The pipeline threw an unexpected error before producing results.');
                console.log('');
                logger.info('  💡  Try:');
                logger.info('     • Checking your provider/model configuration');
                logger.info('     • Rephrasing the goal more simply');
                logger.info('     • Running with --verbose to see more details');
                console.log('');
            }
            actions.push({ name: '📝  Enter a new goal', value: 'continue' });
        }
        // ── Standard actions (always available) ─────────────────────────────
        actions.push({ name: '🔄  Switch provider/model', value: 'switch-model' });
        actions.push({ name: '📜  Show session history', value: 'history' });
        actions.push({ name: '🚪  Exit development mode', value: 'exit' });
        return actions;
    }
    /**
     * LLM-powered follow-up suggestion generator.
     *
     * Uses the current provider to generate contextually relevant next steps
     * based on what was just accomplished. Falls back to rule-based suggestions
     * if the LLM call fails.
     */
    async generateFollowUpSuggestions(result, activeProvider, activeModel) {
        // ── Rule-based fallback suggestions ─────────────────────────────────
        const fallbackSuggestions = () => {
            const goal = result.goal.toLowerCase();
            const fileChanges = (result.fileChanges || '').toLowerCase();
            const ranCommands = (result.runOutput || '').toLowerCase();
            const suggestions = [];
            // Detect what was accomplished and suggest next steps
            if (goal.includes('test') || goal.includes('testing')) {
                suggestions.push({
                    label: '🧪  Run the tests',
                    description: 'Run the tests to verify everything passes',
                    goal: `Run the test suite to verify everything works`,
                });
            }
            if (fileChanges.includes('.py') || fileChanges.includes('python')) {
                suggestions.push({
                    label: '🐍  Add Python type hints',
                    description: 'Add type annotations to the Python code',
                    goal: `Add type hints to the Python files to improve code quality`,
                });
            }
            if (fileChanges.includes('.ts') || fileChanges.includes('typescript') ||
                fileChanges.includes('.js') || fileChanges.includes('javascript')) {
                suggestions.push({
                    label: '📖  Add JSDoc/TSDoc comments',
                    description: 'Document the code with JSDoc or TSDoc comments',
                    goal: `Add documentation comments to the code`,
                });
                suggestions.push({
                    label: '🧪  Add unit tests',
                    description: 'Write unit tests for the new code',
                    goal: `Add comprehensive unit tests for the code that was just created`,
                });
            }
            if (fileChanges.includes('route') || fileChanges.includes('api') ||
                fileChanges.includes('endpoint') || fileChanges.includes('express')) {
                suggestions.push({
                    label: '🔒  Add input validation',
                    description: 'Validate API inputs and add error handling',
                    goal: `Add input validation and proper error handling to the API endpoints`,
                });
            }
            if (ranCommands.includes('error') || ranCommands.includes('fail')) {
                suggestions.push({
                    label: '🔧  Fix the execution errors',
                    description: 'Debug and fix the errors from the last run',
                    goal: `Fix the errors encountered during execution: ${result.runOutput?.slice(0, 200) || ''}`,
                });
            }
            // Generic suggestion based on project type
            if (result.agentResults.some((a) => a.agent === 'runner' && a.success)) {
                suggestions.push({
                    label: '🚀  Deploy the project',
                    description: 'Set up deployment configuration',
                    goal: `Add deployment configuration for this project`,
                });
            }
            // Limit to 3 suggestions
            return suggestions.slice(0, 3);
        };
        // ── Try LLM-powered suggestions ─────────────────────────────────────
        try {
            const config = this.configManager.getAll();
            const type = (activeProvider ||
                config.defaultProvider || 'groq');
            const { config: providerConfig } = this.configManager.getProviderConfig(type);
            const provider = ProviderFactory.createProvider(type, providerConfig);
            const model = activeModel || 'default';
            const prompt = [
                'Given the following goal execution result, suggest 2-3 short follow-up goals',
                'that build on what was just accomplished. Be specific and actionable.',
                '',
                '## Goal',
                result.goal,
                '',
                `## Status: ${result.success ? 'SUCCESS' : 'FAILURE'}`,
                '',
                '## Agent Results',
                ...result.agentResults.map((a) => `  ${a.agent}: ${a.success ? '✅' : '❌'} ${a.summary.slice(0, 120)}`),
                '',
                result.fileChanges && result.fileChanges !== 'No files changed.'
                    ? `## File Changes\n${result.fileChanges}`
                    : '',
                '',
                'Respond with ONLY a JSON array of objects, each with keys:',
                '  - "label": A short action label (max 40 chars)',
                '  - "description": A brief description (max 80 chars)',
                '  - "goal": The full follow-up goal text (max 200 chars)',
                '',
                'Example:',
                '[{"label":"Add error handling","description":"Handle edge cases and errors","goal":"Add comprehensive error handling to the API routes"}]',
                '',
                'Return ONLY the JSON array, no other text.',
            ].filter(Boolean).join('\n');
            const response = await provider.generate(prompt, {
                model,
                temperature: 0.3,
                maxTokens: 1024,
            });
            // Parse JSON response
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.slice(0, 3).map((s) => ({
                        label: s.label.replace(/^[\u{1F300}-\u{1F9FF}\s]*/u, '').trim() || s.label,
                        description: s.description,
                        goal: s.goal,
                    }));
                }
            }
        }
        catch (err) {
            // LLM failed — feed the SHARED registry telemetry path: this follow-up
            // generator is the ONLY execute-side LLM call that bypasses the
            // orchestrator, so without this a dead provider×model here was never
            // learned. Re-derived inside a guarded block (a throwing config read
            // must never break the rule-based fallback), and the literal 'auto'
            // provider is never written — it's a routing directive, not a real
            // provider×model.
            try {
                const fbType = (activeProvider || this.configManager.getAll().defaultProvider || 'groq');
                if (fbType !== 'auto') {
                    recordRegistryFailure(fbType, activeModel || 'default', err, undefined, 'execute');
                }
            }
            catch {
                // Telemetry must never break the fallback to rule-based suggestions.
            }
        }
        return fallbackSuggestions();
    }
    /**
     * Analyze a failed orchestration result to determine what went wrong
     * and suggest recovery actions.
     */
    analyzeFailure(result) {
        const failedAgents = result.agentResults
            .filter((a) => !a.success)
            .map((a) => ({ agent: a.agent, error: a.summary.slice(0, 200) }));
        const firstFailed = failedAgents[0];
        let failureType = 'other';
        let advice = '';
        const recoveryActions = [];
        if (!firstFailed) {
            // Pipeline error (not agent-level)
            failureType = 'other';
            advice = result.error || 'Unknown error occurred';
            recoveryActions.push({
                label: '📝  Retry with a clearer goal description',
                action: 'continue',
            });
        }
        else {
            const agentType = firstFailed.agent.toLowerCase();
            const error = firstFailed.error.toLowerCase();
            if (agentType === 'planner') {
                failureType = 'planner';
                advice = 'The Planner agent could not create a valid execution plan. ' +
                    'This often happens when the goal is too vague or the project context is unclear.';
                recoveryActions.push({
                    label: '📝  Rephrase the goal more specifically',
                    action: 'continue',
                });
                recoveryActions.push({
                    label: '🔄  Switch to a more capable model',
                    action: 'switch-model',
                });
            }
            else if (agentType === 'writer') {
                failureType = 'writer';
                advice = 'The Writer agent failed to generate the code. ' +
                    'This could be due to context limits, model quality, or an overly complex request.';
                recoveryActions.push({
                    label: '🔄  Switch to a more capable model and retry',
                    action: 'switch-model',
                });
                recoveryActions.push({
                    label: '📝  Simplify the goal and retry',
                    action: 'continue',
                });
            }
            else if (agentType === 'runner') {
                failureType = 'runner';
                advice = 'The Runner agent executed a command that failed. ' +
                    'This is usually a code or environment issue, not an AI issue.';
                if (error.includes('command not found') || error.includes('not found') || error.includes('no such')) {
                    advice += '\n  → The command or tool was not found. Check if the required dependency is installed.';
                }
                else if (error.includes('syntax') || error.includes('error')) {
                    advice += '\n  → The command produced an error. The generated code may have issues.';
                }
                recoveryActions.push({
                    label: '🔧  Fix the issue and rerun',
                    action: 'continue',
                });
                recoveryActions.push({
                    label: '🔄  Try with --skip-tests to bypass the runner',
                    action: 'continue',
                });
            }
            else if (agentType === 'tester') {
                failureType = 'tester';
                advice = 'The Tester agent ran tests that failed. ' +
                    'The generated code may have bugs or the test expectations may be wrong.';
                recoveryActions.push({
                    label: '🐛  Debug the failing tests',
                    action: 'continue',
                });
                recoveryActions.push({
                    label: '🔄  Retry with --skip-tests',
                    action: 'continue',
                });
            }
            else if (agentType === 'debugger') {
                failureType = 'debugger';
                advice = 'The Debugger agent attempted to fix issues but failed. ' +
                    'Try providing more specific guidance about what needs to be fixed.';
                recoveryActions.push({
                    label: '📝  Specify the exact error and retry',
                    action: 'continue',
                });
                recoveryActions.push({
                    label: '🔄  Switch model for better debugging',
                    action: 'switch-model',
                });
            }
            else if (agentType === 'reviewer' || agentType === 'context-gatherer') {
                failureType = agentType;
                advice = `The ${agentType} agent failed. This is unusual and may indicate` +
                    ' a provider or context issue.';
                recoveryActions.push({
                    label: '🔄  Retry with a different model',
                    action: 'switch-model',
                });
            }
            else {
                failureType = 'other';
                advice = `The ${firstFailed.agent} agent failed: ${firstFailed.error.slice(0, 200)}`;
                recoveryActions.push({
                    label: '📝  Retry with a clearer goal',
                    action: 'continue',
                });
            }
            // Add retry with failure context option for most failure types
            if (failureType !== 'planner' && failureType !== 'runner') {
                recoveryActions.push({
                    label: `🔧  Auto-fix: Retry "${result.goal.slice(0, 40)}${result.goal.length > 40 ? '...' : ''}"`,
                    action: 'retry-fix',
                });
            }
        }
        return {
            failedAgents,
            failureType: failureType,
            recoveryActions,
            advice,
        };
    }
    /**
     * Display a concise failure analysis to the user.
     */
    showFailureAnalysis(analysis) {
        logger.highlight('═'.repeat(60));
        logger.highlight('  ❌  Failure Analysis');
        logger.highlight('═'.repeat(60));
        console.log('');
        for (const fa of analysis.failedAgents) {
            const icon = fa.agent.toLowerCase() === 'planner' ? '📋' :
                fa.agent.toLowerCase() === 'writer' ? '✏️' :
                    fa.agent.toLowerCase() === 'runner' ? '▶️' :
                        fa.agent.toLowerCase() === 'tester' ? '🧪' :
                            fa.agent.toLowerCase() === 'debugger' ? '🐛' :
                                fa.agent.toLowerCase() === 'reviewer' ? '👁️' :
                                    fa.agent.toLowerCase() === 'context-gatherer' ? '📂' : '⚠️';
            console.log(`  ${icon}  ${fa.agent} failed:`);
            const wrapped = fa.error.length > 120 ? fa.error.slice(0, 120) + '...' : fa.error;
            console.log(`     ${wrapped}`);
            console.log('');
        }
        logger.info(`💡  ${analysis.advice}`);
        console.log('');
    }
    // ─── Single Goal Execution ────────────────────────────────────────────────
    /**
     * Run the orchestrator for a single goal and display results.
     * Returns the outcome so the caller can record it in session history.
     */
    async runSingleGoal(goal, provider, model, options) {
        if (!options.jsonEvents && (options.verbose || options.dryRun || options.review || options.sandbox)) {
            logger.info(`Goal: ${goal}`);
            if (options.dryRun)
                logger.info('Mode: Dry run (files will not be modified)');
            if (options.review)
                logger.info('Mode: Review (changes captured as review bundle)');
            if (options.sandbox)
                logger.info('Mode: Sandbox (commands run in Docker containers)');
            if (options.provider)
                logger.info(`Provider: ${options.provider} (from --provider flag)`);
            else if (provider)
                logger.info(`Provider: ${provider}`);
            if (options.model)
                logger.info(`Model: ${options.model} (from --model flag)`);
            else if (model)
                logger.info(`Model: ${model}`);
            if (options.memory)
                logger.info('Memory: Enabled');
            console.log('');
        }
        const agentModels = {};
        if (options.plannerModel)
            agentModels['planner'] = options.plannerModel;
        if (options.gathererModel)
            agentModels['context-gatherer'] = options.gathererModel;
        if (options.writerModel)
            agentModels['writer'] = options.writerModel;
        if (options.reviewerModel)
            agentModels['reviewer'] = options.reviewerModel;
        // Live pipeline board — every step, parallel lane, and agent "thinking"
        // update shown in real time (falls back to plain lines when not a TTY).
        // Also implements the spinner interface so rate-limit prompts pause it.
        // With --json-events, swap in the machine-readable NDJSON event stream so
        // external consumers (CI, scripts, the VS Code panel) get the same events.
        const board = options.jsonEvents ? new PipelineEventStream() : new PipelineBoard();
        board.start(goal);
        try {
            // Machine-readable mode: keep stdout a pure NDJSON stream. The event-bus
            // LoggerConsumer and incidental warn/info calls would otherwise interleave
            // human lines ("⚡ Pipeline started", inspection echoes, auto-routing
            // warnings) into the JSON stream — silence the logger for the duration and
            // let the NDJSON events carry all the detail. Set inside the try so the
            // finally below ALWAYS restores it, even on an early throw.
            if (options.jsonEvents)
                setSilent(true);
            const orchestrator = new Orchestrator(this.configManager);
            const result = await orchestrator.execute(goal, {
                provider,
                model,
                agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
                dryRun: options.dryRun,
                verbose: options.verbose,
                useDockerSandbox: options.sandbox,
                skipTests: options.skipTests,
                useMemory: options.memory,
                reviewMode: options.review,
                contextLimit: options.contextLimit,
                contextPruneMode: options.contextPrune,
                maxRepairs: options.maxRepairs,
                repairMode: options.repairMode,
                repairFallbackModels: options.repairFallbackModels?.split(',').map((m) => m.trim()).filter(Boolean),
                autoRouteModels: options.autoRoute || undefined,
                ...checkpointOptions(options.checkpoint, options.resume),
                spinner: board,
            });
            board.finish(result.success);
            if (options.jsonEvents) {
                // Machine-readable terminal event: the full orchestration result.
                process.stdout.write(JSON.stringify({
                    type: 'result',
                    success: result.success,
                    goal: result.goal,
                    summary: result.summary,
                    tasksCompleted: result.tasksCompleted,
                    tasksTotal: result.tasksTotal,
                    agentResults: result.agentResults,
                    fileChanges: result.fileChanges,
                    runOutput: result.runOutput,
                    error: result.error,
                    trajectoryId: result.trajectoryId,
                    reviewId: result.reviewId,
                    ts: Date.now(),
                }) + '\n');
            }
            else {
                console.log('');
                printOrchestrationResult(result);
            }
            return { success: result.success, orchestrationResult: result };
        }
        catch (err) {
            board.finish(false);
            if (options.jsonEvents) {
                process.stdout.write(JSON.stringify({
                    type: 'result',
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                    ts: Date.now(),
                }) + '\n');
            }
            else {
                logger.error(String(err));
            }
            return { success: false };
        }
        finally {
            if (options.jsonEvents)
                setSilent(false);
        }
    }
    // ─── Checkpoint Listing ────────────────────────────────────────────────
    /**
     * Show saved checkpoints (goal, completion, age) and how to resume them.
     */
    showCheckpointList() {
        const checkpoints = listCheckpoints();
        if (checkpoints.length === 0) {
            logger.highlight('📒 Checkpoints');
            console.log('');
            logger.info('  No checkpoints found.');
            logger.info('  Run a goal with --checkpoint to save a resume-able pipeline:');
            logger.info('    buff execute "my goal" --checkpoint');
            console.log('');
            return;
        }
        logger.highlight('📒 Checkpoints (resume with `buff execute "<goal>" --resume <id>`)');
        console.log('');
        for (const cp of checkpoints) {
            const date = new Date(cp.savedAt).toLocaleString();
            const pct = cp.tasksTotal > 0 ? Math.round((cp.tasksCompleted / cp.tasksTotal) * 100) : 0;
            console.log(`  • ${cp.id}`);
            console.log(`      Goal: ${cp.goal.slice(0, 90)}`);
            console.log(`      Progress: ${cp.tasksCompleted}/${cp.tasksTotal} steps (${pct}%) · Saved: ${date}`);
            console.log('');
        }
        console.log('');
    }
    // ─── Memory Management ─────────────────────────────────────────────────
    async showMemoryStats() {
        try {
            const { getMemoryStats } = await import('../memory/memory-integration.js');
            const stats = await getMemoryStats();
            logger.highlight(`${'═'.repeat(60)}`);
            logger.highlight(`  🧠  Memory Statistics`);
            logger.highlight(`${'═'.repeat(60)}`);
            console.log(`\n  Total trajectories: ${stats.total}`);
            console.log(`  Average quality score: ${stats.avgScore}`);
            if (Object.keys(stats.byProjectFingerprint).length > 0) {
                console.log(`\n  By project type:`);
                for (const [fp, count] of Object.entries(stats.byProjectFingerprint)) {
                    console.log(`    ${fp}: ${count}`);
                }
            }
            console.log('');
            logger.highlight(`${'═'.repeat(60)}`);
            console.log('');
        }
        catch (err) {
            logger.error(`Failed to read memory stats: ${err}`);
        }
    }
    async clearMemory() {
        try {
            const { clearMemory } = await import('../memory/memory-integration.js');
            await clearMemory();
            logger.success('Memory cleared successfully');
        }
        catch (err) {
            logger.error(`Failed to clear memory: ${err}`);
        }
    }
}
// ─── Pretty Printer ─────────────────────────────────────────────────────────
/**
 * Pretty-print the orchestration result to the console.
 */
export function printOrchestrationResult(result) {
    const statusIcon = result.success ? '✅' : '❌';
    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight(`  ${statusIcon}  Execution Result`);
    logger.highlight(`${'═'.repeat(60)}`);
    console.log(`\n  Goal: ${result.goal}`);
    console.log(`\n  ${result.summary}`);
    console.log(`  Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);
    if (result.trajectoryId) {
        console.log(`  Memory: Stored as ${result.trajectoryId}`);
    }
    if (result.agentResults.length > 0) {
        console.log(`\n  Agents:`);
        for (const ar of result.agentResults) {
            const icon = ar.success ? '✅' : '❌';
            const truncatedSummary = ar.summary.length > 120
                ? ar.summary.slice(0, 120) + '...'
                : ar.summary;
            console.log(`    ${icon} ${ar.agent}: ${truncatedSummary}`);
        }
    }
    if (result.fileChanges && result.fileChanges !== 'No files changed.') {
        console.log(`\n  File Changes:`);
        for (const line of result.fileChanges.split('\n')) {
            console.log(`    ${line}`);
        }
    }
    if (result.runOutput) {
        console.log(`\n  Command Output:`);
        for (const line of result.runOutput.split('\n')) {
            console.log(`    ${line}`);
        }
    }
    if (result.error) {
        console.log(`\n  Error: ${result.error}`);
    }
    console.log('');
    logger.highlight(`${'═'.repeat(60)}`);
    console.log('');
}
//# sourceMappingURL=execute.js.map