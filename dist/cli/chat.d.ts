import { Command } from 'commander';
import { BaseCommand } from './commands.js';
import type { ParsedRequest } from '../nlu/parser.js';
import { type ToolContext, type FollowupSuggestion } from '../tools/registry.js';
/** E3a — the menu-free dispatch decision (rule-based, C1/C3 only). */
export interface PipelineDispatchDecision {
    /** Whether the request runs the coding pipeline. */
    dispatch: boolean;
    /** Whether a single confirm is required first (ambiguous create only). */
    needConfirm: boolean;
}
/**
 * E3a/E3c — the rule assessment (hint + no-model fallback source).
 *
 * The legacy `promptDeveloperMode` menu ("1. Chat mode / 2. Developer mode")
 * is DELETED (Session 7c re-scope, landed in E3a). E3c demotes the rules
 * further (model-decides, Freebuff/Hermes parity): EVERY request runs as a
 * tool-call turn and the MODEL decides what to do. This function computes
 * what the RULES would say, used for two things only:
 * - the rule hint injected into the model's context (buildToolSystemPrompt),
 * - the no-model fallback decision: when the tool loop fails to generate a
 *   single response AND the rules assessed a high-confidence pipeline intent,
 *   the pipeline runs directly — rules act ONLY when the model is unavailable,
 *   never as a bypass.
 * `dev` (the --dev flag / /dev toggle) forces the assessment to dispatch.
 */
export declare function resolvePipelineDispatch(parsed: ParsedRequest, opts?: {
    dev?: boolean;
}): PipelineDispatchDecision;
/**
 * Execute the multi-agent pipeline for a user's goal (H1/E3b refactor).
 *
 * Thin wrapper over the shared `runPipelineTool` (src/tools/pipeline-tool.ts)
 * — the SAME pipeline core the tool registry's build/resume/repair tools use,
 * so `buff chat` pre-dispatch and in-loop pipeline tool calls can never
 * diverge (STANDING RULE). Prints the orchestration result; the tool path
 * returns the summary text instead.
 */
export declare function runDeveloperMode(goal: string, configManager: any, options?: {
    provider?: string;
    model?: string;
}): Promise<void>;
export declare class ChatCommand extends BaseCommand {
    private devModeAuto;
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
    private sessionFailedProviders;
    /**
     * Providers that failed TRANSIENTLY this session (server/network/timeout/
     * unknown). Tracked separately from the exclusion map so that when a
     * transient exclusion EXPIRES, the provider is only re-admitted to routing
     * after a quick on-demand spot-check confirms it's actually back — recovery
     * is discovered in seconds, not by blindly failing into it again.
     */
    private sessionTransientFailedProviders;
    /**
     * Whether the cold-start probe has fired this session. On a fresh registry
     * (no verified models yet) the FIRST auto pick fires a background
     * probe + spot-check so routing learns from real API data instead of
     * failing into dead ends — the fire-and-forget keeps the first message fast.
     */
    private coldStartProbeFired;
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
    answerOnce(message: string, opts?: {
        provider?: string;
        model?: string;
        dev?: boolean;
        history?: Array<{
            role: string;
            content: string;
        }>;
        askUser?: ToolContext['askUser'];
    }): Promise<{
        content: string;
        followups: FollowupSuggestion[];
        generationFailed?: boolean;
        provider?: string;
        model?: string;
    }>;
    create(): Command;
    private execute;
    /**
     * E3b — run one chat answer as a TOOL-CALL TURN (Freebuff/Hermes parity).
     *
     * The model may call ask_user (clarify), verify_requirement, the pipeline
     * tools (build/repair/resume), and must end with suggest_followups (3
     * followups, Freebuff contract). Native tool-calling when the provider
     * supports it; JSON fallback otherwise. Carries the legacy generation
     * machinery forward: auto-mode failover + shared fallback chain inside
     * callModel, caching, memory recording, and registry telemetry.
     *
     * Returns the final content + an optional follow-up prompt (interactive
     * mode renders numbered options; choosing one sends it as the next message).
     */
    private runChatAnswer;
    /**
     * E3b — the model-call step for the tool loop (Freebuff run-agent-step):
     * native generateTools when the provider supports it, JSON fallback
     * otherwise. Auto-mode failover + the shared fallback chain live here — a
     * broken provider never crashes the turn (it answers from the next working
     * candidate, exactly like the legacy generation block).
     */
    private buildToolCallModel;
    /**
     * E3b — render suggest_followups results (Freebuff parity). Interactive:
     * numbered options; choosing one sends its prompt as the next message.
     * Single-shot: printed after the answer.
     */
    private renderFollowups;
    /**
     * Record a completed user↔assistant turn into the persistent-memory manager
     * (Phase B2). Best-effort and fire-and-forget: the provider only BUFFERS the
     * turn here (zero latency); extraction into project facts happens once at
     * session end. A memory failure must never break the chat loop.
     */
    private memoryNoteTurn;
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
    private recordAutoProviderFailure;
    private showModelPicker;
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
    private routeMessageAuto;
    /**
     * Read multi-line input from stdin using readline.
     *
     * - First line prompt: "You: "
     * - Continuation lines prompt: "  > "
     * - Pressing Enter with no text on the first line re-prompts
     * - An empty line after non-empty input submits the message
     * - This allows pasting multi-line text (each line collected), then Enter to submit
     */
    private readMultiLineInput;
    private handleCommand;
}
//# sourceMappingURL=chat.d.ts.map