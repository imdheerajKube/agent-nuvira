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
import { buildLoopProjectContext } from '../tools/loop-project-context.js';
import { getLoopExposureMode } from '../tools/toolsets.js';
import { resolveEngine } from '../learning/engine-router.js';
import { logger } from '../utils/logger.js';
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
    try {
        if (opts.provider && !isAutoProvider(opts.provider)) {
            const resolved = resolveProvider(configManager, opts.provider);
            providerType = resolved.type;
            provider = resolved.provider;
            model = opts.model && !isAutoModel(opts.model)
                ? opts.model
                : await resolveWorkingModel(provider, providerType, undefined);
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
        return failureResult(`Routing failed: ${err instanceof Error ? err.message : String(err)}`, startedAt, opts.provider ?? 'auto', opts.model ?? 'default', 'routing failed before an engine decision was possible');
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
    const callModel = async (messages, schemas, _stepOnToken, stepSignal) => {
        void _stepOnToken;
        if (typeof provider.generateTools === 'function' && schemas.length > 0) {
            if (typeof provider.generateToolsStream === 'function' && opts.onToken) {
                return provider.generateToolsStream(messages, schemas, { model, signal: stepSignal ?? opts.signal }, opts.onToken);
            }
            return provider.generateTools(messages, schemas, { model, signal: stepSignal ?? opts.signal });
        }
        // JSON fallback transport — the shared helper the chat engine uses.
        const { buildJsonFallbackPrompt } = await import('../inference/tool-call-utils.js');
        const { extractFallbackToolCalls } = await import('../tools/tool-loop.js');
        const prompt = buildJsonFallbackPrompt(messages, schemas);
        let raw;
        if (typeof provider.generateStream === 'function') {
            const chunks = [];
            await provider.generateStream(prompt, { model, signal: stepSignal ?? opts.signal }, (t) => {
                chunks.push(t);
                opts.onToken?.(t);
            });
            raw = chunks.join('');
        }
        else {
            raw = await provider.generate(prompt, { model, signal: stepSignal ?? opts.signal });
        }
        const { text, calls } = extractFallbackToolCalls(raw);
        return { content: text, toolCalls: calls };
    };
    try {
        const result = await runToolLoop({
            messages: thread,
            maxSteps: opts.maxSteps ?? 16,
            toolExposure: getLoopExposureMode(configManager),
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
        return failureResult(`Loop execution failed: ${err instanceof Error ? err.message : String(err)}`, startedAt, providerType, model, engineExplanation);
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