import { createInterface } from 'node:readline';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { showModelPicker } from './model-picker.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { assembleContext, retrievalOptionsFromConfig, recordRetrievalStats } from '../learning/retrieval.js';
import { getChatHistory } from '../context/history.js';
import { getMemoryManager } from '../memory/manager.js';
import { logger } from '../utils/logger.js';
import { printOrchestrationResult } from './execute.js';
import { applyActiveModel } from './model.js';
import { getProviderFallback, classifyFallbackError, isRetryableError, recordRegistrySuccess } from '../learning/provider-fallback.js';
import { recordActionFailure, TRANSIENT_FAILURE_EXCLUSION_MS } from '../learning/failure-bookkeeping.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { estimateTokens } from '../learning/cost-tracker.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { refreshModelRegistry, spotCheckModel } from '../inference/model-probe.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { shouldConfirmFailover, promptFailoverChoice } from './failover-prompt.js';
import { buildAutoResolveOptions } from '../learning/resolve-options.js';
import { parseRequestSync } from '../nlu/parser.js';
import { PlanStore } from '../tools/plan-store.js';
import { withLogCorrelation } from '../enterprise/log.js';
import { recordMetricTime, getMetrics } from '../enterprise/metrics.js';
import { resolveDispatch } from '../nlu/actions.js';
import { isConversationalQuestion, hasCodingAction } from '../nlu/conversation-gate.js';
import { runToolLoop, extractFallbackToolCalls } from '../tools/tool-loop.js';
import { getTool, TOOL_CONTRACT_JSON } from '../tools/registry.js';
// S2/S3 — the shared tool-call reliability helpers (salvage failed_generation,
// compact fallback schemas). One copy for every tool-calling surface, not
// chat-private (execute/plan/… inherit the fix).
import { buildJsonFallbackPrompt, salvageFailedGeneration } from '../inference/tool-call-utils.js';
import { runPipelineTool } from '../tools/pipeline-tool.js';
import { ArtifactStore } from '../tools/artifact-store.js';
import { getEventBus } from '../observability/event-bus.js';
import { maybeRunBackgroundDuties } from './duties.js';
import { deriveProjectId } from '../config/workspace.js';
/**
 * Detect error type and prompt the user for a recovery action.
 * This is a standalone function (not a method) for clarity.
 */
async function handleInferenceError(err, providerName, configManager) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStr = errorMessage.toLowerCase();
    // ── Detect error type ────────────────────────────────────────────────
    const isRateLimit = errorStr.includes('429') ||
        errorStr.includes('rate limit') ||
        errorStr.includes('too many requests') ||
        errorStr.includes('quota exceeded') ||
        errorStr.includes('rate_limit') ||
        // Keep in sync with classifyFallbackError(): mid-session quota/limit
        // exhaustion (Gemini-style) must also offer "wait and retry".
        errorStr.includes('token limit') ||
        errorStr.includes('resource has been exhausted') ||
        errorStr.includes('insufficient_quota');
    const isAuthError = errorStr.includes('401') ||
        errorStr.includes('403') ||
        errorStr.includes('unauthorized') ||
        errorStr.includes('forbidden') ||
        errorStr.includes('api key');
    const isServerError = errorStr.includes('500') ||
        errorStr.includes('502') ||
        errorStr.includes('503') ||
        errorStr.includes('server error') ||
        errorStr.includes('internal server');
    const isNetworkError = errorStr.includes('fetch failed') ||
        errorStr.includes('econnrefused') ||
        errorStr.includes('enotfound') ||
        errorStr.includes('econnreset') ||
        errorStr.includes('network') && !errorStr.includes('network policy');
    const errorType = isRateLimit
        ? '🚦 Rate limit'
        : isAuthError
            ? '🔑 Authentication'
            : isServerError
                ? '🔴 Server'
                : isNetworkError
                    ? '🌐 Network'
                    : '⚠️  API';
    // ── Show error summary ───────────────────────────────────────────────
    console.log('');
    logger.error(`${errorType} error from ${providerName}:`);
    const firstLine = errorMessage.split('\n')[0];
    logger.info(`  ${firstLine.slice(0, 200)}`);
    console.log('');
    // ── Build recovery choices ───────────────────────────────────────────
    const choices = [];
    if (isRateLimit) {
        choices.push({ name: '⏳  Wait a moment and retry', value: 'retry' });
    }
    choices.push({ name: '🔄  Switch to a different provider/model', value: 'switch' });
    if (!isAuthError) {
        choices.push({ name: '🔁  Retry with same provider', value: 'retry' });
    }
    choices.push({ name: '❌  Cancel this message', value: 'cancel' });
    choices.push({ name: '🚪  Exit chat', value: 'exit' });
    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'How would you like to proceed?',
            prefix: '⚡',
            choices,
        },
    ]);
    console.log('');
    if (answer.action === 'switch') {
        const picked = await showModelPicker(configManager);
        if (picked) {
            // ── Auto selected — re-enable auto routing instead of switching ──
            if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                return { action: 'switch', auto: true };
            }
            const resolved = resolveProvider(configManager, picked.provider);
            return {
                action: 'switch',
                newType: resolved.type,
                newProvider: resolved.provider,
                newModel: picked.model,
            };
        }
        // Picker cancelled — fall through to cancel
        return { action: 'cancel' };
    }
    if (answer.action === 'retry' && isRateLimit) {
        logger.info('⏳  Waiting 3 seconds before retry...');
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return { action: answer.action };
}
/**
 * E3a/E3c — the rule assessment (hint + no-model fallback source).
 *
 * The legacy `promptDeveloperMode` menu ("1. Chat mode / 2. Developer mode")
 * is DELETED (Session 7c re-scope, landed in E3a). E3c demotes the rules
 * further (model-decides): EVERY request runs as a
 * tool-call turn and the MODEL decides what to do. This function computes
 * what the RULES would say, used for two things only:
 * - the rule hint injected into the model's context (buildToolSystemPrompt),
 * - the no-model fallback decision: when the tool loop fails to generate a
 *   single response AND the rules assessed a high-confidence pipeline intent,
 *   the pipeline runs directly — rules act ONLY when the model is unavailable,
 *   never as a bypass.
 * `dev` (the --dev flag / /dev toggle) forces the assessment to dispatch.
 */
export function resolvePipelineDispatch(parsed, opts) {
    // P0.5 — conversation-vs-pipeline gate (runs BEFORE the dev bypass and the
    // action-map gate, so a question is never dispatched even with --dev, and
    // a coding goal phrased as a question still dispatches):
    // 1. QUESTION → never the pipeline (the observed failure: a question in
    //    execute/dev mode spawned the pipeline and created a python program to
    //    "answer" it).
    // 2. CODING ACTION in command position → always the pipeline, even when the
    //    NLU alone would misread it as chat ("how do I add JWT auth?" → explain
    //    → chat, but the user wants the auth added).
    if (opts?.text) {
        if (isConversationalQuestion(opts.text)) {
            return { dispatch: false, needConfirm: false };
        }
        if (hasCodingAction(opts.text)) {
            return { dispatch: true, needConfirm: false };
        }
    }
    if (opts?.dev)
        return { dispatch: true, needConfirm: false };
    if (parsed.action.run !== 'pipeline')
        return { dispatch: false, needConfirm: false };
    const d = resolveDispatch(parsed);
    return d.autoDispatch
        ? { dispatch: true, needConfirm: false }
        : { dispatch: true, needConfirm: true };
}
/**
 * Execute the multi-agent pipeline for a user's goal (H1/E3b refactor).
 *
 * Thin wrapper over the shared `runPipelineTool` (src/tools/pipeline-tool.ts)
 * — the SAME pipeline core the tool registry's build/resume/repair tools use,
 * so `buff chat` pre-dispatch and in-loop pipeline tool calls can never
 * diverge (STANDING RULE). Prints the orchestration result; the tool path
 * returns the summary text instead.
 */
export async function runDeveloperMode(goal, configManager, options) {
    const r = await runPipelineTool(goal, configManager, {
        provider: options?.provider,
        model: options?.model,
        board: true,
    });
    if (r.result) {
        console.log('');
        printOrchestrationResult(r.result);
    }
    else if (r.error) {
        logger.error(r.error);
    }
}
/**
 * E3b — the tool-loop system prompt: base identity + the tool
 * contract (clarify via ask_user, end every response with suggest_followups).
 *
 * E3c — the rule assessment is a HINT, never a bypass: when the rules parsed
 * a confident intent, the model sees it as context ("rule assessment: … you
 * decide") so it can act faster — but the MODEL is the sole decision-maker
 * (rules act only as the no-model fallback in the
 * caller, never to skip the loop).
 */
function buildToolSystemPrompt(parsed) {
    const ruleHint = parsed && parsed.intent !== 'unknown'
        ? `
Rule assessment (best-effort hint, NOT an order — verify against the actual request and decide for yourself):
intent=${parsed.intent} (${Math.round(parsed.confidence * 100)}%), likely action=${parsed.action.name}.`
        : '';
    return [
        "You are Nuvira, Agent-Nuvira's expert coding agent, working inside the user's project. You identify as Nuvira (never 'Buff').",
        'Be precise and honest. When a request is ambiguous or incomplete, clarify with ask_user instead of guessing.',
        'Answer ordering: first briefly acknowledge the request in your own words, then deliver the full answer, and only then call suggest_followups — the followups must never appear before or instead of the answer.',
        ruleHint,
        '',
        TOOL_CONTRACT_JSON,
    ].join('\n');
}
// ─── ChatCommand ────────────────────────────────────────────────────────────
export class ChatCommand extends BaseCommand {
    devModeAuto = false;
    /**
     * Providers that failed MID-SESSION in auto mode, with the expiry of their
     * exclusion (ms epoch):
     * - AUTH failures (expired token/key) are definitive → excluded for the whole
     *   session (Number.MAX_SAFE_INTEGER), so a provider whose key died mid-session
     *   is never re-picked (and re-failed) on a later message.
     * - RATE-LIMIT failures (429 / exhausted quota / "token limit exceeded") are
     *   usually TRANSIENT (a 1-minute quota window) → excluded only for a short
     *   cooldown, then re-admitted, so a throttled-but-working provider isn't
     *   blacklisted for the entire chat.
     * - 5xx/network errors are NOT session-excluded at all — they flow through
     *   the circuit breaker (which needs repeated failures before opening).
     * Cleared when the chat exits.
     */
    sessionFailedProviders = new Map();
    // RATE_LIMIT_EXCLUSION_MS + TRANSIENT_FAILURE_EXCLUSION_MS now live in
    // src/learning/failure-bookkeeping.ts (shared with every action) — see
    // recordActionFailure. Behavior is identical: same values, same semantics.
    /**
     * Providers that failed TRANSIENTLY this session (server/network/timeout/
     * unknown). Tracked separately from the exclusion map so that when a
     * transient exclusion EXPIRES, the provider is only re-admitted to routing
     * after a quick on-demand spot-check confirms it's actually back — recovery
     * is discovered in seconds, not by blindly failing into it again.
     */
    sessionTransientFailedProviders = new Set();
    /**
     * P0.7 — default plan store for this ChatCommand instance (the dashboard
     * console injects a per-session store instead; this is the CLI/execute
     * default so a plan survives across turns within one chat session).
     */
    planStore = new PlanStore();
    /**
     * Whether the cold-start probe has fired this session. On a fresh registry
     * (no verified models yet) the FIRST auto pick fires a background
     * probe + spot-check so routing learns from real API data instead of
     * failing into dead ends — the fire-and-forget keeps the first message fast.
     */
    coldStartProbeFired = false;
    /**
     * P3 — programmatic single-turn answer for the dashboard chat console.
     *
     * Runs one tool-loop turn — the EXACT engine behind `buff chat "<prompt>"` —
     * and returns content + followups as data instead of printing. Non-TTY by
     * construction: an injected ask_user renderer declines the clarification so
     * the model proceeds on best judgment (inquirer would hang on the server's
     * piped stdin), and no interactive prompts are ever reached. `history`
     * carries prior turns so the dashboard threads a real conversation.
     */
    async answerOnce(message, opts = {}) {
        const activeOpts = applyActiveModel({ provider: opts.provider, model: opts.model });
        const mergedOpts = { ...opts, provider: activeOpts.provider, model: activeOpts.model };
        let autoMode = isAutoModel(mergedOpts.model) || isAutoProvider(mergedOpts.provider);
        let { type, provider } = autoMode
            ? await this.getProvider({})
            : await this.getProvider(mergedOpts);
        let model = mergedOpts.model;
        if (autoMode) {
            const routed = await this.routeMessageAuto(message);
            type = routed.type;
            provider = routed.provider;
            model = routed.model;
        }
        // P3 — tell the GUI where the turn is headed before the tool loop runs.
        opts.onProgress?.(`   🧠 routed to ${provider.name}${model ? ` / ${model}` : ''} — working…`);
        const parsed = parseRequestSync(message);
        const dispatchDecision = resolvePipelineDispatch(parsed, { dev: opts.dev, text: message });
        const answer = await this.runChatAnswer(message, opts.history ?? [], { type, provider, model }, { provider: mergedOpts.provider, model: mergedOpts.model, dev: mergedOpts.dev, cache: true }, true, { auto: autoMode }, parsed, { askUser: opts.askUser, onProgress: opts.onProgress, onToolCall: opts.onToolCall, onPlanChange: opts.onPlanChange, onGitDiff: opts.onGitDiff, planStore: opts.planStore ?? this.planStore, gateway: opts.gateway });
        // No-model fallback: the tool loop could not generate a single response
        // AND the rules assessed a high-confidence pipeline intent — run the
        // pipeline directly (rules decide only when the model is unavailable; the
        // pipeline resolves its own working provider/model).
        if (answer.generationFailed && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
            const r = await runPipelineTool(message, this.configManager, { provider: type, model, board: false });
            if (r.error) {
                return { content: '', followups: [], generationFailed: true, provider: type, model };
            }
            return { content: r.result?.summary ?? '', followups: [], provider: type, model };
        }
        return {
            content: answer.content,
            followups: answer.followups ?? [],
            generationFailed: answer.generationFailed,
            provider: type,
            model,
        };
    }
    create() {
        const command = new Command('chat')
            .description('Start an interactive chat session with AI')
            .argument('[prompt]', 'Optional initial prompt')
            .option('-f, --file <path>', 'Include file content as context')
            .option('-p, --provider <provider>', 'Inference provider')
            .option('-m, --model <model>', 'Model to use (if omitted, an interactive picker will appear)')
            .option('--no-cache', 'Disable response caching')
            .option('-d, --dev', 'Always dispatch requests to the coding pipeline (no confirmation)', false)
            .action(async (prompt, options) => {
            await this.execute(prompt, options || {});
        });
        return command;
    }
    async execute(prompt, options) {
        // Apply the active model state from `buff model switch` as defaults
        const activeOpts = applyActiveModel({ provider: options?.provider, model: options?.model });
        const mergedOpts = { ...options, provider: activeOpts.provider, model: activeOpts.model };
        // ── Auto routing mode: agent decides the best provider/model per message ──
        let autoMode = isAutoModel(mergedOpts.model) || isAutoProvider(mergedOpts.provider);
        let { type, provider } = autoMode
            ? await this.getProvider({})
            : await this.getProvider(mergedOpts);
        let model = mergedOpts.model;
        // In interactive mode (no prompt), show the model picker if no --model was specified
        if (!model && !prompt) {
            const picked = await this.showModelPicker();
            if (!picked)
                return;
            // ── Auto picked — enable per-message routing ──────────────────────────
            // NEVER hand 'auto' to resolveProvider(): it would hit the "Unknown
            // provider 'auto'" fallback and silently pick the default provider
            // (e.g. OpenRouter with no key → 401). Auto is a routing directive, so
            // we set autoMode and resolve a concrete route below instead.
            if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                autoMode = true;
            }
            else {
                if (picked.provider !== type) {
                    const resolved = resolveProvider(this.configManager, picked.provider);
                    type = resolved.type;
                    provider = resolved.provider;
                }
                model = picked.model;
            }
        }
        // ── Auto mode: resolve a concrete initial route for the header + gate ──
        // (Each real message re-routes via routeMessageAuto before generating.)
        if (autoMode) {
            const routed = await this.routeMessageAuto('chat session');
            type = routed.type;
            provider = routed.provider;
            model = routed.model;
        }
        const available = await provider.isAvailable();
        if (!available) {
            logger.error(`${provider.name} is not available. Check your configuration.`);
            logger.info(`Run: agent-baba-d config --help`);
            return;
        }
        // ── Setup SIGINT (Ctrl+C) handler for graceful exit ──────────────
        // When readline is active (user is typing), Ctrl+C byte is consumed by readline's
        // raw mode — the process-level SIGINT never fires. So we put the double-press
        // logic inside readline's SIGINT handler instead (see readMultiLineInput).
        //
        // This process-level handler fires when the user is NOT in readline (e.g., during
        // API calls). A single Ctrl+C during an API call aborts it immediately.
        const sigintHandler = () => {
            console.log('\n');
            process.exit(0);
        };
        process.on('SIGINT', sigintHandler);
        const cacheEnabled = options?.cache !== false;
        if (prompt) {
            // ── Auto routing for single-shot prompts ────────────────────────────
            if (autoMode) {
                const routed = await this.routeMessageAuto(prompt);
                type = routed.type;
                provider = routed.provider;
                model = routed.model;
            }
            // E3c: model-decides — EVERY request runs as a TOOL-CALL TURN. The
            // rule assessment is a HINT in the model's context (buildToolSystemPrompt)
            // — the model decides what to do. Rules act
            // ONLY as the no-model fallback below (generation failed entirely), never
            // as a bypass.
            const parsed = parseRequestSync(prompt);
            const dispatchDecision = resolvePipelineDispatch(parsed, { dev: options?.dev, text: prompt });
            const answer = await this.runChatAnswer(prompt, [], { type, provider, model }, options || {}, cacheEnabled, { auto: autoMode }, parsed);
            // No-model fallback: the tool loop could not generate a single response
            // AND the rules assessed a high-confidence pipeline intent — run the
            // pipeline directly (rules decide only when the model is unavailable;
            // the pipeline resolves its own working provider/model).
            if (answer.generationFailed && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
                await runDeveloperMode(prompt, this.configManager, { provider: type, model });
                return;
            }
            // Ordering: the ANSWER is always printed first, then followups — the
            // user asked for the content, not a menu. On a real terminal the
            // followups are SELECTABLE: picking a number runs that followup as the
            // next turn (conversation threaded), pressing Enter ends the session.
            // Non-TTY (scripts/CI/pipes) keeps the current print-and-exit behavior
            // so automation is never blocked by a prompt.
            if (answer.content.trim()) {
                console.log('\n' + answer.content + '\n');
            }
            if (!process.stdin.isTTY) {
                await this.renderFollowups(answer.followups ?? [], false);
                return;
            }
            // Seed the continuation history with turn 1 so a picked followup has
            // context (runChatAnswer pushes the user message itself).
            const singleHistory = [
                { role: 'user', content: prompt },
                ...(answer.content.trim() ? [{ role: 'assistant', content: answer.content }] : []),
            ];
            let singleAnswer = answer;
            while (true) {
                const picked = await this.renderFollowups(singleAnswer.followups ?? [], true);
                if (!picked)
                    break;
                const next = await this.runChatAnswer(picked, singleHistory, { type, provider, model }, options || {}, cacheEnabled, { auto: autoMode }, parseRequestSync(picked));
                if (next.content.trim()) {
                    console.log('\n' + next.content + '\n');
                    singleHistory.push({ role: 'assistant', content: next.content });
                }
                singleAnswer = next;
            }
            return;
        }
        logger.highlight(`\n🧠 Buff Chat — ${autoMode ? '🤖 Auto routing' : provider.name}`);
        if (autoMode) {
            logger.info('Model: auto (best provider/model picked per message)');
        }
        else if (model) {
            logger.info(`Model: ${model}`);
        }
        logger.info(`Type your messages, or /help for commands, /exit to quit.`);
        logger.info(`💡 Tip: every request runs through the agent loop — the model decides what to do (code, fix, docs, publish, analysis). /dev prefers file-creating actions.\n`);
        // D2: agent-driven background duties — one-line health + models status at
        // session start (throttled, best-effort). The agent does them, not the user.
        await maybeRunBackgroundDuties(this.configManager).catch(() => { });
        const history = [];
        let effectiveModelForHistory = model || this.configManager.getProviderConfig(type).config.model || 'default';
        let effectiveModel = effectiveModelForHistory;
        this.devModeAuto = false;
        // K1: one chat session = one sessionId — created once, threaded through
        // the memory session AND every log line emitted by this session's turns.
        const chatSessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Phase B2: begin the persistent-memory session (provider.initialize).
        // The chat loop records each completed turn; endSession on exit distills
        // the buffered turns into project facts. Best-effort, fire-and-forget.
        try {
            await getMemoryManager().startSession(chatSessionId);
        }
        catch {
            // Best-effort — memory must never break chat startup.
        }
        let pendingMessage;
        while (true) {
            // E3b: a chosen follow-up recommendation becomes the next message.
            const message = pendingMessage ?? (await this.readMultiLineInput('You:'));
            pendingMessage = undefined;
            if (!message)
                continue;
            if (message.startsWith('/')) {
                // K1: /commands also ride the session correlation.
                const result = await withLogCorrelation({ sessionId: chatSessionId }, () => this.handleCommand(message, provider, model, type));
                if (result.exit)
                    break;
                if (result.auto) {
                    autoMode = true;
                    logger.success('🤖 Auto routing enabled — agent picks the best model per message');
                    console.log('');
                }
                else if (result.newProvider) {
                    type = result.newType;
                    provider = result.newProvider;
                    model = result.newModel;
                    effectiveModel = result.newModel || effectiveModelForHistory;
                    effectiveModelForHistory = effectiveModel;
                    autoMode = false; // explicit picker choice overrides auto routing
                    logger.success(`✅ Switched to ${provider.name} / ${model}`);
                    console.log('');
                }
                continue;
            }
            // ── Auto routing: pick the best provider/model for this message ──────
            // Runs BEFORE the dev-mode check so a creation request in auto mode uses
            // the routed provider/model — never a literal 'auto' or a stale default.
            if (autoMode) {
                // M2.5: estimate the growing conversation (prior turns + this message)
                // so context-fit routing reacts to a long session, not just the task
                // text. Estimation only — never a hard block.
                const historyEstimate = estimateTokens(history.map((h) => h.content).join('\n') + '\n' + message);
                const routed = await this.routeMessageAuto(message, [], { contextHintTokens: historyEstimate });
                type = routed.type;
                provider = routed.provider;
                effectiveModel = routed.model;
                effectiveModelForHistory = effectiveModel;
                model = effectiveModel;
            }
            // E3c: model-decides — EVERY message runs as a TOOL-CALL TURN; the model
            // decides what to do. The rule assessment is a
            // HINT in the model context — never a bypass. Rules act ONLY as the
            // no-model fallback below (generation failed entirely + high-confidence
            // pipeline intent), never to skip the loop. K1: the sessionId rides on
            // every log line from this turn's processing.
            // K2: rule-vs-LLM latency budget — time the C1 rule path (intent
            // parse + dispatch assessment) and the model path (tool-loop answer)
            // separately so the budget is measurable.
            const parsed = recordMetricTime('rule.parse.ms', () => parseRequestSync(message));
            const dispatchDecision = recordMetricTime('rule.dispatch.ms', () => resolvePipelineDispatch(parsed, { dev: this.devModeAuto, text: message }));
            const session = { type, provider, model: effectiveModel };
            const answer = await withLogCorrelation({ sessionId: chatSessionId }, () => recordMetricTime('llm.answer.ms', () => this.runChatAnswer(message, history, session, options || {}, cacheEnabled, { auto: autoMode }, parsed)));
            // No-model fallback: the tool loop could not generate a single response
            // AND the rules assessed a high-confidence pipeline intent — run the
            // pipeline directly (rules decide only when the model is unavailable).
            if (answer.generationFailed && dispatchDecision.dispatch && !dispatchDecision.needConfirm) {
                await runDeveloperMode(message, this.configManager, { provider: type, model });
                const continueAnswer = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'cont',
                        message: 'Press Enter to continue chatting, or type /exit to quit:',
                        prefix: '',
                    },
                ]);
                if (continueAnswer.cont.trim().toLowerCase() === '/exit' || continueAnswer.cont.trim().toLowerCase() === '/quit') {
                    console.log('Goodbye!');
                    break;
                }
                continue;
            }
            type = session.type;
            provider = session.provider;
            effectiveModel = session.model;
            effectiveModelForHistory = session.model || effectiveModelForHistory;
            model = effectiveModel;
            // Ordering: deliver the ANSWER first, then the follow-up menu (the
            // followup pick becomes the next message). The user asked for the
            // content — the menu must never print before it.
            if (answer.content.trim()) {
                console.log('\n' + answer.content + '\n');
            }
            const followupPrompt = await this.renderFollowups(answer.followups ?? [], true);
            if (followupPrompt) {
                pendingMessage = followupPrompt;
            }
            console.log('');
            continue;
        }
        // Cleanup SIGINT handler
        process.off('SIGINT', sigintHandler);
        // Phase B2: end the persistent-memory session — buffered turns are
        // distilled into project facts (best-effort; never blocks the exit path).
        try {
            await getMemoryManager().endSession();
        }
        catch {
            // Best-effort — memory extraction must never break chat exit.
        }
        // K2: persist runtime metrics (rule/LLM latency, memory hits/misses)
        // accumulated during this chat session.
        try {
            getMetrics().save();
        }
        catch {
            // Best-effort — a metrics write must never break chat exit.
        }
        // Store chat session in history when exiting
        if (history.length > 0) {
            try {
                const historyMessages = history.map((h) => ({
                    role: h.role,
                    content: h.content,
                    timestamp: Date.now(),
                }));
                const chatHistory = getChatHistory();
                const sessionId = chatHistory.storeSession(historyMessages, type, effectiveModelForHistory, true, deriveProjectId(process.cwd()).id);
                logger.debug(`Chat session stored: ${sessionId}`);
                // Phase A2: workspace continuity — record the session in the project
                // registry (the last user goal + last assistant summary + session id)
                // so `buff doctor` and the D1 auto-recall can show what this project
                // was last working on. Best-effort — a workspace write must never
                // affect the chat exit path.
                try {
                    const lastUser = [...history].reverse().find((h) => h.role === 'user');
                    const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant');
                    this.configManager.getWorkspaceStore().recordRun({
                        cwd: process.cwd(),
                        goal: lastUser?.content || 'chat session',
                        summary: lastAssistant?.content,
                        sessionId,
                    });
                }
                catch (wsErr) {
                    logger.debug(`Workspace record failed (non-critical): ${wsErr}`);
                }
            }
            catch (err) {
                // Non-critical — history storage failure shouldn't affect user experience
                logger.debug(`Failed to store chat session: ${err}`);
            }
        }
        // Actually exit the process — Commander keeps the event loop alive otherwise
        process.exit(0);
    }
    /**
     * E3b — run one chat answer as a TOOL-CALL TURN.
     *
     * The model may call ask_user (clarify), verify_requirement, the pipeline
     * tools (build/repair/resume), and must end with suggest_followups (3
     * followups, the contract). Native tool-calling when the provider
     * supports it; JSON fallback otherwise. Carries the legacy generation
     * machinery forward: auto-mode failover + shared fallback chain inside
     * callModel, caching, memory recording, and registry telemetry.
     *
     * Returns the final content + followups as DATA — the CALLER prints the
     * content first, then renders the followup menu (answer-first ordering;
     * interactive mode turns a chosen followup into the next message).
     */
    async runChatAnswer(message, history, session, options, cacheEnabled, mode, parsed, ctxOverrides) {
        // Cache check first (same as the legacy path).
        const cache = getCache();
        if (cacheEnabled) {
            try {
                const cachedResult = await cache.get(message, session.model ?? 'default', session.type);
                if (cachedResult) {
                    // NOTE: the cached answer is NOT printed here — the caller prints
                    // content AFTER runChatAnswer returns (answer-first ordering). A
                    // print here would show the answer before the turn's own progress
                    // lines AND double-print it.
                    history.push({ role: 'user', content: message });
                    history.push({ role: 'assistant', content: cachedResult });
                    this.memoryNoteTurn(message, cachedResult);
                    return { content: cachedResult };
                }
            }
            catch {
                // Cache must never break the turn.
            }
        }
        history.push({ role: 'user', content: message });
        // System prompt: base identity + the tool contract — the
        // model clarifies with ask_user and ends every response with followups.
        // E3c: the rule assessment rides in as a hint when the rules parsed a
        // confident intent (model decides; hint only).
        const systemText = buildToolSystemPrompt(parsed);
        // `-f/--file` file-context parity: the legacy generateWithContext loaded
        // + retrieval-reduced file context. Inject it as a context message before
        // the user's message so the tool-loop path keeps the flag working.
        let fileContext = null;
        if (options.file) {
            try {
                const parser = new ContextParser();
                const fileCtx = parser.parseFromFiles([options.file]);
                const fileCtxStr = ContextParser.formatContext(fileCtx);
                const retrievalOpts = retrievalOptionsFromConfig(this.configManager);
                const { context: reduced, stats } = await assembleContext(message, [options.file], fileCtxStr, retrievalOpts);
                recordRetrievalStats(stats);
                fileContext = reduced;
            }
            catch {
                // A file-context failure must never break the turn.
                fileContext = null;
            }
        }
        const thread = [
            { role: 'system', content: systemText },
            ...(fileContext
                ? [{ role: 'user', content: `[File context]\n${fileContext}` }]
                : []),
            ...history
                .slice(0, -1)
                .map((h) => ({
                role: (h.role === 'assistant' ? 'assistant' : 'user'),
                content: h.content,
            })),
            { role: 'user', content: message },
        ];
        // I3: one artifact session per TURN — every tool
        // deliverable in this turn lands in the same store folder.
        const artifactSessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toolContext = {
            configManager: this.configManager,
            cwd: process.cwd(),
            emit: (event, data, source) => {
                // P0.6 — forward tool-call lifecycle events to the GUI before they
                // reach the bus (the bus drives hooks; the override drives the card
                // stream). Other events keep flowing to the bus untouched.
                if (ctxOverrides?.onToolCall && (event === 'tool:started' || event === 'tool:called')) {
                    ctxOverrides.onToolCall(event === 'tool:started' ? 'started' : 'called', data);
                }
                // P0.7 — forward plan mutations to the GUI (structured checklist).
                if (ctxOverrides?.onPlanChange && event === 'plan:changed') {
                    ctxOverrides.onPlanChange(data);
                }
                // P3b — forward git diff payloads to the GUI (the diff card).
                if (ctxOverrides?.onGitDiff && event === 'git:diff') {
                    ctxOverrides.onGitDiff(data);
                }
                getEventBus().emit(event, data, source);
            },
            // P3 — the dashboard chat console injects a NON-TTY ask_user renderer
            // (inquirer would hang on the server's piped stdin); the CLI keeps the
            // default interactive renderer.
            ...(ctxOverrides?.askUser ? { askUser: ctxOverrides.askUser } : {}),
            ...(ctxOverrides?.gateway ? { gateway: ctxOverrides.gateway } : {}),
            // C2 verify with the actual session model (verify_requirement tool).
            callLLM: (prompt, opts) => session.provider.generate(prompt, { ...opts, model: session.model }),
            // I3: tools that return {artifact, result} deliverables are recorded to
            // the per-turn artifact session. Best-effort — a persistence failure
            // must never break the turn.
            artifacts: {
                push: (a) => {
                    try {
                        new ArtifactStore().append(artifactSessionId, a);
                        logger.debug(`artifact: ${a.kind} '${a.title}' → ${a.path}`);
                    }
                    catch {
                        // best-effort
                    }
                },
            },
        };
        const callModel = this.buildToolCallModel(message, session, options, mode);
        let result;
        try {
            result = await runToolLoop({
                messages: thread,
                context: toolContext,
                maxSteps: 8,
                deps: {
                    callModel,
                    executeTool: async (name, args, ctx) => {
                        const tool = getTool(name);
                        if (!tool)
                            throw new Error(`Unknown tool: ${name}`);
                        return tool.run(args, ctx);
                    },
                    onEvent: (line) => {
                        // Clean output: the suggest_followups call is captured through the
                        // followups sink and rendered as the pickable menu — the raw tool
                        // JSON must never print as a progress line (v1.73 clean-messaging
                        // parity for the CLI + dashboard console).
                        if (line.includes('suggest_followups'))
                            return;
                        logger.info(line);
                        // P3 — live progress for the dashboard chat console (the CLI
                        // keeps logging to its own stdout).
                        ctxOverrides?.onProgress?.(line);
                    },
                },
            });
        }
        catch (err) {
            // The tool loop never throws by design; this guards future changes.
            logger.error(String(err));
            result = {
                content: `I ran into a problem: ${err instanceof Error ? err.message : String(err)}`,
                followups: [],
                toolCalls: [],
                steps: 0,
                bounded: false,
            };
        }
        // Finalize the turn (cache + memory + registry telemetry).
        // E3c: a generationFailed turn is NOT cached/persisted — the caller may
        // fall back to the rule decision, and the failure text must not pollute
        // history or the cache.
        if (result.content.trim() && !result.generationFailed) {
            if (cacheEnabled) {
                try {
                    await cache.set(message, result.content, session.model ?? 'default', session.type);
                }
                catch {
                    // Best-effort.
                }
            }
            history.push({ role: 'assistant', content: result.content });
            this.memoryNoteTurn(message, result.content);
            try {
                recordRegistrySuccess(session.type, session.model, 'chat');
            }
            catch {
                // Best-effort.
            }
        }
        // Followups are rendered by the CALLER (after the answer is printed) so
        // the menu never appears before the content. We return them as data.
        return {
            content: result.content,
            generationFailed: result.generationFailed,
            followups: result.followups,
        };
    }
    /**
     * E3b — the model-call step for the tool loop:
     * native generateTools when the provider supports it, JSON fallback
     * otherwise. Auto-mode failover + the shared fallback chain live here — a
     * broken provider never crashes the turn (it answers from the next working
     * candidate, exactly like the legacy generation block).
     */
    buildToolCallModel(message, session, options, mode) {
        return async (messages, schemas) => {
            const tryGenerate = async (prov, typ, mdl) => {
                if (typeof prov.generateTools === 'function' && schemas.length > 0) {
                    try {
                        return await prov.generateTools(messages, schemas, { ...options, model: mdl });
                    }
                    catch (err) {
                        // S3: a tool-call 400 often carries the model's COMPLETE answer in
                        // `failed_generation` (the API rejected only the CALL). Salvage it
                        // instead of losing the turn to failover/error — the essay was
                        // sitting in the error payload and was being thrown away.
                        const salvaged = salvageFailedGeneration(err);
                        if (salvaged) {
                            logger.warn("   ⚠️ Tool call rejected (400) — salvaging the model's generated answer.");
                            // Re-run the recovered suggest_followups through the normal tool
                            // path so the followups land in the sink (and the loop's
                            // end-of-response early return fires on the substantive content).
                            const toolCalls = salvaged.followups?.length
                                ? [{ id: 'call_salvage_1', name: 'suggest_followups', arguments: { followups: salvaged.followups } }]
                                : [];
                            return { content: salvaged.content, toolCalls };
                        }
                        throw err;
                    }
                }
                // JSON fallback transport: flatten the thread into one prompt with
                // the compact argument shapes appended (S2 — shared helper, so
                // execute/plan-style loops that add tool calling get the same fix).
                const prompt = buildJsonFallbackPrompt(messages, schemas);
                let raw;
                if (typeof prov.generateStream === 'function') {
                    const chunks = [];
                    await prov.generateStream(prompt, { ...options, model: mdl }, (t) => chunks.push(t));
                    raw = chunks.join('');
                }
                else {
                    raw = await prov.generate(prompt, { ...options, model: mdl });
                }
                const { text, calls } = extractFallbackToolCalls(raw);
                return { content: text, toolCalls: calls };
            };
            try {
                return await tryGenerate(session.provider, session.type, session.model);
            }
            catch (err) {
                // Auto mode: fail over across the ranked candidates (never stuck).
                if (mode.auto) {
                    const firstType = session.type;
                    // Observable telemetry, identical to the shared single-shot runner
                    // (the E2E repair-failover contract): one warn per walk, one
                    // success log per landed candidate.
                    logger.warn(`   ⚠️ ${session.provider.name} failed — trying the next auto candidate...`);
                    const failed = new Set([session.type]);
                    for (let i = 0; i < 3; i++) {
                        let next = null;
                        try {
                            next = await this.routeMessageAuto(message, [...failed]);
                        }
                        catch {
                            break;
                        }
                        if (!next || next.type === session.type || failed.has(next.type))
                            break;
                        failed.add(next.type);
                        // Opt-in confirmation (routing.promptOnFailover): 'manual' stops
                        // the walk and lets the caller's error recovery handle it. Gated on
                        // an interactive stdin (inherited from the shared single-shot
                        // runner) — a piped/CI input must never block on an inquirer
                        // prompt; it falls through to silent auto-failover instead.
                        if (shouldConfirmFailover(this.configManager.getAll()) && process.stdin.isTTY) {
                            try {
                                const choice = await promptFailoverChoice(session.provider.name, next.provider.name, next.model);
                                if (choice === 'manual')
                                    break;
                            }
                            catch {
                                // Fall through to the candidate.
                            }
                        }
                        try {
                            const resp = await tryGenerate(next.provider, next.type, next.model);
                            session.type = next.type;
                            session.provider = next.provider;
                            session.model = next.model;
                            logger.success(`✅ Auto failover: answered from ${next.provider.name} (${next.model}) after ${firstType} failed`);
                            return resp;
                        }
                        catch {
                            // Next candidate.
                        }
                    }
                }
                else if (isRetryableError(classifyFallbackError(err))) {
                    // Non-auto: walk the shared fallback chain (retryable errors only).
                    try {
                        const fallback = getProviderFallback(this.configManager, this.configManager.getAll().fallback);
                        const chain = fallback.getFallbackChain(session.type);
                        for (const fbType of chain) {
                            if (fbType === session.type)
                                continue;
                            try {
                                const resolved = resolveProvider(this.configManager, fbType);
                                return await tryGenerate(resolved.provider, resolved.type, session.model);
                            }
                            catch {
                                // Next fallback candidate.
                            }
                        }
                    }
                    catch {
                        // Fall through to rethrow.
                    }
                }
                throw err;
            }
        };
    }
    /**
     * E3b — render suggest_followups results. Interactive:
     * numbered options; choosing one sends its prompt as the next message.
     * Single-shot: printed after the answer.
     */
    async renderFollowups(followups, interactive) {
        if (!followups || followups.length === 0)
            return undefined;
        console.log('');
        logger.highlight('➡️  Next steps:');
        followups.forEach((f, i) => {
            console.log(`  ${i + 1}. ${f.label || f.prompt}`);
        });
        if (!interactive) {
            console.log('');
            return undefined;
        }
        console.log('');
        try {
            const answer = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'n',
                    message: 'Pick a number to continue, or press Enter to keep chatting:',
                    prefix: '',
                },
            ]);
            const idx = parseInt(answer.n.trim(), 10);
            if (idx >= 1 && idx <= followups.length) {
                return followups[idx - 1].prompt;
            }
        }
        catch {
            // The followup pick must never break the chat loop.
        }
        return undefined;
    }
    /**
     * Record a completed user↔assistant turn into the persistent-memory manager
     * (Phase B2). Best-effort and fire-and-forget: the provider only BUFFERS the
     * turn here (zero latency); extraction into project facts happens once at
     * session end. A memory failure must never break the chat loop.
     */
    memoryNoteTurn(userText, assistantText) {
        try {
            void getMemoryManager().recordTurn(userText, assistantText).catch(() => {
                // Best-effort — never break chat over memory.
            });
        }
        catch {
            // Best-effort — never break chat over memory.
        }
    }
    /**
     * Show a categorized model picker that groups models by capability.
     *
     * Example output:
     *
     *   🎯  Available Models
     *
     *   💬 Chat (General conversation)
     *    1. 🟢  llama-3.3-70b-versatile  ⭐ Best all-rounder — strong at...
     *    2. 🟢  gemma2-9b-it
     *
     *   💻 Code (Code generation, programming)
     *    3. 🔷  gemini-2.5-flash  ⭐ Latest Gemini — fast, multimodal...
     *
     *   Enter a number (0-8):
     */
    /**
     * Record an auto-mode provider failure so the session fails over instead of
     * getting stuck on a broken provider (the core of "auto routing should pick
     * another provider when the current one dies mid-session").
     *
     * Delegates to the SHARED failure-bookkeeping helper (Nuvira-Router M0.2
     * Stage A) so every action composes the exact same bookkeeping: session
     * exclusion (auth = whole session, rate-limit = short cooldown, transient =
     * short cooldown + re-verify marker), quota-ledger parking on rate-limit,
     * registry write-through (per-action telemetry), quota-timeline event, and
     * the shared circuit breaker. Best-effort: never throws.
     */
    recordAutoProviderFailure(providerType, err, model, apiKey) {
        recordActionFailure({
            sessionFailedProviders: this.sessionFailedProviders,
            sessionTransientFailedProviders: this.sessionTransientFailedProviders,
        }, providerType, err, this.configManager, { model, action: 'chat', apiKey });
    }
    async showModelPicker() {
        return showModelPicker(this.configManager);
    }
    /**
     * Resolve the best provider/model for a message via the AutoModelRouter.
     * Returns the routed type/provider/model; the caller applies them to the
     * active session state.
     */
    /**
     * Resolve the best provider/model for a message via the AutoModelRouter.
     *
     * ONLY AVAILABLE providers are returned: the router itself already excludes
     * unconfigured providers (no API key), and this method additionally walks
     * the ranked candidates and picks the first one whose isAvailable() passes —
     * so Auto routing never sends a request to a provider that would 401.
     */
    async routeMessageAuto(message, excludeProviders = [], opts) {
        // Feed the SHARED circuit breaker into the router so a provider that has
        // failed repeatedly (recorded by recordFailure below) is deprioritized by
        // scoring, not just skipped by the candidate walk.
        let circuitBreakerStatus = [];
        try {
            circuitBreakerStatus = getProviderFallback(this.configManager).getCircuitBreakerStatus();
        }
        catch {
            // Best-effort — routing must never crash on circuit-breaker bookkeeping
        }
        // ISSUE-003: ONE resolve-options assembly for every action point. The
        // shared helper supplies the full chat/orchestrator feature set (bandit
        // learning ON by default, quota-ledger status, runtime stats, cost/speed/
        // reasoning floors, paid-model gate, context preflight); chat layers its
        // circuit-breaker state on top.
        // C3: the NLU parser seeds the router task-intent (same vocabulary every
        // action command derives from resolveDispatch) when confident.
        const parsed = parseRequestSync(message);
        const dispatch = resolveDispatch(parsed);
        const decision = getAutoRouter().resolve('chat', message, {
            ...buildAutoResolveOptions(this.configManager, {
                verbose: process.env.BUFF_DEBUG === 'true',
                contextHintTokens: opts?.contextHintTokens,
            }),
            circuitBreakerStatus,
            ...(dispatch.taskIntentHint ? { taskIntentHint: dispatch.taskIntentHint } : {}),
        }, this.configManager);
        // Walk the ranked candidates (winner first) and return the first available
        // provider — never a provider that lacks a key or endpoint. Providers that
        // already failed this message (excludeProviders) OR earlier in this session
        // with an ACTIVE exclusion (sessionFailedProviders, time-based) are skipped
        // so runtime failover walks forward instead of repeating a known-broken
        // provider. Expired rate-limit exclusions re-admit the provider.
        const exclusionTime = Date.now();
        const isActiveExclusion = (p) => {
            const expiresAt = this.sessionFailedProviders.get(p);
            return expiresAt !== undefined && expiresAt > exclusionTime;
        };
        // ── Cold-start probe (suggestion 3) ─────────────────────────────────────
        // A fresh registry has zero verified models → routing would fall back to
        // credential-based defaults and possibly fail into dead ends. Fire ONE
        // background probe+spot-check so the registry learns from real API data.
        if (!this.coldStartProbeFired) {
            this.coldStartProbeFired = true;
            try {
                const registry = getModelRegistry();
                if (registry.getUsableProviders().length === 0) {
                    // Fire-and-forget: never block the first message on probe network I/O.
                    void refreshModelRegistry(this.configManager, { spotCheck: true }).catch(() => {
                        // Best-effort — cold-start probing must never break chat.
                    });
                }
            }
            catch {
                // Best-effort.
            }
        }
        // ── Re-verify before re-admit (suggestion 2) ───────────────────────────
        // A provider whose TRANSIENT exclusion just expired is only re-admitted
        // after a quick on-demand spot-check confirms it's actually back — the
        // registry may still mark it unavailable (learned from the failure), and
        // blindly re-admitting would fail again on the very next message. Recovery
        // is discovered in SECONDS (a 1-token spot-check), not by re-failing.
        // NOTE: iterate a SNAPSHOT — the loop mutates the set (delete + re-add),
        // and Set iteration can revisit a re-added key, double-spot-checking.
        // Bounded: at most one spot-check per provider per 60s (the exclusion is
        // re-armed on failure), and only for registry-blocked providers.
        for (const providerType of [...this.sessionTransientFailedProviders]) {
            const expiresAt = this.sessionFailedProviders.get(providerType);
            // Skip still-active exclusions and already-cleared providers.
            if (expiresAt !== undefined && expiresAt > exclusionTime)
                continue;
            this.sessionTransientFailedProviders.delete(providerType);
            this.sessionFailedProviders.delete(providerType);
            try {
                const registry = getModelRegistry();
                // Only re-verify when the registry still believes the provider is dead
                // (unavailable/parked) — a healthy entry means it recovered already.
                if (!registry.getBlockedProviders().includes(providerType))
                    continue;
                const desired = getAutoRouter().resolveModel(providerType, 'chat', this.configManager);
                const outcome = await spotCheckModel(providerType, desired, this.configManager);
                // 'skipped' = the model was VERIFIED recently (within the spot-check
                // throttle) — that's healthy, so treat it as a pass too.
                if (outcome !== 'verified' && outcome !== 'skipped') {
                    // Still down — keep it excluded for another transient window.
                    this.sessionFailedProviders.set(providerType, Date.now() + TRANSIENT_FAILURE_EXCLUSION_MS);
                    this.sessionTransientFailedProviders.add(providerType);
                }
            }
            catch {
                // Best-effort — re-verification must never break routing.
            }
        }
        const excluded = new Set([
            ...excludeProviders,
            ...[...this.sessionFailedProviders.keys()].filter((p) => isActiveExclusion(p)),
        ]);
        // Predictive skip from the Model Availability Registry: providers whose
        // every tracked model the registry marks unavailable/quota-parked (learned
        // from real usage telemetry) are never even attempted — sub-ms, no
        // network, no failing call. This is what turns "fail gemini → fail nim →
        // local" on every message into "straight to local" after the first learn.
        let registryBlocked = new Set();
        try {
            registryBlocked = new Set(getModelRegistry().getBlockedProviders());
        }
        catch {
            // Best-effort — registry bookkeeping must never break routing
        }
        const candidates = [
            decision.provider,
            ...decision.ranked
                .filter((r) => r.provider !== decision.provider)
                .map((r) => r.provider),
        ].filter((p) => !excluded.has(p) && !registryBlocked.has(p));
        for (const candidate of candidates) {
            try {
                const resolved = resolveProvider(this.configManager, candidate);
                if (await resolved.provider.isAvailable()) {
                    const desired = candidate === decision.provider
                        ? decision.model
                        : getAutoRouter().resolveModel(candidate, 'chat', this.configManager);
                    // Model health: only use models that actually exist on the provider.
                    // A provider's pinned config.model can be deprecated or a placeholder
                    // (e.g. gemini-2.0-flash-exp → 404) — repair to a live model.
                    const model = await resolveWorkingModel(resolved.provider, candidate, desired);
                    // Record the actually-used route for the dashboard audit trail
                    recordRoutingDecision({
                        source: 'chat',
                        agentType: 'chat',
                        task: message,
                        complexity: decision.complexity,
                        provider: candidate,
                        model,
                        score: decision.score,
                    });
                    return {
                        type: resolved.type,
                        provider: resolved.provider,
                        model,
                        ranked: candidates,
                        complexity: decision.complexity,
                        score: decision.score,
                    };
                }
            }
            catch {
                // Unresolvable candidate — try the next one
            }
        }
        // Nothing available — surface a usable pick so the caller's isAvailable()
        // gate shows a clear, actionable error. Prefer the best-ranked provider
        // that has NOT failed this session and is NOT registry-blocked (the
        // literal router winner could be a provider whose key just died —
        // re-surfacing it would re-fail and confuse the user instead of failing
        // over).
        const usableProvider = [decision.provider, ...decision.ranked.map((r) => r.provider)]
            .find((p) => !isActiveExclusion(p) && !registryBlocked.has(p)) || decision.provider;
        recordRoutingDecision({
            source: 'chat',
            agentType: 'chat',
            task: message,
            complexity: decision.complexity,
            provider: usableProvider,
            model: decision.model,
            score: decision.score,
        });
        const resolved = resolveProvider(this.configManager, usableProvider);
        const model = await resolveWorkingModel(resolved.provider, usableProvider, decision.model);
        return {
            type: resolved.type,
            provider: resolved.provider,
            model,
            ranked: candidates,
            complexity: decision.complexity,
            score: decision.score,
        };
    }
    /**
     * Read multi-line input from stdin using readline.
     *
     * - First line prompt: "You: "
     * - Continuation lines prompt: "  > "
     * - Pressing Enter with no text on the first line re-prompts
     * - An empty line after non-empty input submits the message
     * - This allows pasting multi-line text (each line collected), then Enter to submit
     */
    readMultiLineInput(prompt) {
        return new Promise((resolve) => {
            const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: prompt + ' ',
                // Don't let readline handle SIGINT — we handle it at process level
                terminal: true,
            });
            const lines = [];
            let isFirstLine = true;
            // Handle SIGINT on readline:
            // - If user was typing: cancel input and re-prompt
            // - If on empty line: first press shows warning, second press within 2s exits
            let rlSigintCount = 0;
            let rlSigintTimer = null;
            rl.on('SIGINT', () => {
                if (lines.length > 0 || !isFirstLine) {
                    // User was typing something — cancel input and re-prompt
                    lines.length = 0;
                    isFirstLine = true;
                    if (rlSigintTimer)
                        clearTimeout(rlSigintTimer);
                    rlSigintCount = 0;
                    rl.setPrompt(prompt + ' ');
                    rl.prompt();
                    return;
                }
                // No input yet — handle double-press
                rlSigintCount++;
                if (rlSigintCount >= 2) {
                    // Second press — exit cleanly
                    console.log('');
                    lines.push('/exit');
                    rl.close();
                    return;
                }
                // First press — show warning
                console.log('\n\n⚠️  Press Ctrl+C again to exit, or type /exit to quit.\n');
                rl.prompt(true);
                if (rlSigintTimer)
                    clearTimeout(rlSigintTimer);
                rlSigintTimer = setTimeout(() => {
                    rlSigintCount = 0;
                }, 2000);
            });
            rl.on('line', (line) => {
                if (isFirstLine) {
                    isFirstLine = false;
                    if (line === '') {
                        // Just pressed Enter on first line with no text — re-prompt
                        rl.prompt();
                        isFirstLine = true;
                        return;
                    }
                    lines.push(line);
                    // Commands (starting with '/') should submit immediately — no continuation needed
                    if (line.startsWith('/')) {
                        rl.close();
                        return;
                    }
                    rl.setPrompt('  > ');
                    rl.prompt();
                }
                else {
                    if (line === '') {
                        // Empty line on continuation — submit the full message
                        rl.close();
                    }
                    else {
                        lines.push(line);
                        rl.prompt();
                    }
                }
            });
            rl.on('close', () => {
                resolve(lines.join('\n'));
            });
            rl.prompt();
        });
    }
    async handleCommand(cmd, provider, model, currentType) {
        switch (cmd.toLowerCase()) {
            case '/exit':
            case '/quit':
                console.log('Goodbye!');
                return { exit: true };
            case '/help':
                console.log(`
Commands:
  /exit, /quit          Exit the chat
  /clear                Clear conversation history
  /info                 Show provider & model info
  /help                 Show this help
  /dev                  Toggle developer mode (auto-create files)
  /search <query>       Search past conversations by keyword
  /model                Switch providers/models mid-session
        `.trim());
                return { exit: false };
            case '/clear':
                console.log('Conversation history cleared.');
                return { exit: false };
            case '/info':
                console.log(`\n${provider.getInfo()}${model ? `\n  Model: ${model}` : ''}\n`);
                return { exit: false };
            case '/dev':
                this.devModeAuto = !this.devModeAuto;
                if (this.devModeAuto) {
                    logger.success('✅ Developer mode ACTIVATED — the rule hint prefers file-creating pipeline actions.');
                }
                else {
                    logger.info('ℹ️  Developer mode DEACTIVATED — the model decides freely; rules are hints only.');
                }
                return { exit: false };
            case '/model': {
                const picked = await showModelPicker(this.configManager);
                if (!picked) {
                    logger.info('Model selection cancelled.');
                    return { exit: false };
                }
                // ── Auto selected — enable auto routing ──────────────────────
                if (picked.provider === 'auto' || isAutoModel(picked.model)) {
                    return { exit: false, auto: true };
                }
                const resolved = resolveProvider(this.configManager, picked.provider);
                if (resolved.type !== currentType || picked.model !== model) {
                    return {
                        exit: false,
                        newType: resolved.type,
                        newProvider: resolved.provider,
                        newModel: picked.model,
                    };
                }
                return { exit: false };
            }
            case '/search': {
                let searchQuery = cmd.slice(8).trim();
                let useSemantic = false;
                if (searchQuery.startsWith('--semantic ')) {
                    useSemantic = true;
                    searchQuery = searchQuery.slice(11).trim();
                }
                if (!searchQuery) {
                    console.log('Usage:');
                    console.log('  /search <query>               Keyword search (default)');
                    console.log('  /search --semantic <query>    Semantic search (using local embeddings)');
                    console.log('');
                    console.log('Examples:');
                    console.log('  /search authentication');
                    console.log('  /search --semantic how to add JWT auth to Express');
                    return { exit: false };
                }
                const chatHistory = getChatHistory();
                const results = useSemantic
                    ? await chatHistory.searchSemantic(searchQuery, 5)
                    : chatHistory.search(searchQuery, 5);
                if (results.length === 0) {
                    logger.info(`No past conversations found matching "${searchQuery}".`);
                }
                else {
                    const mode = useSemantic ? '🧠' : '🔍';
                    const modeLabel = useSemantic ? ' (semantic)' : '';
                    logger.highlight(`${mode} Past conversations matching "${searchQuery}"${modeLabel}:`);
                    console.log('');
                    for (const session of results) {
                        console.log(chatHistory.formatSessionSummary(session));
                    }
                    console.log('');
                    logger.info('Use `buff history show <session-id>` to view a full conversation.');
                }
                return { exit: false };
            }
            default:
                console.log(`Unknown command: ${cmd}. Type /help`);
                return { exit: false };
        }
    }
}
//# sourceMappingURL=chat.js.map