/**
 * Orchestrator — The central coordinator of the multi-agent system.
 *
 * Responsibilities:
 * 1. Accept a user goal and optionally a provider/model config
 * 2. Create a ContextVault (shared context bus)
 * 3. Build the project file tree and inject it for the Planner
 * 4. Optionally retrieve memory context from past similar trajectories
 * 5. Run the PlannerAgent to produce an execution plan
 * 6. Execute tasks sequentially, respecting dependencies
 * 7. Spawn the appropriate agent for each task
 * 8. Apply file changes to disk
 * 9. Execute runner commands and capture output
 * 10. Optionally store the trajectory in memory
 * 11. Synthesize and return the final result
 *
 * Called by the `agent-nuvira execute` CLI command.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import inquirer from 'inquirer';
import { ProviderFactory } from '../inference/factory.js';
import { ConfigManager } from '../config/manager.js';
import { showModelPicker } from '../cli/model-picker.js';
import { logger } from '../utils/logger.js';
import { ContextVault } from './context-vault.js';
import { buildProjectFileTree, truncateTree } from './utils/file-tree.js';
import { PlannerAgent } from './agents/planner.js';
import { ContextGathererAgent } from './agents/context-gatherer.js';
import { WriterAgent } from './agents/writer.js';
import { ReviewerAgent } from './agents/reviewer.js';
import { RunnerAgent } from './agents/runner.js';
import { TesterAgent, cleanupSandbox } from './agents/tester.js';
import { DebuggerAgent } from './agents/debugger.js';
import { GitAgent } from './agents/git-agent.js';
import { PackageAgent } from './agents/package-agent.js';
import { GitHubReleaseAgent } from './agents/github-release-agent.js';
import { SecurityAgent } from './agents/security-agent.js';
import { SkillRunnerAgent } from './agents/skill-runner.js';
import { MCPAgent } from './agents/mcp-agent.js';
import { getMCPManager, resetMCPManager } from '../mcp/manager.js';
import { formatMcpToolsForPrompt } from './agents/mcp-agent.js';
import { ContextPruner } from '../learning/context-pruner.js';
import { ErrorRepairEngine } from '../learning/error-repair.js';
import { scanForInjections, formatScanReport } from '../security/scanner.js';
import { buildAgentModelMap } from '../learning/model-router.js';
import { createReviewFromResult } from '../team/review.js';
// ─── DAG Integration (optional — dashboard may not be built) ─────────────────
/**
 * Push a DAG update to the live dashboard, if the server is running.
 * Uses dynamic import so the orchestrator doesn't crash if the dashboard
 * module hasn't been built or isn't available.
 */
let dagModule = undefined;
async function ensureDAGModule() {
    if (dagModule !== undefined)
        return; // already attempted (null = failed, object = loaded)
    try {
        dagModule = await import('../web-dashboard/server.js');
    }
    catch {
        dagModule = null; // dashboard module not available — mark as failed
    }
}
async function tryPushDAG(update) {
    await ensureDAGModule();
    if (dagModule)
        dagModule.pushDAGUpdate(update);
}
async function tryUpdateDAGNode(nodeId, update) {
    await ensureDAGModule();
    if (dagModule)
        dagModule.updateDAGNode(nodeId, update);
}
async function tryResetDAG() {
    await ensureDAGModule();
    if (dagModule)
        dagModule.resetDAG();
}
// ─── Agent Registry ─────────────────────────────────────────────────────────
// ─── Spinner Icons ─────────────────────────────────────────────────────────
/** Icons for each agent type, shown in the spinner during execution */
const AGENT_ICONS = {
    'context-gatherer': '📂',
    'planner': '📋',
    'writer': '✏️',
    'reviewer': '👁️',
    'tester': '🧪',
    'debugger': '🐛',
    'runner': '▶️',
    'git': '🔀',
    'package': '📦',
    'github-release': '🏷️',
    'security': '🔒',
    'skill-runner': '🧠',
    'mcp': '🔌',
};
function createAgent(agentType, _options) {
    switch (agentType) {
        case 'context-gatherer':
            return new ContextGathererAgent();
        case 'planner':
            return new PlannerAgent();
        case 'writer':
            return new WriterAgent();
        case 'reviewer':
            return new ReviewerAgent();
        case 'runner':
            return new RunnerAgent();
        case 'tester':
            return new TesterAgent();
        case 'debugger':
            return new DebuggerAgent();
        case 'git':
            return new GitAgent();
        case 'package':
            return new PackageAgent();
        case 'github-release':
            return new GitHubReleaseAgent();
        case 'security':
            return new SecurityAgent();
        case 'skill-runner':
            return new SkillRunnerAgent();
        case 'mcp':
            return new MCPAgent();
        default:
            return null;
    }
}
// ─── Orchestrator ───────────────────────────────────────────────────────────
export class Orchestrator {
    configManager;
    constructor(configManager) {
        this.configManager = configManager ?? new ConfigManager();
    }
    /**
     * Execute a multi-agent pipeline for the given goal.
     */
    async execute(goal, options = {}) {
        const startTime = Date.now();
        const vault = new ContextVault(goal, process.cwd());
        const defaultCallLLM = this.createLLMProvider(options);
        const agentResults = [];
        const contextFiles = [];
        // ── 2b. Build project file tree and inject for Planner ────────────────
        if (options.verbose)
            logger.highlight('\n📂 Scanning project structure...');
        try {
            const fullTree = await buildProjectFileTree(process.cwd());
            // Truncate to 100 lines max to avoid blowing token limits
            const treeForPlanner = truncateTree(fullTree, 100);
            vault.setMeta('projectFileTree', treeForPlanner);
            if (options.verbose) {
                const fileCount = fullTree.split('\n').filter((l) => l.includes('📄')).length;
                logger.info(`   Found ${fileCount} source files in project`);
            }
        }
        catch (err) {
            logger.debug(`File tree build failed (non-critical): ${err}`);
            vault.setMeta('projectFileTree', '');
        }
        // ── 2c. Auto-connect MCP servers and inject tool descriptions ────────
        const enableMcp = options.enableMcp !== false; // default true
        if (enableMcp && options.verbose)
            logger.highlight('\n🔌 Discovering MCP servers...');
        if (enableMcp)
            try {
                const mcpManager = getMCPManager();
                const configs = mcpManager.discoverConfigs();
                if (configs.length > 0) {
                    if (options.verbose) {
                        logger.info(`   Found ${configs.length} MCP server config(s)`);
                    }
                    const connected = await mcpManager.connectAll();
                    if (connected.length > 0) {
                        const allTools = mcpManager.getAllTools();
                        const toolEntries = allTools.map((t) => ({
                            server: t.server,
                            tool: {
                                name: t.tool.name,
                                description: t.tool.description,
                                inputSchema: t.tool.inputSchema,
                            },
                        }));
                        // Store both the raw tool entries (for programmatic access)
                        vault.setMeta('mcpTools', toolEntries);
                        // And a formatted string (for LLM prompt injection)
                        const formattedTools = formatMcpToolsForPrompt(toolEntries);
                        vault.setMeta('mcpToolsFormatted', formattedTools);
                        if (options.verbose) {
                            logger.info(`   Connected to ${connected.length} MCP server(s) with ${allTools.length} tool(s)`);
                        }
                    }
                    else if (options.verbose) {
                        logger.info('   No MCP servers could be connected');
                    }
                }
                else if (options.verbose) {
                    logger.info('   No MCP server configs found (see ~/.buff/mcp/)');
                }
            }
            catch (err) {
                logger.debug(`MCP auto-connect failed (non-critical): ${err}`);
            }
        else if (options.verbose) {
            logger.info('   MCP disabled (enableMcp: false)');
        }
        // ── 3. Memory Retrieval ──────────────────────────────────────────────
        let memoryContext = '';
        if (options.useMemory) {
            if (options.verbose)
                logger.highlight('\n🔍 Searching memory for similar past tasks...');
            let patternContext = '';
            try {
                const { retrieveMemoryContext } = await import('../memory/memory-integration.js');
                const memoryResult = await retrieveMemoryContext(goal, defaultCallLLM, 3);
                memoryContext = memoryResult.fewShotContext;
                // Also inject coding patterns if available
                patternContext = memoryResult.patternContext || '';
                if (options.verbose) {
                    if (memoryResult.trajectories.length > 0) {
                        logger.info(`   Found ${memoryResult.trajectories.length} similar past trajectories`);
                    }
                    else {
                        logger.info('   No similar past tasks found in memory');
                    }
                }
            }
            catch (err) {
                logger.debug(`Memory retrieval failed: ${err}`);
            }
            // Inject memory context and patterns into vault for agents
            if (memoryContext) {
                vault.setMeta('memoryContext', memoryContext);
            }
            if (patternContext) {
                vault.setMeta('patternContext', patternContext);
                memoryContext += `\n${patternContext}`;
            }
        }
        // ── 2d. Log MCP tools availability ───────────────────────────────────
        const mcpToolCount = (vault.getMeta('mcpTools') || []).length;
        if (mcpToolCount > 0 && options.verbose) {
            logger.info(`   ${mcpToolCount} MCP tool(s) available via ${(vault.getMeta('mcpToolsFormatted') || '').includes('Server:') ? 'connected servers' : 'discovered configs'}`);
        }
        // ── 3b. Auto-route models ─────────────────────────────────────────────
        if (options.autoRouteModels && !options.agentModels) {
            const autoModels = buildAgentModelMap();
            options.agentModels = autoModels;
            if (options.verbose) {
                logger.info('   Auto-routing models based on task type');
            }
        }
        // ── 4. Planner (or pre-built plan from workflow template) ────────────
        if (options.prefillPlan && options.prefillPlan.length > 0) {
            for (const step of options.prefillPlan) {
                vault.context.taskPlan.push({ ...step });
            }
            agentResults.push({ agent: 'Planner', success: true, summary: `Using pre-built '${options.prefillPlan.length}-step' workflow plan` });
            if (options.verbose) {
                logger.highlight('\n📋 Using workflow template plan...');
                logger.info(`   Using ${options.prefillPlan.length} pre-defined steps`);
                for (const step of options.prefillPlan) {
                    logger.info(`      [${step.agentType}] ${step.description}`);
                }
            }
        }
        else {
            if (options.verbose)
                logger.highlight('\n📋 Planning...');
            const planResult = await this.runAgent(new PlannerAgent(), vault, defaultCallLLM, options);
            agentResults.push({ agent: 'Planner', success: planResult.success, summary: planResult.summary });
            if (!planResult.success) {
                return this.buildResult(false, goal, agentResults, vault, {
                    error: planResult.error || 'Planning failed',
                });
            }
            if (vault.context.taskPlan.length === 0) {
                return this.buildResult(false, goal, agentResults, vault, {
                    error: 'Planner did not produce a valid task plan',
                });
            }
            if (options.verbose) {
                logger.info(`   Created ${vault.context.taskPlan.length} task steps`);
                for (const step of vault.context.taskPlan) {
                    logger.info(`      [${step.agentType}] ${step.description}`);
                }
            }
            // Prune context after the Planner produces the plan
            this.pruneContext(vault, options);
        }
        // ── 4b. Push initial DAG state to dashboard ─────────────────────────
        if (vault.context.taskPlan.length > 0) {
            await tryResetDAG();
            const nodes = vault.context.taskPlan.map((step) => ({
                id: step.id,
                agentType: step.agentType,
                status: 'pending',
                description: step.description,
            }));
            const edges = [];
            for (const step of vault.context.taskPlan) {
                for (const dep of step.dependsOn) {
                    edges.push({ from: dep, to: step.id });
                }
            }
            await tryPushDAG({
                pipelineId: goal,
                pipelineDescription: goal.slice(0, 80),
                nodes,
                edges,
            });
        }
        // ── 5. Execute tasks ─────────────────────────────────────────────────
        if (options.verbose)
            logger.highlight('\n⚡ Executing tasks...');
        // Update spinner to show we've moved past planning into execution
        if (options.spinner && vault.context.taskPlan.length > 0) {
            const total = vault.context.taskPlan.length;
            options.spinner.start(`⚡ Executing ${total} task${total !== 1 ? 's' : ''}...`);
        }
        for (let iteration = 0; iteration < 50; iteration++) {
            if (vault.isComplete)
                break;
            const runnableTasks = vault.getRunnableTasks();
            // Prune context before executing the next batch of tasks
            this.pruneContext(vault, options);
            // Set Docker sandbox flag so RunnerAgent and TesterAgent know to use containers
            if (options.useDockerSandbox) {
                vault.setMeta('useDockerSandbox', true);
            }
            if (runnableTasks.length === 0 && !vault.isComplete) {
                const stuck = vault.context.taskPlan.filter((s) => s.status === 'pending');
                for (const s of stuck) {
                    const failedDep = vault.context.taskPlan.find((d) => s.dependsOn.includes(d.id) && d.status === 'failed');
                    const reason = failedDep
                        ? `Dependency failed: ${failedDep.id} (${failedDep.description.slice(0, 60)})`
                        : 'Deadlocked: dependencies could not be satisfied';
                    vault.updateTaskStatus(s.id, 'failed', reason);
                }
                break;
            }
            // Runner and sandbox agents need exclusive access (no parallel)
            const exclusiveAgentTypes = ['tester', 'debugger', 'runner'];
            const canParallel = runnableTasks.length > 1 &&
                !runnableTasks.some((t) => exclusiveAgentTypes.includes(t.agentType));
            if (canParallel) {
                for (const task of runnableTasks) {
                    vault.updateTaskStatus(task.id, 'running');
                }
                if (options.verbose) {
                    logger.info(`\n   ⚡ Running ${runnableTasks.length} tasks in parallel...`);
                }
                const taskPromises = runnableTasks.map((task) => this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM));
                await Promise.all(taskPromises);
            }
            else {
                for (const task of runnableTasks) {
                    await this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM);
                }
            }
        }
        // ── 6. Clean up sandbox if any ────────────────────────────────────────
        const sandboxPath = vault.getMeta('sandboxPath');
        if (sandboxPath) {
            try {
                cleanupSandbox(sandboxPath);
            }
            catch {
                // Best-effort cleanup
            }
        }
        // Clean up MCP server connections
        try {
            resetMCPManager();
        }
        catch {
            // Best-effort cleanup
        }
        // ── 6b. Review mode — create a review bundle instead of applying changes
        let reviewId;
        if (options.reviewMode && vault.context.fileChanges.filter(c => c.newContent || c.status === 'deleted').length > 0) {
            const fileChanges = vault.context.fileChanges.map((c) => ({
                path: c.path,
                originalContent: c.originalContent,
                newContent: c.newContent,
                status: c.status,
            }));
            // Build a summary from agent results
            const summaryLines = agentResults.map((r) => `${r.success ? '✅' : '❌'} ${r.agent}: ${r.summary.slice(0, 120)}`);
            summaryLines.push('');
            summaryLines.push(vault.getDiffSummary());
            const fullSummary = summaryLines.join('\n');
            const review = createReviewFromResult(goal, fileChanges, fullSummary, {
                provider: options.provider,
                model: options.model,
                author: process.env.USER || 'agent-nuvira',
            });
            reviewId = review.id;
            if (options.verbose) {
                logger.highlight(`\n📋 Created review bundle: ${review.id}`);
                logger.info(`   Run \`buff team review show ${review.id}\` to view`);
                logger.info(`   Run \`buff team review approve ${review.id}\` then \`buff team review merge ${review.id}\` to apply`);
            }
        }
        // ── 6c. Apply file changes ────────────────────────────────────────────
        if (!options.reviewMode && !options.dryRun) {
            const applied = this.applyFileChanges(vault);
            if (applied > 0 && options.verbose) {
                logger.success(`\n   💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`);
            }
        }
        else if (options.verbose && options.reviewMode) {
            logger.info('   📋 Review mode — changes saved as review bundle instead of written to disk');
        }
        // ── 6d. Collect runner output for display ────────────────────────────
        let runOutput;
        const runResult = vault.getMeta('runResult');
        if (runResult) {
            const lines = [];
            lines.push(`$ ${runResult.command}`);
            lines.push(`Exit code: ${runResult.exitCode} | Duration: ${runResult.duration}ms`);
            if (runResult.stdout) {
                lines.push('');
                lines.push(runResult.stdout.slice(0, 2000)); // Limit displayed output
                if (runResult.stdout.length > 2000) {
                    lines.push('... (output truncated)');
                }
            }
            if (runResult.stderr && runResult.exitCode !== 0) {
                lines.push('');
                lines.push('stderr:');
                lines.push(runResult.stderr.slice(0, 1000));
            }
            runOutput = lines.join('\n');
        }
        // ── 7. Store trajectory in memory + self-improvement loop ───────────
        let trajectoryId = '';
        if (options.useMemory) {
            try {
                const orchestrationSummary = {
                    success: !vault.hasFailedTasks,
                    goal,
                    summary: '',
                    tasksCompleted: vault.context.taskPlan.filter((s) => s.status === 'completed').length,
                    tasksTotal: vault.context.taskPlan.length,
                    agentResults,
                    fileChanges: vault.getDiffSummary(),
                };
                const { storeExecutionTrajectory } = await import('../memory/memory-integration.js');
                trajectoryId = await storeExecutionTrajectory(orchestrationSummary, defaultCallLLM, vault.context.taskPlan, contextFiles, options.verbose);
                // Self-improvement
                try {
                    const { getSelfImprover } = await import('../learning/self-improver.js');
                    const improver = getSelfImprover();
                    await improver.processRun({ ...orchestrationSummary, trajectoryId }, defaultCallLLM, options.agentModels, options.verbose);
                    if (options.verbose && trajectoryId) {
                        logger.info('   Self-improvement stats saved. Run `buff learn optimize` to see recommendations.');
                    }
                }
                catch (err) {
                    logger.debug(`Self-improvement loop failed: ${err}`);
                }
            }
            catch (err) {
                logger.debug(`Trajectory storage failed: ${err}`);
            }
        }
        // ── 8. Synthesize result ─────────────────────────────────────────────
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const completed = vault.context.taskPlan.filter((s) => s.status === 'completed').length;
        const total = vault.context.taskPlan.length;
        const hasFailures = vault.hasFailedTasks;
        const summaryLines = [];
        summaryLines.push(hasFailures
            ? `Completed ${completed}/${total} tasks with some failures in ${elapsed}s`
            : `Completed all ${completed} tasks successfully in ${elapsed}s`);
        summaryLines.push('');
        summaryLines.push('Changes:');
        summaryLines.push(vault.getDiffSummary());
        return this.buildResult(!hasFailures, goal, agentResults, vault, {
            summary: summaryLines.join('\n'),
            tasksCompleted: completed,
            tasksTotal: total,
            trajectoryId,
            reviewId,
            runOutput,
        });
    }
    // ─── Private Helpers ──────────────────────────────────────────────────
    createLLMProvider(options) {
        const providerType = (options.provider ||
            this.configManager.getAll().defaultProvider);
        const { config } = this.configManager.getProviderConfig(providerType);
        const provider = ProviderFactory.createProvider(providerType, config);
        return async (prompt, inferenceOptions) => {
            // Runtime injection guardrail
            const injectionFindings = scanForInjections(prompt);
            if (injectionFindings.length > 0) {
                const report = formatScanReport({
                    passed: false,
                    findings: injectionFindings,
                    summary: 'Prompt injection detected — call blocked',
                });
                throw new Error(`Injection guardrail blocked LLM call:\n${report}`);
            }
            const mergedOptions = {
                ...inferenceOptions,
                model: options.model || inferenceOptions?.model || config.model,
                temperature: inferenceOptions?.temperature ?? config.temperature ?? 0.7,
                maxTokens: inferenceOptions?.maxTokens ?? config.maxTokens ?? 4096,
            };
            return provider.generate(prompt, mergedOptions);
        };
    }
    async runAgent(agent, vault, callLLM, _options) {
        try {
            return await agent.execute(vault.context, callLLM);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, summary: `${agent.name} errored`, error: msg };
        }
    }
    /**
     * Create the onRateLimit callback that prompts the user.
     * Returns undefined if we're in non-interactive mode (no TTY or dry-run).
     */
    createRateLimitHandler(options, currentModel) {
        // Don't prompt in non-interactive or dry-run mode — just use auto-retry
        if (options.dryRun || !process.stdout.isTTY) {
            return undefined;
        }
        return async (info) => {
            // ── Stop the CLI spinner before showing interactive prompts ──────
            const spl = options.spinner;
            if (spl)
                spl.stop();
            const waitSeconds = (info.retryAfterMs / 1000).toFixed(1);
            const modelStr = info.modelName
                ? `Model: ${info.modelName}`
                : currentModel
                    ? `Model: ${currentModel}`
                    : '';
            console.log('');
            logger.warn(`\u26A0\uFE0F  Rate limit hit for ${info.agentName}`);
            logger.info(`   ${modelStr}`);
            logger.info(`   Please wait ${waitSeconds}s before next request`);
            console.log('');
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: `What would you like to do?`,
                    prefix: '\u{1F504}',
                    choices: [
                        { name: `\u23F3  Wait ${waitSeconds}s and retry`, value: 'retry' },
                        { name: '\u{1F500}  Switch to a different model', value: 'switch-model' },
                        { name: '\u23ED  Skip this step', value: 'skip' },
                        { name: '\u274C  Abort the pipeline', value: 'abort' },
                    ],
                },
            ]);
            console.log('');
            // Helper to restart the spinner before returning
            const restartSpinner = () => {
                if (spl)
                    spl.start();
            };
            if (action === 'retry') {
                logger.info(`Waiting ${waitSeconds}s as requested...`);
                restartSpinner();
                return { action: 'retry' };
            }
            if (action === 'skip') {
                logger.info('Skipping this step.');
                restartSpinner();
                return { action: 'skip' };
            }
            if (action === 'abort') {
                logger.error('Pipeline aborted by user.');
                // Don't restart spinner — pipeline is ending
                return { action: 'abort' };
            }
            if (action === 'switch-model') {
                // Show the categorized model picker so the user can choose visually
                const picked = await showModelPicker(this.configManager);
                if (!picked) {
                    logger.info('Model selection cancelled — retrying with current model.');
                    restartSpinner();
                    return { action: 'retry' };
                }
                console.log('');
                logger.info(`Switching to model: ${picked.model} (provider: ${picked.provider})`);
                // Create a new LLM provider with the switched model
                const newOptions = {
                    ...options,
                    provider: picked.provider,
                    model: picked.model,
                };
                const newCallLLM = this.createLLMProvider(newOptions);
                restartSpinner();
                return { action: 'switch-model', callLLM: newCallLLM };
            }
            // Fallback: retry
            restartSpinner();
            return { action: 'retry' };
        };
    }
    async executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM) {
        const maxRepairs = options.maxRepairs ?? 3;
        const repairMode = (options.repairMode ?? 'auto');
        // If repairs are enabled and this isn't a debugger/runner (which have their own retry logic),
        // set up the error-repair engine
        const useRepair = maxRepairs > 0 && repairMode !== 'off' &&
            !['debugger', 'runner', 'tester'].includes(task.agentType);
        vault.updateTaskStatus(task.id, 'running');
        await tryUpdateDAGNode(task.id, { status: 'running' });
        // Update spinner text to show which task is currently executing
        if (options.spinner) {
            const agentIcon = AGENT_ICONS[task.agentType] || '⚙️';
            const shortDesc = task.description.slice(0, 60);
            options.spinner.start(`${agentIcon} ${shortDesc}${task.description.length > 60 ? '...' : ''}`);
        }
        if (options.verbose) {
            logger.info(`\n   ▶️  ${task.agentType}: ${task.description.slice(0, 80)}${task.description.length > 80 ? '...' : ''}`);
        }
        try {
            const agentModel = options.model || options.agentModels?.[task.agentType];
            const agentCallLLM = agentModel
                ? this.createLLMProvider({ ...options, model: agentModel })
                : defaultCallLLM;
            // Skip tester and debugger tasks in skip-tests mode
            if (options.skipTests && (task.agentType === 'tester' || task.agentType === 'debugger')) {
                vault.updateTaskStatus(task.id, 'completed', 'Skipped (--skip-tests)');
                agentResults.push({
                    agent: task.agentType,
                    success: true,
                    summary: 'Skipped (--skip-tests)',
                });
                if (options.verbose) {
                    logger.info(`      ⏭️  Skipped ${task.agentType} (--skip-tests)`);
                }
                return;
            }
            // Skip runner tasks in dry-run mode (no commands executed)
            if (task.agentType === 'runner' && options.dryRun) {
                vault.updateTaskStatus(task.id, 'completed', 'Skipped (dry-run mode)');
                agentResults.push({
                    agent: 'runner',
                    success: true,
                    summary: 'Skipped (dry-run mode — no commands executed)',
                });
                if (options.verbose) {
                    logger.info('      ⏭️  Skipped (dry-run — no commands executed)');
                }
                return;
            }
            const agent = createAgent(task.agentType, options);
            if (!agent) {
                vault.updateTaskStatus(task.id, 'failed', `Unknown agent type: ${task.agentType}`);
                agentResults.push({
                    agent: task.agentType,
                    success: false,
                    summary: `Unknown agent type: ${task.agentType}`,
                });
                return;
            }
            // Wire up the rate-limit handler so agents can prompt the user
            vault.context.onRateLimit = this.createRateLimitHandler(options, agentModel || options.model);
            // ── Execute agent with optional auto-repair loop ────────────────
            let result;
            if (useRepair) {
                // Try the agent — if it fails, attempt auto-repair
                const firstResult = await agent.execute(vault.context, agentCallLLM);
                if (firstResult.success) {
                    result = firstResult;
                }
                else {
                    if (options.verbose) {
                        const repairableTypes = ['llm-error', 'provider-error', 'context-limit', 'process-error', 'unknown'];
                        logger.info(`      🔧 Agent failed — attempting auto-repair (mode: ${repairMode}, max: ${maxRepairs})`);
                    }
                    const errorMessage = firstResult.error || firstResult.summary || 'Unknown error';
                    const repairEngine = new ErrorRepairEngine({
                        maxRepairs,
                        repairMode,
                        verbose: options.verbose,
                        fallbackModels: options.repairFallbackModels,
                    });
                    result = await repairEngine.repair(task.id, vault.context, agentCallLLM, errorMessage, async (ctx, llm) => {
                        return agent.execute(ctx, llm);
                    });
                    if (options.verbose) {
                        logger.info(`      🔧 ${result.success ? '✅ Repair succeeded' : '❌ Repair failed'} after ${repairEngine.budget.getAttempts(task.id)} attempt(s)`);
                    }
                }
            }
            else {
                result = await agent.execute(vault.context, agentCallLLM);
            }
            vault.updateTaskStatus(task.id, result.success ? 'completed' : 'failed', result.summary);
            await tryUpdateDAGNode(task.id, {
                status: result.success ? 'completed' : 'failed',
                summary: result.summary,
            });
            agentResults.push({ agent: task.agentType, success: result.success, summary: result.summary });
            // Track sandbox path for cleanup
            if (result.success && task.agentType === 'tester') {
                const testResult = vault.getMeta('testResult');
                if (testResult?.sandboxPath) {
                    vault.setMeta('sandboxPath', testResult.sandboxPath);
                }
            }
            // After debugger step: write debugger's fixes to disk immediately
            // The DebuggerAgent's syncChangesToContext() updates context.fileChanges
            // with LLM-generated fixes. If a runner step follows the debugger, those
            // fixes must be on disk before the runner executes.
            if (task.agentType === 'debugger' && result.success && !options.dryRun) {
                const applied = this.applyFileChanges(vault);
                if (applied > 0 && options.verbose) {
                    logger.info(`      💾 Applied ${applied} debug fix(es) to disk`);
                }
            }
            // After writer step: write files to disk immediately and sync into artifacts
            // IMPORTANT: files MUST be on disk before the RunnerAgent tries to execute them
            if (task.agentType === 'writer' && result.success) {
                if (!options.dryRun) {
                    const applied = this.applyFileChanges(vault);
                    if (applied > 0 && options.verbose) {
                        logger.info(`      💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`);
                    }
                }
                const newArtifacts = vault.context.fileChanges
                    .filter((c) => c.status === 'created' || c.status === 'modified')
                    .filter((c) => c.newContent)
                    .map((c) => ({
                    path: c.path,
                    content: c.newContent,
                    description: `${c.status} by WriterAgent (${task.description.slice(0, 60)})`,
                }));
                for (const artifact of newArtifacts) {
                    const existing = vault.context.artifacts.findIndex((a) => a.path === artifact.path);
                    if (existing >= 0) {
                        vault.context.artifacts[existing] = artifact;
                    }
                    else {
                        vault.context.artifacts.push(artifact);
                    }
                }
            }
            // After runner step: refresh artifacts with any files created during execution
            if (task.agentType === 'runner' && result.success) {
                const runResult = vault.getMeta('runResult');
                if (runResult?.stdout) {
                    vault.setMeta('runOutput', runResult.stdout);
                }
            }
            // Track context file paths for memory storage
            if (task.agentType === 'context-gatherer' && result.success) {
                for (const artifact of vault.context.artifacts) {
                    if (!contextFiles.includes(artifact.path)) {
                        contextFiles.push(artifact.path);
                    }
                }
            }
            // Prune context after each agent step to keep the context bus within limits
            this.pruneContext(vault, options);
            if (options.verbose) {
                const icon = result.success ? '✅' : '⚠️';
                logger.info(`      ${icon} ${result.summary}`);
                // If it's a runner, show the output inline
                if (task.agentType === 'runner' && result.success && result.details) {
                    const outputLines = result.details.split('\n').filter((l) => l.startsWith('stdout:') || l.startsWith('Command:'));
                    for (const line of outputLines) {
                        logger.info(`      ${line}`);
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vault.updateTaskStatus(task.id, 'failed', msg);
            await tryUpdateDAGNode(task.id, { status: 'failed', summary: msg });
            agentResults.push({ agent: task.agentType, success: false, summary: `Error: ${msg}` });
        }
    }
    /**
     * Run the ContextPruner on the vault context.
     * Only prunes when the context exceeds the configured threshold.
     * Logs details in verbose mode.
     */
    pruneContext(vault, options) {
        const maxTokens = options.contextLimit || 128_000;
        const pruner = new ContextPruner({
            maxTokens,
            conversationMode: options.contextPruneMode || 'soft',
        });
        const result = pruner.prune(vault.context);
        if (result.pruned) {
            vault.setMeta('lastPruneResult', result);
            if (options.verbose) {
                const formatted = pruner.formatPruneResult(result);
                if (formatted) {
                    logger.info(`\n${formatted}`);
                }
            }
        }
    }
    applyFileChanges(vault) {
        let count = 0;
        for (const change of vault.context.fileChanges) {
            if (change.status === 'deleted')
                continue;
            if (!change.newContent)
                continue;
            const absolutePath = isAbsolute(change.path)
                ? change.path
                : resolve(process.cwd(), change.path);
            const dir = dirname(absolutePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(absolutePath, change.newContent, 'utf-8');
            count++;
        }
        return count;
    }
    buildResult(success, goal, agentResults, vault, overrides = {}) {
        const completed = overrides.tasksCompleted ?? agentResults.filter((r) => r.success).length;
        const total = overrides.tasksTotal ?? agentResults.length;
        return {
            success,
            goal,
            summary: overrides.summary || `Execution completed with status: ${success ? 'success' : 'failure'}`,
            tasksCompleted: completed,
            tasksTotal: total,
            agentResults,
            fileChanges: vault.getDiffSummary(),
            runOutput: overrides.runOutput,
            error: overrides.error,
            trajectoryId: overrides.trajectoryId,
            reviewId: overrides.reviewId,
        };
    }
}
//# sourceMappingURL=orchestrator.js.map