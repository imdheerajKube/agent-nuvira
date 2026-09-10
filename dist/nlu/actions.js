/**
 * C3 — Declarative intent→action map.
 *
 * ONE source of truth for "which pipeline runs" for a resolved intent. Every
 * action command (chat, execute, plan, edit) derives its dispatch from this
 * map through the shared `resolveDispatch()` choke point — never a per-command
 * branch — so the STANDING cross-command parity rule is enforced structurally,
 * not by convention.
 *
 * The action is a
 * tool descriptor `{ name, description, inputSchema, run }` in the same shape
 * Tool definitions and `tools/registry.py` entries use, so
 * the orchestrator pipeline is invocable both from the chat loop (Phase E3
 * pipeline-as-tool) and from native tool-calling providers (H1) with zero
 * re-implementation. "Mode" is an internal pipeline pick, never a user menu:
 * `shouldAutoDispatch` is the menu-unreachable gate — when rule/LLM confidence
 * is at or above `RULE_TRUST_THRESHOLD`, no user-facing mode/menu is reached.
 */
import { z } from 'zod';
import { RULE_TRUST_THRESHOLD } from './intent.js';
import { timeRangeSchema } from './schema.js';
const buildAction = {
    name: 'build',
    description: 'Generate new code, files, projects, plugins or addons through the full agent pipeline',
    run: 'pipeline',
    mode: 'dev',
    taskIntent: 'coding',
    inputSchema: z.object({ goal: z.string() }),
};
const resumeAction = {
    name: 'resume',
    description: 'Resume prior work for this project (recall + pipeline), with an optional temporal anchor',
    run: 'pipeline',
    mode: 'recall',
    taskIntent: 'coding',
    inputSchema: z.object({ query: z.string(), timeRange: timeRangeSchema.optional() }),
};
const repairAction = {
    name: 'repair',
    description: 'Fix a bug, debug a failure, or resolve an error through the agent pipeline',
    run: 'pipeline',
    mode: 'execute',
    taskIntent: 'debugging',
    inputSchema: z.object({ goal: z.string() }),
};
const assessAction = {
    name: 'assess',
    description: 'Answer a question or analyze/explain something — a direct chat response, no file writes',
    run: 'chat',
    mode: 'chat',
    taskIntent: 'unknown',
    inputSchema: z.object({ question: z.string() }),
};
// S4 — "write an essay/poem/story/…" is CONTENT, not code: a direct chat
// answer (run: 'chat'), never the coding pipeline. The model still sees the
// build/analyze tools in the loop and can call them for a request that
// actually needs code; this only governs the no-model fallback + routing hint
// (taskIntent 'creative' → the router's creative reasoning floor).
const writeAction = {
    name: 'write',
    description: 'Write creative or educational content (essay, poem, story, letter, article, summary) — a direct chat response, no file writes',
    run: 'chat',
    mode: 'chat',
    taskIntent: 'creative',
    inputSchema: z.object({ prompt: z.string() }),
};
const configureAction = {
    name: 'configure',
    description: 'Set up API keys, switch providers/models, or change configuration',
    run: 'config',
    mode: 'config',
    taskIntent: 'unknown',
    inputSchema: z.object({ request: z.string() }),
};
const askAction = {
    name: 'ask',
    description: 'Ambiguous request — fall back to a chat answer; no pipeline runs on a guess',
    run: 'chat',
    mode: 'chat',
    taskIntent: 'unknown',
    inputSchema: z.object({ question: z.string() }),
};
/** Every intent resolves to exactly one action (the map is total). */
export const ACTION_BY_INTENT = {
    create: buildAction,
    continue: resumeAction,
    fix: repairAction,
    explain: assessAction,
    configure: configureAction,
    write: writeAction,
    unknown: askAction,
};
// ─── Lookups ────────────────────────────────────────────────────────────────
/** Resolve the action descriptor for an intent. */
export function resolveAction(intent) {
    return ACTION_BY_INTENT[intent];
}
/** Map an NLU intent to the router's task-type vocabulary (single choke point). */
export function taskTypeForIntent(intent) {
    return ACTION_BY_INTENT[intent].taskIntent;
}
/**
 * The menu-unreachable gate (C3 acceptance a/c). A request auto-dispatches —
 * with NO user-facing mode/menu — unless it is an ambiguous CREATE below the
 * trust threshold. Non-create intents never show a menu; create keeps the
 * legacy menu ONLY as an ambiguity fallback (the plan's "menu only as
 * LLM-unavailable fallback").
 */
export function shouldAutoDispatch(intent, confidence) {
    if (intent !== 'create')
        return true;
    return confidence >= RULE_TRUST_THRESHOLD;
}
/**
 * THE single function every action command (chat, execute, plan, edit) uses to
 * turn a parsed request into its dispatch — intent resolution, the action map,
 * and the router task-type share one vocabulary by construction. The parity
 * tests assert the five canonical prompts resolve identically through here for
 * every command, which is only possible because they all consume this
 * choke point instead of command-local branching.
 */
export function resolveDispatch(parsed) {
    const action = resolveAction(parsed.intent);
    // Only informative intents seed the router: create/fix/continue carry a real
    // task-type bias; explain/configure/unknown map to 'unknown', which would
    // OVERRIDE the router's own text analysis with a meaningless label — omit.
    const informative = action.taskIntent !== 'unknown';
    return {
        action: action.name,
        mode: action.mode,
        taskIntentHint: informative && parsed.confidence >= RULE_TRUST_THRESHOLD ? action.taskIntent : undefined,
        autoDispatch: shouldAutoDispatch(parsed.intent, parsed.confidence),
    };
}
//# sourceMappingURL=actions.js.map