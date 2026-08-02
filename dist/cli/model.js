/**
 * Model command — Manage and switch inference providers and models seamlessly.
 *
 * This command enables "context-preserving" provider switching:
 * - Changes the active provider/model in a runtime state file
 * - Other commands (chat, execute) can read this state to pick up the current model
 * - The switch is instant — no need to restart any session
 * - Conversation history and agent state are preserved across switches
 *
 * Usage:
 *   buff model                           — Show current config + interactive switch
 *   buff model list                      — List all providers and their status
 *   buff model switch                    — Interactive categorized model picker
 *   buff model switch groq               — Switch to groq (default model)
 *   buff model switch groq/llama-3.3-70b — Switch to specific model
 *   buff model info                      — Show detailed current config
 *   buff model recommend                 — Show model routing recommendations
 *   buff model health                    — Quick health check for active provider
 */
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import inquirer from 'inquirer';
import { BaseCommand } from './commands.js';
import { showModelPicker } from './model-picker.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { getModelBadge } from '../inference/model-catalog.js';
import { getHybridRouter } from '../learning/hybrid-router.js';
import { AUTO_MODEL, AUTO_PROVIDER, getAutoRouter, isAutoModel, isAutoProvider, } from '../learning/auto-router.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { getRouterBandit, COMPLEXITY_BUCKETS, } from '../learning/router-bandit.js';
import { getRouterPromotion, DEFAULT_MIN_PROMOTION_DECISIONS, } from '../learning/router-promotion.js';
import { logger } from '../utils/logger.js';
const BUFF_DIR = join(homedir(), '.buff');
const ACTIVE_MODEL_PATH = join(BUFF_DIR, 'active-model.json');
function ensureBuffDir() {
    if (!existsSync(BUFF_DIR)) {
        mkdirSync(BUFF_DIR, { recursive: true });
    }
}
/**
 * Read the current active model state from disk.
 * Returns null if no state has been saved yet.
 */
export function readActiveModelState() {
    try {
        ensureBuffDir();
        if (!existsSync(ACTIVE_MODEL_PATH))
            return null;
        const raw = readFileSync(ACTIVE_MODEL_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Save a new active model state to disk.
 * This is called when the user switches providers/models.
 */
export function saveActiveModelState(state) {
    ensureBuffDir();
    const full = {
        ...state,
        updatedAt: Date.now(),
    };
    writeFileSync(ACTIVE_MODEL_PATH, JSON.stringify(full, null, 2), 'utf-8');
    logger.debug(`Active model saved: ${state.provider}/${state.model}`);
}
/**
 * Apply the active model state to CLI options.
 * Other commands call this to auto-select the user's last-used model.
 */
export function applyActiveModel(options) {
    const state = readActiveModelState();
    if (!state)
        return options;
    // CLI --provider/--model flags take priority
    return {
        provider: options.provider || state.provider,
        model: options.model || state.model,
    };
}
// ─── Provider Metadata ──────────────────────────────────────────────────────
const PROVIDER_ICONS = {
    local: '💻',
    nim: '🔶',
    gemini: '🔷',
    openrouter: '🟣',
    groq: '🟢',
    auto: '🤖',
};
const PROVIDER_LABELS = {
    local: 'Ollama (Local)',
    nim: 'NVIDIA NIM',
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    auto: 'Auto (Agent decides)',
};
const PROVIDER_ELIGIBILITY = {
    local: 'Works offline — install Ollama: brew install ollama',
    nim: 'Set NVIDIA_NIM_API_KEY (get at build.nvidia.com)',
    gemini: 'Set GEMINI_API_KEY (get at aistudio.google.com/apikey)',
    openrouter: 'Set OPENROUTER_API_KEY (get at openrouter.ai/keys)',
    groq: 'Set GROQ_API_KEY (get at console.groq.com)',
};
/**
 * Sample tasks used by `buff model explain` (no-task mode) to walk every
 * complexity level. Shared by the human rendering and the --json output so
 * they never drift apart.
 */
const EXPLAIN_SAMPLES = [
    { label: '🟢 trivial', task: 'format this code' },
    { label: '🔵 simple', task: 'add a simple utility function' },
    { label: '🟡 moderate', task: 'implement JWT authentication with refresh tokens' },
    { label: '🟠 complex', task: 'design a distributed event-driven microservices architecture' },
    { label: '🔴 critical', task: 'deploy to production with zero downtime' },
];
// ─── ModelCommand ───────────────────────────────────────────────────────────
export class ModelCommand extends BaseCommand {
    create() {
        const cmd = new Command('model')
            .description('Manage inference providers and models — switch, list, inspect, and recommend');
        cmd
            .command('list')
            .alias('ls')
            .description('List all providers and their configuration status')
            .option('--all', 'Show all providers including unconfigured', false)
            .option('-j, --json', 'Output as JSON (for scripting and IDE integration)', false)
            .action(async (opts) => this.listProviders(opts));
        cmd
            .command('switch [providerAndModel]')
            .description('Switch active provider/model (interactive or via argument). Use `auto` for smart routing')
            .option('--provider <provider>', 'Provider to switch to')
            .option('--model <model>', 'Model to use with the provider')
            .action(async (providerAndModel, opts) => {
            await this.switchProvider(providerAndModel, opts);
        });
        cmd
            .command('info')
            .description('Show current active provider and model configuration')
            .option('--verbose', 'Show detailed configuration', false)
            .action((opts) => this.showInfo(opts));
        cmd
            .command('recommend')
            .description('Show model routing recommendations')
            .action(() => this.showRecommendations());
        cmd
            .command('explain [task]')
            .description('Explain Auto model routing — why a provider/model would be picked for a task')
            .option('-a, --agent <type>', 'Agent type to route for (default: chat)', 'chat')
            .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
            .action((task, opts) => this.showExplain(task, opts));
        cmd
            .command('health')
            .description('Quick health check for the currently active provider')
            .option('-p, --provider <provider>', 'Check a specific provider instead')
            .option('--verbose', 'Show detailed diagnostic info', false)
            .action(async (opts) => {
            await this.checkHealth(opts);
        });
        cmd
            .command('bandit [action]')
            .description('Show learning-router bandit state (Thompson-sampling priors per provider × complexity bucket). Action: reset')
            .option('-j, --json', 'Output as JSON (for scripting and CI)', false)
            .action((action, opts) => this.showBandit(action, opts));
        // Default action (no subcommand): show info and offer to switch
        cmd
            .action(async () => {
            await this.showInfo({ verbose: false });
            await this.promptSwitchIfWanted();
        });
        return cmd;
    }
    // ── Subcommand: list ───────────────────────────────────────────────────
    async listProviders(opts) {
        const builtinTypes = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
        const registry = getPluginRegistry();
        const pluginTypes = registry.getAllPlugins().map((p) => p.getProviderType());
        const active = readActiveModelState();
        console.log('');
        logger.highlight('📡 Checking provider configurations...\n');
        const results = [];
        // Check built-in providers (in parallel)
        const providerChecks = builtinTypes.map(async (pt) => {
            const icon = PROVIDER_ICONS[pt] || '🔹';
            const label = PROVIDER_LABELS[pt] || pt;
            const hasKey = this.configManager.hasRequiredCredentials(pt);
            const configured = pt === 'local' || hasKey;
            if (!configured && !opts.all) {
                return {
                    type: pt,
                    label,
                    icon,
                    configured: false,
                    available: false,
                    defaultModel: this.configManager.getAll().providers[pt]?.model,
                    isActive: active?.provider === pt,
                    isPlugin: false,
                };
            }
            try {
                const resolved = await this.getProvider({ provider: pt });
                const available = await resolved.provider.isAvailable();
                return {
                    type: pt,
                    label,
                    icon,
                    configured: true,
                    available,
                    defaultModel: this.configManager.getAll().providers[pt]?.model,
                    isActive: active?.provider === pt,
                    isPlugin: false,
                };
            }
            catch {
                return {
                    type: pt,
                    label,
                    icon,
                    configured,
                    available: false,
                    defaultModel: this.configManager.getAll().providers[pt]?.model,
                    isActive: active?.provider === pt,
                    isPlugin: false,
                };
            }
        });
        // Wait for all provider checks to complete in parallel
        const builtinResults = await Promise.all(providerChecks);
        results.push(...builtinResults);
        // Check plugin providers
        const pluginReg = getPluginRegistry();
        for (const plugin of pluginReg.getAllPlugins()) {
            const pt = plugin.getProviderType();
            let available = false;
            let defaultModel = undefined;
            let configured = true;
            try {
                const resolved = await this.getProvider({ provider: pt });
                available = await resolved.provider.isAvailable();
                defaultModel = this.configManager.getProviderConfig(pt).config.model;
            }
            catch {
                available = false;
                defaultModel = this.configManager.getProviderConfig(pt).config.model;
            }
            results.push({
                type: pt,
                label: plugin.metadata.name,
                icon: '🔌',
                configured,
                available,
                defaultModel,
                isActive: active?.provider === pt,
                isPlugin: true,
            });
        }
        // ── JSON output (for scripting / IDE integration) ───────────────
        if (opts.json) {
            console.log(JSON.stringify({
                active,
                providers: results,
            }, null, 2));
            return;
        }
        // ── Render ─────────────────────────────────────────────────────────
        console.log('  ┌──────────────────────────────────┬──────────┬──────────┬──────────────────┐');
        console.log('  │ Provider                         │ Status   │ Available│ Model            │');
        console.log('  ├──────────────────────────────────┼──────────┼──────────┼──────────────────┤');
        for (const r of results) {
            const name = `${r.icon} ${r.label}`.padEnd(30).slice(0, 30);
            const status = r.isActive ? '✅ Active' : r.configured ? '⚙️  Ready' : '⏳ Needs key';
            const avail = r.available ? '✅' : '⛔';
            const model = (r.defaultModel || 'default').padEnd(15).slice(0, 15);
            console.log(`  │ ${name} │ ${status.padEnd(8)} │ ${avail}      │ ${model} │`);
        }
        console.log('  └──────────────────────────────────┴──────────┴──────────┴──────────────────┘');
        if (active) {
            console.log('');
            logger.success(`Active: ${active.provider}/${active.model}`);
            console.log(`  (set ${new Date(active.updatedAt).toLocaleString()})`);
        }
        console.log('');
        logger.info('Run `buff model switch` to change the active provider/model.');
        logger.info('Run `buff doctor` for full diagnostic checks.');
        console.log('');
    }
    // ── Subcommand: switch ─────────────────────────────────────────────────
    async switchProvider(providerAndModel, opts) {
        // ── Case 1: Argument provided: "groq/llama-3.3-70b" or just "groq" ──
        if (providerAndModel) {
            const slashIdx = providerAndModel.indexOf('/');
            let provider;
            let model;
            if (slashIdx > 0) {
                // Format: "groq/llama-3.3-70b-versatile"
                provider = providerAndModel.slice(0, slashIdx);
                model = providerAndModel.slice(slashIdx + 1);
            }
            else {
                // Format: "groq" — use provided --model or default
                provider = providerAndModel;
                model = opts?.model;
            }
            await this.doSwitch(provider, model);
            return;
        }
        // ── Case 2: --provider / --model flags ────────────────────────────
        if (opts?.provider) {
            await this.doSwitch(opts.provider, opts.model);
            return;
        }
        // ── Case 3: Interactive model picker ──────────────────────────────
        const picked = await showModelPicker(this.configManager);
        if (!picked) {
            logger.info('Model selection cancelled.');
            return;
        }
        await this.doSwitch(picked.provider, picked.model);
    }
    /**
     * Perform the actual provider/model switch.
     * Saves the active model state and confirms to the user.
     * Special-cases `auto` — the agent decides the best provider/model per task.
     */
    async doSwitch(provider, model) {
        // ── Auto mode: agent decides per task ─────────────────────────────────
        if (isAutoProvider(provider) || isAutoModel(model)) {
            saveActiveModelState({
                provider: AUTO_PROVIDER,
                model: AUTO_MODEL,
                explicit: true,
                providerLabel: 'Auto (Agent decides)',
            });
            console.log('');
            logger.success('🤖  Auto routing enabled');
            console.log('   Agent-Nuvira will pick the best provider/model for each task');
            console.log('   based on complexity, cost, latency, privacy, and reliability.');
            console.log('');
            logger.info('Run `buff model switch <provider>` to pin a specific provider instead.');
            console.log('');
            return;
        }
        try {
            // Resolve the actual model to use
            let resolvedModel = model;
            if (!resolvedModel) {
                // Use the provider's default model from config
                try {
                    const { config } = this.configManager.getProviderConfig(provider);
                    resolvedModel = config.model;
                }
                catch {
                    // Provider might not be built-in; use a fallback
                    resolvedModel = 'default';
                }
            }
            // Quick availability check
            const resolved = await this.getProvider({ provider });
            // Verify the resolved provider matches what was requested
            // resolveProvider() may fall back to the default if the provider is unknown
            const actualType = resolved.type;
            if (actualType !== provider) {
                logger.warn(`⚠️  Provider '${provider}' not found — using '${actualType}' instead.`);
                provider = actualType;
            }
            const available = await resolved.provider.isAvailable();
            if (!available) {
                const eligibility = PROVIDER_ELIGIBILITY[provider] || 'Check your API key configuration';
                logger.warn(`⚠️  Provider '${provider}' is not currently available.`);
                logger.info(`   ${eligibility}`);
                logger.info('   Saving anyway — it will be used when available.\n');
            }
            // Save the active model state
            const label = PROVIDER_LABELS[provider] || resolved.provider.name || provider;
            saveActiveModelState({
                provider,
                model: resolvedModel,
                explicit: true,
                providerLabel: label,
            });
            console.log('');
            logger.success(`✅ Switched active model to:`);
            const icon = PROVIDER_ICONS[provider] || '🔹';
            console.log(`   ${icon}  ${label}`);
            const badge = getModelBadge(resolvedModel);
            if (badge) {
                console.log(`   🧠  ${resolvedModel}  — ${badge}`);
            }
            else {
                console.log(`   🧠  ${resolvedModel}`);
            }
            console.log('');
            logger.info('This model will be used by default for `buff chat`, `buff execute`, and other commands.');
            console.log('');
        }
        catch (err) {
            logger.error(`Failed to switch: ${err instanceof Error ? err.message : String(err)}`);
            logger.info('Use `buff model list` to see available providers.');
        }
    }
    // ── Subcommand: info ───────────────────────────────────────────────────
    showInfo(opts) {
        const active = readActiveModelState();
        const config = this.configManager.getAll();
        console.log('');
        logger.highlight('═══  Model Configuration  ═══');
        console.log('');
        if (active) {
            const icon = PROVIDER_ICONS[active.provider] || '🔹';
            logger.success(`  Active: ${icon} ${active.providerLabel || active.provider}`);
            console.log(`  Model:  🧠  ${active.model}`);
            console.log(`  Since:  ${new Date(active.updatedAt).toLocaleString()}`);
            console.log('');
            // Show model details
            const badge = getModelBadge(active.model);
            if (badge) {
                console.log(`  📌 ${badge}`);
                console.log('');
            }
        }
        else {
            logger.info('  No active model set.');
            logger.info('  Run `buff model switch` to select one.');
            console.log('');
        }
        if (opts.verbose) {
            logger.highlight('  ── All Provider Configurations ──');
            console.log('');
            const builtinTypes = ['local', 'groq', 'nim', 'gemini', 'openrouter'];
            const pluginReg_2 = getPluginRegistry();
            const pluginProviders = pluginReg_2.getAllPlugins();
            for (const pt of builtinTypes) {
                const icon = PROVIDER_ICONS[pt] || '🔹';
                const label = PROVIDER_LABELS[pt] || pt;
                const providerConfig = config.providers[pt] || {};
                const isActive = active?.provider === pt;
                console.log(`  ${icon} ${label}${isActive ? '  ← active' : ''}`);
                console.log(`     Model:     ${providerConfig.model || '(not set)'}`);
                console.log(`     API Key:   ${providerConfig.apiKey ? '✅ configured' : '⏳ not set'}`);
                if (providerConfig.temperature !== undefined) {
                    console.log(`     Temp:      ${providerConfig.temperature}`);
                }
                if (providerConfig.maxTokens !== undefined) {
                    console.log(`     Max tokens: ${providerConfig.maxTokens}`);
                }
                if (providerConfig.baseUrl) {
                    console.log(`     Base URL:  ${providerConfig.baseUrl}`);
                }
                console.log('');
            }
            for (const plugin of pluginProviders) {
                const pt = plugin.getProviderType();
                const providerConfig = config.providers[pt] || {};
                const isActive = active?.provider === pt;
                const icon = '🔌';
                console.log(`  ${icon} ${plugin.metadata.name}${isActive ? '  ← active' : ''}`);
                console.log(`     Type:      ${pt}`);
                console.log(`     Model:     ${providerConfig.model || '(not set)'}`);
                if (providerConfig.apiKey) {
                    console.log(`     API Key:   ✅ configured`);
                }
                if (providerConfig.temperature !== undefined) {
                    console.log(`     Temp:      ${providerConfig.temperature}`);
                }
                if (providerConfig.maxTokens !== undefined) {
                    console.log(`     Max tokens: ${providerConfig.maxTokens}`);
                }
                if (providerConfig.baseUrl) {
                    console.log(`     Base URL:  ${providerConfig.baseUrl}`);
                }
                console.log('');
            }
        }
        console.log('');
        logger.info('Run `buff model switch` to change providers.');
        logger.info('Run `buff model list` to see availability status.');
        console.log('');
    }
    // ── Subcommand: explain ───────────────────────────────────────────────
    showExplain(task, opts) {
        const router = getAutoRouter();
        const agentType = opts.agent || 'chat';
        if (opts.json) {
            console.log(JSON.stringify(this.buildExplainJSON(router, agentType, task), null, 2));
            return;
        }
        console.log('');
        logger.highlight('═══  Auto Model Routing — Explain  ═══');
        console.log('');
        if (task) {
            logger.info(`Task: "${task}"  ·  Agent: ${agentType}`);
            console.log('');
            this.renderRoutingDecision(router, agentType, task);
            return;
        }
        // No task given — walk through sample tasks across all complexity levels
        for (const s of EXPLAIN_SAMPLES) {
            logger.highlight(`  ${s.label} — "${s.task}"`);
            this.renderRoutingDecision(router, agentType, s.task, true);
            console.log('');
        }
        console.log('');
        logger.info('Pass a task for a single detailed decision: `buff model explain "your task"`');
        logger.info('Route for a specific agent: `buff model explain --agent writer "your task"`');
        logger.info('JSON for scripting/CI: `buff model explain "your task" --json`');
        console.log('');
    }
    /**
     * Build a machine-readable explanation payload.
     * Single task → one decision object; no task → all 5 sample complexities.
     * Includes effective per-provider pricing (with override flags).
     */
    buildExplainJSON(router, agentType, task) {
        const toJSON = (t, agent) => {
            const d = router.resolve(agent, t, { useRuntimeStats: true }, this.configManager);
            // Record the explain snapshot for the dashboard audit trail + usage stats
            // (JSON mode returns early in showExplain, so this is the only hook here)
            recordRoutingDecision({
                source: 'explain',
                agentType: agent,
                task: t,
                complexity: d.complexity,
                provider: d.provider,
                model: d.model,
                score: d.score,
            });
            const pricingOverrides = this.configManager.getAll().pricing || {};
            const pricing = {};
            for (const r of d.ranked) {
                const p = router.getProviderPricing(r.provider, this.configManager);
                pricing[r.provider] = {
                    inputPer1K: p.inputPer1K,
                    outputPer1K: p.outputPer1K,
                    overridden: !!pricingOverrides[r.provider],
                };
            }
            return {
                task: t,
                agentType: agent,
                complexity: d.complexity,
                taskType: d.taskType,
                weights: d.weights,
                winner: {
                    provider: d.provider,
                    model: d.model,
                    score: Math.round(d.score * 1000) / 1000,
                },
                ranked: d.ranked.map((r) => ({
                    provider: r.provider,
                    score: Math.round(r.score * 1000) / 1000,
                    inCooldown: r.inCooldown,
                    reason: r.reason,
                    dimensions: r.dimensions,
                })),
                fallbackChain: d.fallbackChain.map((c) => ({
                    provider: c.provider,
                    model: c.model,
                    qualityScore: Math.round(c.qualityScore * 1000) / 1000,
                    reason: c.reason,
                })),
                pricing,
                explanation: d.explanation,
            };
        };
        if (task)
            return toJSON(task, agentType);
        return {
            agentType,
            decisions: EXPLAIN_SAMPLES.map((s) => toJSON(s.task, agentType)),
        };
    }
    /** Render a single routing decision (compact or detailed). */
    renderRoutingDecision(router, agentType, task, compact = false) {
        const decision = router.resolve(agentType, task, { useRuntimeStats: true }, this.configManager);
        // Record the explain snapshot for the dashboard audit trail + usage stats
        recordRoutingDecision({
            source: 'explain',
            agentType,
            task,
            complexity: decision.complexity,
            provider: decision.provider,
            model: decision.model,
            score: decision.score,
        });
        if (compact) {
            console.log(`  → ${decision.provider}/${decision.model}  (score ${decision.score.toFixed(2)}, ${decision.complexity})`);
            return;
        }
        console.log(`  Complexity: ${decision.complexity}  ·  Task type: ${decision.taskType}`);
        console.log('');
        logger.highlight('  ── Dimension weights ──');
        for (const dim of Object.keys(decision.weights)) {
            const pct = Math.round(decision.weights[dim] * 100);
            const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
            console.log(`   ${dim.padEnd(12)} ${bar} ${pct}%`);
        }
        console.log('');
        logger.highlight('  ── Ranked providers ──');
        decision.ranked.forEach((r, i) => {
            const mark = r.provider === decision.provider ? '✅' : '  ';
            const cd = r.inCooldown ? '  (circuit-breaker cooldown)' : '';
            console.log(`   ${mark} ${i + 1}. ${r.provider.padEnd(12)} score ${r.score.toFixed(3)}  ${r.reason}${cd}`);
        });
        console.log('');
        logger.success(`  Decision: ${decision.provider}/${decision.model}`);
        console.log(`  ${decision.explanation}`);
        console.log('');
        logger.highlight('  ── Fallback chain ──');
        for (const c of decision.fallbackChain) {
            console.log(`   → ${c.provider}/${c.model}  (${c.reason})`);
        }
        console.log('');
    }
    // ── Subcommand: recommend ──────────────────────────────────────────────
    showRecommendations() {
        const router = getHybridRouter();
        const recommendations = router.getBenchmarkRecommendations();
        const active = readActiveModelState();
        console.log('');
        logger.highlight('═══  Model Routing Recommendations  ═══');
        console.log('');
        if (active) {
            const icon = PROVIDER_ICONS[active.provider] || '🔹';
            console.log(`  Current: ${icon} ${active.providerLabel || active.provider} / ${active.model}`);
            console.log('');
        }
        // Default agent-to-model mapping
        const defaultMapping = [
            { agent: 'planner', icon: '📋', recommended: 'gemini/gemini-2.0-flash-exp' },
            { agent: 'context-gatherer', icon: '📂', recommended: 'groq/llama-3.3-70b-versatile' },
            { agent: 'writer', icon: '✏️', recommended: 'groq/llama-3.3-70b-versatile' },
            { agent: 'reviewer', icon: '👁️', recommended: 'openrouter/meta-llama/llama-3.1-8b-instruct' },
            { agent: 'tester', icon: '🧪', recommended: 'groq/llama-3.3-70b-versatile' },
            { agent: 'debugger', icon: '🐛', recommended: 'openrouter/meta-llama/llama-3.1-8b-instruct' },
        ];
        if (recommendations.length > 0) {
            logger.highlight('  ── Benchmark-Driven Recommendations ──');
            console.log('');
            for (const rec of recommendations) {
                const confidence = rec.confidence === 'high' ? '✅' : rec.confidence === 'medium' ? '📊' : '🔬';
                console.log(`  ${confidence} ${rec.agentType.padEnd(20)} → ${rec.recommendedModel}`);
            }
        }
        console.log('');
        logger.highlight('  ── Default Recommendations ──');
        console.log('');
        for (const { agent, icon, recommended } of defaultMapping) {
            console.log(`  ${icon} ${agent.padEnd(20)} → ${recommended}`);
        }
        console.log('');
        logger.info('To use routing: add `--auto-route` to `buff execute` commands.');
        logger.info('To set a specific model per agent: `buff execute --planner-model <model>`');
        console.log('');
    }
    // ── Subcommand: health ─────────────────────────────────────────────────
    async checkHealth(opts) {
        const targetProvider = opts.provider || readActiveModelState()?.provider || 'local';
        const icon = PROVIDER_ICONS[targetProvider] || '🔹';
        const label = PROVIDER_LABELS[targetProvider] || targetProvider;
        console.log('');
        logger.highlight(`═══  Health Check: ${icon} ${label}  ═══`);
        console.log('');
        try {
            const resolved = await this.getProvider({ provider: targetProvider });
            const provider = resolved.provider;
            const providerName = provider.name;
            // 1. Provider instantiation
            logger.success(`✅ Provider module: ${providerName} loaded`);
            // 2. API Key check
            const isLocal = targetProvider === 'local';
            const hasKey = this.configManager.hasRequiredCredentials(targetProvider);
            if (isLocal) {
                logger.success('✅ No API key needed (local provider)');
            }
            else if (hasKey) {
                logger.success('✅ API key is configured');
            }
            else {
                logger.warn('⚠️  No API key configured. Run `buff doctor` for setup help.');
            }
            // 3. Availability
            const available = await provider.isAvailable();
            if (available) {
                logger.success('✅ Endpoint reachable');
            }
            else {
                const eligibility = PROVIDER_ELIGIBILITY[targetProvider] || 'Check configuration';
                logger.warn(`⛔ Endpoint not reachable — ${eligibility}`);
            }
            // 4. Model listing (verbose only)
            if (opts.verbose && available) {
                try {
                    const models = await provider.listModels();
                    const count = models.length;
                    if (count > 0) {
                        logger.success(`✅ ${count} model(s) available`);
                        if (opts.verbose) {
                            console.log('');
                            for (const m of models.slice(0, 10)) {
                                console.log(`     • ${m.id}`);
                            }
                            if (count > 10) {
                                console.log(`     ... and ${count - 10} more`);
                            }
                        }
                    }
                    else {
                        logger.warn('⚠️  No models found');
                    }
                }
                catch {
                    logger.warn('⚠️  Could not list models');
                }
            }
            // Active model info
            const active = readActiveModelState();
            if (active && active.provider === targetProvider) {
                console.log('');
                logger.success(`📌 Active model: ${active.model}`);
            }
            console.log('');
            logger.info('Run `buff doctor` for a full system health check.');
            console.log('');
        }
        catch (err) {
            logger.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
            console.log('');
        }
    }
    // ── Subcommand: bandit ────────────────────────────────────────────────
    showBandit(action, opts) {
        if (action === 'reset') {
            // Call .reset() on the INSTANCE (persists an empty state to disk), not the
            // module-level resetRouterBandit() which only drops the in-memory singleton.
            getRouterBandit().reset();
            getRouterPromotion().reset();
            console.log('');
            logger.success('✅ Bandit state reset — all Beta(α, β) priors back to Beta(1,1), promotion trajectory cleared');
            console.log('');
            return;
        }
        if (action && action !== 'reset') {
            logger.error(`Unknown bandit action: ${action}. Use \`buff model bandit\` to view or \`buff model bandit reset\` to reset.`);
            return;
        }
        const state = getRouterBandit().getState();
        if (opts.json) {
            console.log(JSON.stringify(this.buildBanditJSON(state), null, 2));
            return;
        }
        console.log('');
        logger.highlight('═══  Learning Router — Bandit State  ═══');
        console.log('');
        this.renderPromotionGate();
        console.log('');
        // Collect all providers that have any learning data
        const providers = new Set();
        for (const bucket of COMPLEXITY_BUCKETS) {
            for (const provider of Object.keys(state.priors[bucket] || {})) {
                providers.add(provider);
            }
        }
        if (providers.size === 0) {
            logger.info('  No bandit learning data yet.');
            console.log('');
            logger.info('  Enable learning:  `buff config set routing.bandit true`');
            logger.info('  Then run tasks under Auto routing (`buff model switch auto` / `-m auto`).');
            logger.info('  Each auto-routed task updates the Beta prior for its complexity bucket.');
            console.log('');
            return;
        }
        const sortedProviders = [...providers].sort();
        // Table: rows = providers, columns = complexity buckets
        const colWidth = 14;
        const header = `  ${'Provider'.padEnd(12)}${COMPLEXITY_BUCKETS.map((b) => b.padStart(colWidth)).join('')}`;
        console.log(header);
        console.log(`  ${'-'.repeat(header.length - 2)}`);
        for (const provider of sortedProviders) {
            const cells = COMPLEXITY_BUCKETS.map((bucket) => {
                const prior = state.priors[bucket]?.[provider];
                if (!prior)
                    return ''.padStart(colWidth);
                const mean = prior.alpha / (prior.alpha + prior.beta);
                const cell = `${prior.alpha}/${prior.beta} (${(mean * 100).toFixed(0)}%)`;
                return cell.padStart(colWidth).slice(0, colWidth);
            }).join('');
            console.log(`  ${provider.padEnd(12)}${cells}`);
        }
        console.log('');
        console.log('  Cell format: α/β (expected win %)  ·  α/β = Beta prior for that complexity bucket');
        console.log('  Higher α = more successful outcomes; higher β = more failures.');
        console.log('');
        // ── Per-modelId priors (ruflo ADR-149 mirror) ────────────────────────
        const modelPriors = state.modelPriors || {};
        const modelProviders = new Set();
        for (const bucket of COMPLEXITY_BUCKETS) {
            for (const model of Object.keys(modelPriors[bucket] || {})) {
                modelProviders.add(model);
            }
        }
        if (modelProviders.size > 0) {
            logger.highlight(`  ── Per-model priors (${modelProviders.size} learned model(s)) ──`);
            console.log('');
            for (const model of [...modelProviders].sort().slice(0, 12)) {
                const cells = COMPLEXITY_BUCKETS.map((bucket) => {
                    const prior = modelPriors[bucket]?.[model];
                    if (!prior)
                        return ''.padStart(14);
                    const mean = prior.alpha / (prior.alpha + prior.beta);
                    return `${prior.alpha}/${prior.beta} (${(mean * 100).toFixed(0)}%)`.padStart(14).slice(0, 14);
                }).join('');
                console.log(`  ${model.padEnd(22).slice(0, 22)}${cells}`);
            }
            console.log('');
            logger.info(`  Model cells: α/β (expected win %) per complexity bucket — higher α = more successful outcomes for that model.`);
            console.log('');
        }
        // Learning history
        const history = state.learningHistory;
        if (history.length > 0) {
            logger.highlight(`  ── Recent learning history (last ${Math.min(history.length, 15)} of ${history.length}) ──`);
            console.log('');
            for (const h of history.slice(-15)) {
                const icon = h.outcome === 'success' ? '✅' : h.outcome === 'escalated' ? '🔄' : '❌';
                // Model-level history entries carry the concrete model id (provider is
                // the same string) — render just the model to avoid 'x (x)' noise.
                const label = h.model ?? h.provider;
                const ts = new Date(h.timestamp).toLocaleTimeString();
                console.log(`   ${icon} ${label.padEnd(24).slice(0, 24)} ${h.complexity.padEnd(10)} reward ${h.reward.toFixed(2)}  ${ts}`);
            }
            console.log('');
        }
        logger.info('Reset: `buff model bandit reset` · JSON: `buff model bandit --json`');
        console.log('');
    }
    /** Render the promotion gate (bandit-vs-heuristic A/B verdict). */
    renderPromotionGate() {
        const minDecisions = this.configManager.getAll().routing?.promotionMinDecisions ?? DEFAULT_MIN_PROMOTION_DECISIONS;
        const status = getRouterPromotion().evaluate(minDecisions);
        logger.highlight('  ── Promotion Gate (bandit vs. heuristic) ──');
        console.log('');
        if (status.decisionCount === 0) {
            logger.info('  No A/B trajectory yet. Enable `routing.bandit` and run auto-routed tasks to populate it.');
            console.log('');
            return;
        }
        const pct = (v) => `${(v * 100).toFixed(2)}%`;
        const pass = (ok) => (ok ? '✅ PASS' : '❌ FAIL');
        console.log(`   Decisions recorded: ${status.decisionCount}  ·  Diverged (A/B signal): ${status.divergedCount} / required ${status.minDecisions}`);
        console.log('');
        console.log(`   (a) Quality  Δ ${pct(status.qualityDelta)}   (need > +2%)            ${pass(status.criteria.quality)}`);
        console.log(`   (b) Cost     Δ ${pct(status.costDelta)}   (need < +1%)            ${pass(status.criteria.cost)}`);
        const latencyDisplay = status.latencyMeasured ? pct(status.latencyDelta) : 'n/a';
        const latencyBadge = status.latencyMeasured ? pass(status.criteria.latency) : 'n/a';
        console.log(`   (c) Latency  Δ ${latencyDisplay}   (p95, need < +5%)       ${latencyBadge}`);
        console.log('');
        if (!status.sufficient) {
            logger.info(`  ⏳ Not enough diverged decisions yet (${status.divergedCount}/${status.minDecisions}) — keep the bandit on; more real tasks will settle the verdict.`);
        }
        else if (status.promoted) {
            logger.success('  🏆 PROMOTED — the bandit measurably beats the deterministic heuristic (quality up, no cost/latency regression).');
        }
        else {
            logger.warn('  ⚠️  NOT promoted — the bandit does not yet beat the deterministic heuristic on real trajectories.');
            logger.info('     Consider `buff config set routing.bandit false` or `buff model bandit reset` to restart learning.');
        }
        console.log('');
    }
    /** Build a machine-readable bandit snapshot for scripting/CI. */
    buildBanditJSON(state) {
        const providers = new Set();
        for (const bucket of COMPLEXITY_BUCKETS) {
            for (const provider of Object.keys(state.priors[bucket] || {})) {
                providers.add(provider);
            }
        }
        const priors = {};
        for (const provider of providers) {
            priors[provider] = {};
            for (const bucket of COMPLEXITY_BUCKETS) {
                const prior = state.priors[bucket]?.[provider];
                priors[provider][bucket] = prior
                    ? {
                        alpha: Math.round(prior.alpha * 1000) / 1000,
                        beta: Math.round(prior.beta * 1000) / 1000,
                        expectedWinRate: Math.round((prior.alpha / (prior.alpha + prior.beta)) * 1000) / 1000,
                    }
                    : { alpha: 0, beta: 0, expectedWinRate: 0 };
            }
        }
        // Per-model priors (ruflo ADR-149 mirror)
        const modelPriorsMap = state.modelPriors || {};
        const modelPriors = {};
        for (const bucket of COMPLEXITY_BUCKETS) {
            const bucketPriors = modelPriorsMap[bucket] || {};
            for (const model of Object.keys(bucketPriors)) {
                modelPriors[model] ??= {};
                const prior = bucketPriors[model];
                modelPriors[model][bucket] = {
                    alpha: Math.round(prior.alpha * 1000) / 1000,
                    beta: Math.round(prior.beta * 1000) / 1000,
                    expectedWinRate: Math.round((prior.alpha / (prior.alpha + prior.beta)) * 1000) / 1000,
                };
            }
        }
        // Promotion gate
        const minDecisions = this.configManager.getAll().routing?.promotionMinDecisions ?? DEFAULT_MIN_PROMOTION_DECISIONS;
        const promotion = this.toPromotionJSON(getRouterPromotion().evaluate(minDecisions));
        return {
            version: state.version,
            enabled: this.configManager.getAll().routing?.bandit === true,
            priors,
            modelPriors,
            promotion,
            learningHistory: state.learningHistory.slice(-50).map((h) => ({
                provider: h.provider,
                model: h.model,
                complexity: h.complexity,
                outcome: h.outcome,
                reward: h.reward,
                timestamp: h.timestamp,
            })),
            updatedAt: Date.now(),
        };
    }
    /** Machine-readable promotion-gate snapshot. */
    toPromotionJSON(status) {
        return {
            decisionCount: status.decisionCount,
            divergedCount: status.divergedCount,
            minDecisions: status.minDecisions,
            qualityDelta: Math.round(status.qualityDelta * 10000) / 10000,
            costDelta: Math.round(status.costDelta * 10000) / 10000,
            latencyDelta: Math.round(status.latencyDelta * 10000) / 10000,
            latencyMeasured: status.latencyMeasured,
            criteria: status.criteria,
            sufficient: status.sufficient,
            promoted: status.promoted,
        };
    }
    // ── Interactive prompt ─────────────────────────────────────────────────
    async promptSwitchIfWanted() {
        console.log('');
        const answer = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Would you like to switch providers/models?',
                prefix: '🔄',
                choices: [
                    { name: '🎯  Yes, show me the model picker', value: 'switch' },
                    { name: '❌  No, keep current configuration', value: 'keep' },
                ],
            },
        ]);
        console.log('');
        if (answer.action === 'switch') {
            await this.switchProvider(undefined, {});
        }
    }
}
//# sourceMappingURL=model.js.map