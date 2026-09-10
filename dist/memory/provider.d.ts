/**
 * MemoryProvider — Pluggable persistent-memory lifecycle (Phase B2).
 *
 * A provider exposes
 *   name() / is_available() / initialize(session_id) / system_prompt_block() /
 *   prefetch(query) / sync_turn(user, asst) / on_session_end()
 * and the MemoryManager (manager.ts) calls those hooks at the same points in
 * the chat/planner loop.
 *
 * `LocalMemoryProvider` is the default backend, composed over the stores that
 * already exist (trajectory-store + pattern-extractor + failure-lessons +
 * fact-store via `retrieveMemoryContext`). Phase F1 later adds a Mem0 provider
 * implementing the SAME interface — no caller changes.
 *
 * The trivial-prompt gate (`isTrivialPrompt`)
 * (single source of truth, shared by every caller) so greetings / one-word
 * acknowledgements never burn a prefetch call.
 */
import type { LLMCallFn } from '../agents/agent.js';
import type { Trajectory } from './trajectory-store.js';
/**
 * Return true when a user prompt is too trivial to warrant memory recall.
 * Empty input, slash commands, and bare greetings/acknowledgements count as
 * trivial. Callers (MemoryManager.prefetch) use this to skip the prefetch on
 * turns with no semantic signal.
 */
export declare function isTrivialPrompt(text: string | null | undefined): boolean;
/** What a provider's background recall returns for one query. */
export interface MemoryPrefetchResult {
    /** The composed persistent-memory block for prompt injection (may be ''). */
    block: string;
    /** Raw similar trajectories (for dashboards / event messages). */
    trajectories: Trajectory[];
    /** Few-shot plan examples. */
    fewShotContext: string;
    /** Positive episodic patterns. */
    patternContext: string;
    /** Negative episodic lessons. */
    failureLessonContext: string;
    /** Project-scoped facts / preferences. */
    factContext: string;
}
/**
 * The lifecycle a memory backend implements (`MemoryProvider` ABC).
 * All hooks are best-effort — a throwing provider must never break the agent.
 */
export interface MemoryProvider {
    /** Short identifier, e.g. 'local', 'mem0'. */
    readonly name: string;
    /** True when this backend is configured and ready (no network call). */
    isAvailable(): boolean;
    /** Called once per session. May create resources / reset per-session state. */
    initialize(sessionId: string): Promise<void>;
    /** Static context text for the system prompt (may be ''). */
    systemPromptBlock(): string;
    /**
     * Background recall before each turn. Gated by `isTrivialPrompt` — short
     * messages return an empty result without touching the stores.
     */
    prefetch(query: string, sessionId?: string, callLLM?: LLMCallFn): Promise<MemoryPrefetchResult>;
    /**
     * Async write after each turn. Implementations buffer the turn; the actual
     * extraction happens in onSessionEnd (keeps per-turn latency at zero).
     */
    syncTurn(userText: string, assistantText: string, callLLM?: LLMCallFn): Promise<void>;
    /** End-of-session extraction: distill buffered turns into durable facts. */
    onSessionEnd(sessionId: string, callLLM?: LLMCallFn): Promise<void>;
}
/**
 * The default provider, composed over the EXISTING stores:
 * - prefetch → `retrieveMemoryContext` (trajectories + patterns + failure
 *   lessons + project facts — the same recall the orchestrator already uses),
 *   gated by isTrivialPrompt.
 * - syncTurn → buffers the turn (zero-cost).
 * - onSessionEnd → flushes the buffered turns through fact-store extraction
 *   (rules when no callLLM; rules + one LLM JSON call when one is available).
 */
export declare class LocalMemoryProvider implements MemoryProvider {
    readonly name = "local";
    /** Turns recorded via syncTurn, flushed into facts at session end. */
    private pendingTurns;
    /** Cap for the per-session turn buffer (most recent N flushed). */
    private static readonly MAX_BUFFERED_TURNS;
    /**
     * No-op LLM used when prefetch is called without one: embed() falls through
     * to zero-vector handling and retrieval returns empty — the call itself is
     * never made. Module-level so we don't allocate a closure per call.
     */
    private static readonly NOOP_LLM;
    isAvailable(): boolean;
    initialize(_sessionId: string): Promise<void>;
    systemPromptBlock(): string;
    prefetch(query: string, _sessionId?: string, callLLM?: LLMCallFn): Promise<MemoryPrefetchResult>;
    syncTurn(userText: string, assistantText: string, _callLLM?: LLMCallFn): Promise<void>;
    onSessionEnd(_sessionId: string, callLLM?: LLMCallFn): Promise<void>;
}
/** A shared empty result (no recall, nothing to inject). */
export declare function emptyPrefetchResult(): MemoryPrefetchResult;
/** The active memory provider (default: LocalMemoryProvider). */
export declare function getMemoryProvider(): MemoryProvider;
/** Swap the active provider (Phase F1 registers Mem0 here). */
export declare function setMemoryProvider(provider: MemoryProvider): void;
/** Reset the singleton (test isolation). */
export declare function resetMemoryProvider(): void;
//# sourceMappingURL=provider.d.ts.map