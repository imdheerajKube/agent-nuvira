/**
 * H1/E3b — Pipeline tool (`src/tools/pipeline-tool.ts`).
 *
 * The orchestrator pipeline as a CALLABLE TOOL — a first-class
 * tool-call model ("a chat turn can invoke plan/execute/edit as a tool call",
 * H1 acceptance). Extracted from `runDeveloperMode` (chat.ts) so the same
 * pipeline core serves three entry points with zero divergence:
 *   1. `nuvira chat` pre-dispatch (runDeveloperMode — thin wrapper, prints).
 *   2. The H1 tool registry (build/resume/repair tools — return a summary
 *      text fed back to the model).
 *   3. Any future command (execute/plan/run) — STANDING RULE.
 *
 * Everything the old runDeveloperMode did is preserved: auto provider/model
 * resolution (never a literal 'auto' handed to the orchestrator), model
 * health repair via resolveWorkingModel, the E3a understand-card on the live
 * board, and D1 recall wiring for `continue` (mode 'recall').
 */
import { resolveProvider } from '../cli/router.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { getAutoRouter, isAutoProvider, isAutoModel } from '../learning/auto-router.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { parseRequestSync } from '../nlu/parser.js';
import { resolveDispatch } from '../nlu/actions.js';
import { contractFromParsed, renderContractCard } from '../nlu/contract.js';
import { maybeAutoRecall, recallCard, recallContextBlock, recallPolicy } from '../context/session-recall.js';
import { logger } from '../utils/logger.js';
import { PipelineBoard } from '../cli/pipeline-board.js';
/**
 * Run the orchestrator pipeline for a goal — the shared core.
 * Returns a summary; NEVER throws (failures are captured in the result).
 */
export async function runPipelineTool(goal, configManager, opts) {
    const board = opts.board !== false;
    // P2 — origin context: gateway-triggered runs carry WHO/WHERE the request
    // came from, so the pipeline model replies/forwards to the right place.
    if (opts.origin) {
        goal = `${goal.trim()}\n\n[Origin: ${opts.origin} — this request arrived from this chat; reply to it and use gateway_send for any follow-ups to this contact.]`;
    }
    // Resolve a REAL provider/model — never hand a literal 'auto' to the
    // orchestrator (mirrors runDeveloperMode).
    let provider = opts.provider;
    let model = opts.model;
    if (isAutoProvider(provider) || isAutoModel(model)) {
        try {
            const decision = getAutoRouter().resolve('chat', goal, { verbose: true, useRuntimeStats: true }, configManager);
            const resolved = resolveProvider(configManager, decision.provider);
            provider = resolved.type;
            model = await resolveWorkingModel(resolved.provider, decision.provider, decision.model);
        }
        catch (err) {
            return {
                success: false,
                summary: 'Pipeline failed: could not resolve a working provider/model',
                details: [String(err)],
                result: null,
                error: String(err),
            };
        }
    }
    // When the caller did NOT pin a provider/model, hand the decision to the
    // AutoModelRouter — the product's core routing USP. Without this, an
    // unpinned pipeline ran on the single configured default provider, so a
    // rate-limited provider (Groq's free-tier TPM is shared across ALL its
    // models — switching models within Groq can never escape it) became a
    // 429 death spiral instead of failing over to the configured alternatives
    // (observed live: trace-1788970301803-8302u5 — 14 steps / 112s of 429s on
    // gpt-oss-120b/gpt-oss-20b while Gemini + OpenRouter sat unused).
    // Auto-routing scores ALL configured providers per task (bandit + ML +
    // model-first + quota-parking), sinks away from session-failed providers,
    // and records real routing snapshots in the reasoning trace. An explicit
    // provider/model still wins (matches the orchestrator's own rule).
    const autoRoute = !provider && !model;
    // E3a + Session 20: intent transparency + D1 recall parity — parse ONCE,
    // resolve the REQUEST CONTRACT (understanding-first), seed the 🧠 card +
    // router task-intent hint. The contract's acceptance criteria are passed to
    // the orchestrator so the verification pass checks the changes against
    // them at pipeline end (Decision 3 — spec→verify).
    const parsed = parseRequestSync(goal);
    const dispatch = resolveDispatch(parsed);
    // Zero-reparse: the contract reuses the parse just computed above.
    const contract = contractFromParsed(goal, parsed);
    // The pipeline that runs: explicit (tool vocabulary) or derived from the
    // goal's NLU dispatch (legacy runDeveloperMode behavior).
    const mode = opts.mode ?? dispatch.mode;
    const notes = [
        `🧠 Understood: ${contract.actionLabel} · ${Math.round(parsed.confidence * 100)}% confidence — running the coding pipeline`,
        ...(opts.notes || []),
    ];
    let recallContext = opts.recallContext;
    // Ambient recall (see recallPolicy): the dispatched pipeline learns what this
    // project already did even when the request was not phrased as a continuation.
    const recallPolicyDecision = recallPolicy({ mode });
    if (recallPolicyDecision.recall && !recallContext) {
        try {
            const recall = await maybeAutoRecall(process.cwd(), configManager.getWorkspaceStore());
            if (recall) {
                if (recallPolicyDecision.announce) {
                    notes.push(...recallCard(recall).split('\n').filter((l) => l.trim() !== ''));
                }
                recallContext = recallContextBlock(recall);
            }
        }
        catch { /* recall must never break dispatch */ }
    }
    // Session 20: the 🧠 Understood card is printed BEFORE the pipeline runs
    // (fast-accept by default — display-only, never a blocking wizard). The
    // user always sees what the agent understood, then execution starts.
    console.log('\n' + renderContractCard(contract) + '\n');
    // Live pipeline board (the E2 ink TUI) — visible steps, lanes, retries.
    let liveBoard = null;
    if (board) {
        liveBoard = new PipelineBoard();
        liveBoard.start(goal);
    }
    getEventBus().emit(EventNames.ORCHESTRATOR_INSPECTION, { lines: notes }, 'chat');
    try {
        const orchestrator = new Orchestrator(configManager);
        const result = await orchestrator.execute(goal, {
            provider,
            model,
            autoRouteModels: autoRoute,
            verbose: false,
            ...(liveBoard ? { spinner: liveBoard } : {}),
            taskIntentHint: opts.taskIntentHint ?? dispatch.taskIntentHint,
            recallContext,
            acceptanceCriteria: contract.acceptanceCriteria,
            // The 🧠 card advertises resumability — make it true for every pipeline
            // run (cheap per-batch JSON checkpoints; a Ctrl+C / quota kill can then
            // `nuvira execute --resume` instead of restarting).
            checkpoint: true,
        });
        liveBoard?.finish(result.success);
        return {
            success: result.success,
            summary: result.summary,
            details: buildResultDetails(result),
            result,
        };
    }
    catch (err) {
        liveBoard?.finish(false);
        const message = err instanceof Error ? err.message : String(err);
        logger.error(message);
        return { success: false, summary: `Pipeline failed: ${message}`, details: [], result: null, error: message };
    }
}
/** Detail lines from an orchestration result (agent summaries + file changes). */
export function buildResultDetails(result) {
    const details = [];
    details.push(`Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);
    for (const ar of result.agentResults) {
        details.push(`${ar.success ? '✅' : '❌'} ${ar.agent}: ${ar.summary.slice(0, 120)}`);
    }
    if (result.fileChanges && result.fileChanges !== 'No files changed.') {
        for (const line of result.fileChanges.split('\n')) {
            if (line.trim())
                details.push(`📄 ${line.trim()}`);
        }
    }
    return details;
}
// ─── Registry adapter ───────────────────────────────────────────────────────
const ACTION_MODE = {
    build: 'dev',
    resume: 'recall',
    repair: 'execute',
    // E3c model-decides task tools — the pipeline mode + router task-intent
    // seed for each (document/website/analyze run the dev pipeline; test runs
    // the execute pipeline so the verification task-type biases routing).
    document: 'dev',
    website: 'dev',
    analyze: 'dev',
    test: 'execute',
};
const ACTION_INTENT = {
    build: 'coding',
    resume: 'coding',
    repair: 'debugging',
    document: 'planning',
    website: 'coding',
    analyze: 'architecture',
    test: 'verification',
};
/**
 * H1 tool-registry adapter — runs the pipeline for a build/resume/repair tool
 * call (or an E3c task tool: document/website/analyze/test) and returns the
 * model-feedable result text (never throws).
 */
export async function runPipelineToolFromRegistry(action, args, ctx) {
    const mode = ACTION_MODE[action];
    if (!mode)
        return `Unknown pipeline action: ${action}`;
    const a = args;
    const goal = (mode === 'recall' ? a.query : a.goal)?.trim();
    if (!goal)
        return `Tool "${action}" requires a ${mode === 'recall' ? 'query' : 'goal'} argument.`;
    const result = await runPipelineTool(goal, ctx.configManager, {
        mode,
        taskIntentHint: ACTION_INTENT[action],
        board: ctx.board === undefined ? true : !!ctx.board,
        notes: [`⚙ ${action} called from the chat loop`],
    });
    return [
        result.success ? `✅ ${action} succeeded` : `❌ ${action} failed`,
        result.summary,
        ...result.details,
    ].join('\n');
}
//# sourceMappingURL=pipeline-tool.js.map