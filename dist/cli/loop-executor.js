/**
 * Loop executor (`src/cli/loop-executor.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.1: "Make `runToolLoop` the executor behind coding-intent
 * dispatch (…extend to `nuvira execute` default path behind
 * `--engine loop|pipeline`, default `pipeline` until Phase 0 numbers land)."
 *
 * `nuvira execute` currently goes straight to the Orchestrator. This module
 * is the LOOP arm: one agentic turn over the same `runToolLoop` the chat
 * engine uses, with the ambient project-context injection + tiered tool
 * exposure the chat path already has. The orchestrator stays the DEFAULT
 * until the Phase 0 eval numbers land; this arm ships complete so
 * `--engine loop` is a real path, not a stub.
 *
 * Engine selection (Phase 2) happens in the CALLER (`execute` dispatch):
 * `resolveEngine()` decides loop vs pipeline from the routed provider tier;
 * this module is deliberately single-responsibility (it IS the loop arm).
 *
 * Telemetry parity with the eval framework: the executor returns wall-clock
 * time, per-tool call counts, errored-tool names (captured from the
 * `tool:called` events, not guessed from content), the bounded flag, and the
 * generation-failed flag so Phase 0 can compare arms on identical metrics.
 *
 * Phase 1.3 guardrail note (v4 risk table): file ops stay deny-first /
 * confirm-gated (registry tools keep their own gates) and the orchestrator
 * remains available for CI/publish — enterprise semantics are not weakened.
 */
import { resolveProvider } from './router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { getAutoRouter, isAutoModel, isAutoProvider } from '../learning/auto-router.js';
import { buildDeepFailoverPool, createFailoverExclusionFilter } from '../learning/resilient-call.js';
import { recordActionFailure } from '../learning/failure-bookkeeping.js';
import { recordRegistrySuccess, getProviderFallback, classifyFallbackError, isRetryableError, } from '../learning/provider-fallback.js';
import { resolveThreadBudgetChars } from '../learning/context-budget.js';
import { buildLoopProjectContext } from '../tools/loop-project-context.js';
import { getLoopExposureMode } from '../tools/toolsets.js';
import { resolveModelHarnessProfile } from '../learning/model-harness.js';
import { resolveEngine } from '../learning/engine-router.js';
import { logger } from '../utils/logger.js';
import { toUserFacingGenerationError } from '../inference/tool-call-utils.js';
/** The system prompt for the execute-loop arm (verification-first). */
function buildExecuteLoopSystemPrompt(toolContractJson) {
    return [
        'You are Nuvira, executing a coding task end-to-end. You have the project\'s tool surface: read files, edit/write files, search code, run terminal commands (typecheck/tests/build), plan with plan_todo, and delegate subtasks.',
        'Work autonomously: understand the code first (read_file/code_search), make the change (edit_file/write_file), then VERIFY by running typecheck/tests with run_terminal. Fix what fails and re-verify.',
        'When the task is complete, summarize what changed and why. End with suggest_followups listing sensible next steps.',
        '',
        'Some tools live in domain toolsets outside your visible list — if a tool you need is "unknown", call tool_search with {"action":"load","toolset":"<name>"} and its tools become callable immediately.',
        '',
        toolContractJson,
    ].join('\n');
}
/**
 * Run one coding goal through the single agentic loop (the v4 universal
 * engine). Resolves the route the same way chat does (explicit override or
 * AutoModelRouter candidate walk), injects the ambient project context, and
 * runs `runToolLoop` with tiered exposure per config. Never throws — a
 * failure returns a result with generationFailed=true (eval arms count it as
 * a loss; the CLI prints the message).
 */
export async function runLoopExecutor(goal, configManager, opts = {}) {
    const startedAt = Date.now();
    // ── Route: explicit provider/model wins; otherwise the AutoModelRouter ──
    let providerType = 'auto';
    let model = 'default';
    let provider = null;
    // ── Mid-turn failover candidate pool ────────────────────────────────────
    // The SAME deep chain the orchestrator/chat walk. Before this the loop only
    // used the chain to pick its STARTING provider: a 429 on the second step
    // killed the whole turn (observed live on gemini free tier) and the failure
    // was never recorded, so the next run repeated the same pick. callModel now
    // walks this pool and writes every failure through the shared bookkeeping.
    const candidatePairs = [];
    const seenCandidate = new Set();
    const pushCandidate = (prov, mdl) => {
        if (!prov)
            return;
        const m = mdl && mdl !== 'default' ? mdl : 'default';
        const key = `${prov}|${m}`;
        if (seenCandidate.has(key))
            return;
        seenCandidate.add(key);
        candidatePairs.push({ provider: prov, model: m });
    };
    /**
     * True when the caller explicitly pinned a provider (`--provider X`). A pin
     * narrows WHICH failures justify leaving the requested provider (see the
     * retryable gate in `callModel`); it never disables failover entirely.
     */
    const pinnedRun = Boolean(opts.provider && !isAutoProvider(opts.provider));
    /** Per-turn failure session — same composition every other action uses. */
    const failureSession = {
        sessionFailedProviders: new Map(),
        sessionTransientFailedProviders: new Set(),
        sessionFailedModels: new Map(),
    };
    try {
        if (opts.provider && !isAutoProvider(opts.provider)) {
            const resolved = resolveProvider(configManager, opts.provider);
            providerType = resolved.type;
            provider = resolved.provider;
            model = opts.model && !isAutoModel(opts.model)
                ? opts.model
                : await resolveWorkingModel(provider, providerType, undefined);
            pushCandidate(providerType, model);
            // ── A PINNED RUN FAILS OVER TOO ──────────────────────────────────────
            // A pinned provider used to contribute a SINGLE candidate, so any
            // mid-turn failure killed the whole turn even though a fallback chain
            // was configured — the pin collapsed the deep pool into a one-shot. Walk
            // the SAME config-declared chain chat's non-auto path walks
            // (`fallback.providers` when set, otherwise the credentialed/verified
            // providers ranked dynamically), so `--provider X` still lands a
            // best-effort answer instead of dying on X's first bad step.
            try {
                const chain = getProviderFallback(configManager, configManager.getAll().fallback)
                    .getFallbackChain(providerType);
                const fbTypes = chain.filter((t) => t !== providerType);
                // SAME exclusion predicate the auto path applies (session/model
                // cooldowns + cross-pipeline memory + registry per-ENTRY usability):
                // a registry-parked or quarantined fallback is ordered LAST — never
                // dropped — so an all-excluded chain still makes the best attempt
                // instead of dying on the pin's first bad step. The PINNED provider
                // itself is never filtered: the user asked for it explicitly, and a
                // spot-check may be about to re-admit it.
                let ordered = fbTypes;
                try {
                    const isExcluded = createFailoverExclusionFilter();
                    ordered = [
                        ...fbTypes.filter((t) => !isExcluded(t)),
                        ...fbTypes.filter((t) => isExcluded(t)),
                    ];
                }
                catch {
                    // Exclusion is an optimization — an unavailable filter must never
                    // cost us the fallback chain itself.
                }
                for (const fbType of ordered)
                    pushCandidate(fbType);
            }
            catch {
                // Best-effort — an unconfigured fallback chain must never break a
                // pinned run (the pinned candidate alone is still a valid pool).
            }
        }
        else {
            const routed = await getAutoRouter().resolve('execute', goal, { verbose: !opts.quiet }, configManager);
            // Walk {provider, model} PAIRS to the first AVAILABLE one (the router
            // excludes unconfigured providers; isAvailable() is the gate). The pairs
            // come from the router's DEEP failover chain, so several models per
            // provider are reachable — a single model per provider meant a provider's
            // 2nd-best model was never tried (free tiers meter per-model, so siblings
            // are frequently still usable).
            const pairs = [];
            const seen = new Set();
            const push = (prov, mdl) => {
                if (!prov)
                    return;
                const model = mdl && mdl !== 'default' ? mdl : 'default';
                const key = `${prov}|${model}`;
                if (seen.has(key))
                    return;
                // NOTE: deliberately NO registry-usability skip here — `resolveWorkingModel`
                // below owns model health and repairs a dead/parked model to a live one
                // on the SAME provider. Filtering the candidate out first would skip the
                // whole provider and bypass that repair. The chain already ranks healthy
                // models first, so a parked pick is only ever the last resort.
                seen.add(key);
                pairs.push({ provider: prov, model });
            };
            // SAME deep pool the orchestrator and chat walk (primary → model-first
            // tiered pool → router chain incl. reserve → ranked → config fallback),
            // so execute no longer reaches fewer models than the other paths.
            const pool = buildDeepFailoverPool(routed, {
                taskDescription: goal,
                configManager,
            });
            for (const c of pool)
                push(c.provider, c.model);
            // SAME exclusion predicate the orchestrator's resilient walk uses: skip
            // models the registry marks unusable/parked (per ENTRY — a parked model's
            // siblings stay reachable) and models that failed in an earlier run
            // (cross-pipeline memory; entries self-expire, so a healed model is picked
            // again). Tried in TWO passes so "reject only when nothing is left" holds:
            // excluded candidates are attempted last, never dropped, so an
            // all-excluded pool still makes the best attempt instead of failing with
            // "no available provider".
            const isExcluded = createFailoverExclusionFilter();
            const ordered = [
                ...pairs.filter((p) => !isExcluded(p.provider, p.model)),
                ...pairs.filter((p) => isExcluded(p.provider, p.model)),
            ];
            // Hand the whole ordered chain to the mid-turn walk.
            for (const pair of ordered)
                pushCandidate(pair.provider, pair.model);
            for (const pair of ordered) {
                try {
                    const resolved = resolveProvider(configManager, pair.provider);
                    if (await resolved.provider.isAvailable()) {
                        const desired = pair.model !== 'default'
                            ? pair.model
                            : getAutoRouter().resolveModel(pair.provider, 'execute', configManager);
                        providerType = resolved.type;
                        provider = resolved.provider;
                        model = await resolveWorkingModel(resolved.provider, resolved.type, desired);
                        break;
                    }
                }
                catch {
                    // Next candidate.
                }
            }
        }
    }
    catch (err) {
        return failureResult(
        // User-facing reason is sanitized (no provider wire text); the raw error
        // rides along as the technical explanation below.
        toUserFacingGenerationError(err), startedAt, opts.provider ?? 'auto', opts.model ?? 'default', `routing failed before an engine decision was possible: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!provider) {
        return failureResult('No available provider for the loop engine (check API keys / local runner).', startedAt, opts.provider ?? 'auto', opts.model ?? 'default', 'no available provider after the candidate walk');
    }
    // ── Engine decision (Phase 2): audit-trail echo for the caller/telemetry ──
    // The CALLER decides loop-vs-pipeline with the same function; this echo
    // keeps the executor's telemetry self-describing (dashboard badge parity).
    let engineExplanation = '';
    try {
        engineExplanation = resolveEngine({ provider: providerType, model }).explanation;
    }
    catch {
        engineExplanation = 'engine decision unavailable';
    }
    if (!opts.quiet)
        logger.debug(`Engine: ${engineExplanation}`);
    // ── Ambient project context (Phase 1.4 — same block the chat engine uses) ──
    let projectContext;
    if (!opts.skipProjectContext) {
        try {
            const built = await buildLoopProjectContext(process.cwd());
            if (built)
                projectContext = built;
        }
        catch {
            projectContext = undefined; // best-effort — never breaks the turn
        }
    }
    // ── Loop-side skill match hint (Phase 3.2 — chat/execute parity) ─────────
    // The orchestrator consults SkillStore.findMatch + the hub catalog before
    // planning; the execute loop never heard about that layer. One
    // deterministic, best-effort match is appended to the system prompt
    // (methodology + exact skill-tool load syntax, bounded to ONE block). A
    // failure returns '' and the prompt is byte-identical to pre-3.2.
    let skillHint = '';
    if (!opts.skipSkillHint) {
        try {
            const { buildLoopSkillHint, markLoopSkillUsed } = await import('../tools/loop-skill-hint.js');
            const injected = { value: null };
            skillHint = await buildLoopSkillHint(goal, configManager, injected);
            if (injected.value) {
                void markLoopSkillUsed(injected.value);
                if (!opts.quiet)
                    logger.info(`   🧠 Matched skill '${injected.value.name}' — methodology injected into the loop context`);
            }
        }
        catch {
            skillHint = ''; // best-effort — never breaks the turn
        }
    }
    const { runToolLoop } = await import('../tools/tool-loop.js');
    const { getTool, TOOL_CONTRACT_JSON } = await import('../tools/registry.js');
    const thread = [
        { role: 'system', content: buildExecuteLoopSystemPrompt(TOOL_CONTRACT_JSON) + skillHint },
        ...(projectContext ? [{ role: 'user', content: `[Project context]\n${projectContext}` }] : []),
        { role: 'user', content: goal },
    ];
    const loadedExtraTools = new Set();
    const erroredTools = [];
    // Adapter cache — one `resolveProvider` per provider per turn.
    const resolvedProviders = new Map();
    const resolveAdapter = async (prov) => {
        const cached = resolvedProviders.get(prov);
        if (cached)
            return cached;
        const resolved = resolveProvider(configManager, prov);
        resolvedProviders.set(prov, resolved.provider);
        return resolved.provider;
    };
    /** Candidates that already failed in THIS turn (attempted, but tried last). */
    const failedPairs = new Set();
    const pairKey = (p, m) => `${p}|${m}`;
    /** One generation attempt on a concrete provider × model (native → JSON). */
    const tryOnce = async (prov, mdl, messages, schemas, abort) => {
        if (typeof prov.generateTools === 'function' && schemas.length > 0) {
            if (typeof prov.generateToolsStream === 'function' && opts.onToken) {
                return prov.generateToolsStream(messages, schemas, { model: mdl, signal: abort }, opts.onToken);
            }
            return prov.generateTools(messages, schemas, { model: mdl, signal: abort });
        }
        // JSON fallback transport — the shared helper the chat engine uses.
        const { buildJsonFallbackPrompt } = await import('../inference/tool-call-utils.js');
        const { extractFallbackToolCalls } = await import('../tools/tool-loop.js');
        const prompt = buildJsonFallbackPrompt(messages, schemas);
        let raw;
        if (typeof prov.generateStream === 'function') {
            const chunks = [];
            await prov.generateStream(prompt, { model: mdl, signal: abort }, (t) => {
                chunks.push(t);
                opts.onToken?.(t);
            });
            raw = chunks.join('');
        }
        else {
            raw = await prov.generate(prompt, { model: mdl, signal: abort });
        }
        const { text, calls } = extractFallbackToolCalls(raw);
        return { content: text, toolCalls: calls };
    };
    const callModel = async (messages, schemas, _stepOnToken, stepSignal) => {
        void _stepOnToken;
        const abort = stepSignal ?? opts.signal;
        // Walk order: the CURRENT pick first, then the rest of the deep chain.
        // Candidates that already failed this turn are attempted LAST (never
        // dropped), so an all-failed pool still makes the best attempt instead of
        // dying on "no candidate".
        const primary = { provider: providerType, model };
        const all = [];
        const seenAll = new Set();
        for (const c of [primary, ...candidatePairs]) {
            const k = pairKey(c.provider, c.model);
            if (seenAll.has(k))
                continue;
            seenAll.add(k);
            all.push(c);
        }
        const walk = [
            ...all.filter((c) => !failedPairs.has(pairKey(c.provider, c.model))),
            ...all.filter((c) => failedPairs.has(pairKey(c.provider, c.model))),
        ];
        let lastErr;
        for (const cand of walk) {
            if (abort?.aborted)
                break;
            const key = pairKey(cand.provider, cand.model);
            try {
                const prov = await resolveAdapter(cand.provider);
                if (typeof prov.isAvailable === 'function' && !(await prov.isAvailable())) {
                    failedPairs.add(key);
                    continue;
                }
                const desired = cand.model !== 'default'
                    ? cand.model
                    : getAutoRouter().resolveModel(cand.provider, 'execute', configManager);
                const mdl = await resolveWorkingModel(prov, cand.provider, desired);
                // Flip the loop's active provider/model to the candidate that answers,
                // so telemetry and the NEXT step's primary pick follow the winner.
                providerType = cand.provider;
                provider = prov;
                model = mdl;
                const resp = await tryOnce(prov, mdl, messages, schemas, abort);
                // Success attribution — the same per-action write-through chat/execute
                // use, so the provider × model is marked verified for real usage.
                recordRegistrySuccess(cand.provider, mdl, 'execute');
                return resp;
            }
            catch (err) {
                // An abort is a clean stop, not a generation failure — never fail over
                // (or book a failure) for the caller's own cancellation.
                if (abort?.aborted)
                    throw err;
                lastErr = err;
                failedPairs.add(key);
                // FULL shared bookkeeping: session exclusion → (rate-limit) ledger
                // park → registry write-through → quota timeline → circuit breaker.
                // This is what makes a mid-loop 429 LEARNED: the model rests and the
                // next run (and this turn's later steps) routes around it.
                try {
                    recordActionFailure(failureSession, cand.provider, err, configManager, {
                        model: cand.model !== 'default' ? cand.model : model,
                        action: 'execute',
                    });
                }
                catch {
                    // Best-effort — bookkeeping must never mask the generation error.
                }
                // ── PINNED-RUN GATE ────────────────────────────────────────────────
                // Leaving a provider the user EXPLICITLY asked for is only justified by
                // a failure another provider can plausibly answer — the same retryable
                // gate chat's non-auto path uses. An auth error (the key is dead) or a
                // deterministic request-shape rejection fails identically everywhere;
                // surfacing it beats silently running the user's job somewhere they did
                // not ask for. The failure is still recorded above, so the pin does not
                // blind the router to a dead key.
                if (pinnedRun && !isRetryableError(classifyFallbackError(err))) {
                    throw err;
                }
                if (!opts.quiet) {
                    logger.warn(`   \u26A0\uFE0F ${cand.provider} failed — trying the next loop candidate...`);
                }
            }
        }
        throw lastErr ?? new Error('no loop candidate could complete the step');
    };
    try {
        // R1 — the harness is fitted to the MODEL that will run, not just to
        // config: `getLoopExposureMode` alone hands a 0.5B local model the same
        // surface as gpt-oss:120b.
        const harness = resolveModelHarnessProfile({
            model,
            configExposure: getLoopExposureMode(configManager),
        });
        const result = await runToolLoop({
            messages: thread,
            maxSteps: opts.maxSteps ?? 16,
            // Model-window-aware thread budget: a 1M-token model keeps its whole
            // window instead of being trimmed to the fixed ~50K-token default.
            // Undefined (unknown window) leaves the tool-loop default untouched.
            threadBudgetChars: resolveThreadBudgetChars({ provider: providerType, model }),
            toolExposure: harness.exposure,
            maxParallelReads: harness.maxParallelReads,
            onToken: opts.onToken,
            signal: opts.signal,
            context: {
                configManager,
                loadedExtraTools,
                cwd: process.cwd(),
            },
            deps: {
                callModel,
                executeTool: async (name, args, ctx) => {
                    const tool = getTool(name);
                    if (!tool)
                        throw new Error(`Unknown tool: ${name}`);
                    const out = await tool.run(args, ctx);
                    // Errored-tool telemetry (Phase 0 repair-count proxy). Two failure
                    // conventions exist: the loop's `Error:` prefix (runtime throw) and
                    // the coding tools' `<name>: cannot|no such file …` verbs (missing
                    // file, unreadable path). A bare `<name>: ` prefix is NOT a failure
                    // signal — successful list_dir/read_file output legitimately starts
                    // with it — and soft refusals ("is a directory", "looks binary") are
                    // advisory, not failures. Telemetry only — never alters the text.
                    if (out.startsWith('Error:') ||
                        new RegExp(`^${name}: (cannot |no such file |denied)`).test(out)) {
                        erroredTools.push(name);
                    }
                    return out;
                },
                onEvent: opts.quiet ? undefined : (line) => logger.info(line),
            },
        });
        return {
            content: result.content,
            generationFailed: result.generationFailed ?? false,
            bounded: result.bounded,
            toolCalls: result.toolCalls,
            erroredTools,
            durationMs: Date.now() - startedAt,
            provider: providerType,
            model,
            engineExplanation,
        };
    }
    catch (err) {
        return failureResult(toUserFacingGenerationError(err), startedAt, providerType, model, `loop execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Build a failed result (shape-complete for the eval arm comparison). */
function failureResult(message, startedAt, provider, model, engineExplanation) {
    return {
        content: message,
        generationFailed: true,
        bounded: false,
        toolCalls: [],
        erroredTools: [],
        durationMs: Date.now() - startedAt,
        provider,
        model,
        engineExplanation,
    };
}
//# sourceMappingURL=loop-executor.js.map