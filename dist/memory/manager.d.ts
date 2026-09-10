/**
 * MemoryManager — Orchestrates the active MemoryProvider (Phase B2).
 *
 * The manager injects the provider's
 * context into prompts and calls the lifecycle hooks at the right points in the
 * chat/planner loop. The caller never touches the provider directly:
 *
 *   const mgr = getMemoryManager();
 *   await mgr.startSession(sessionId);                 // provider.initialize
 *   const block = await mgr.buildMemoryBlock(query);   // provider.prefetch (trivial-gated)
 *   await mgr.recordTurn(user, asst);                  // provider.syncTurn (zero-cost buffer)
 *   await mgr.endSession();                            // provider.onSessionEnd (extraction)
 *
 * Everything is best-effort — a memory failure must never break the agent.
 */
import type { LLMCallFn } from '../agents/agent.js';
import { type MemoryProvider, type MemoryPrefetchResult } from './provider.js';
export declare class MemoryManager {
    private provider;
    private sessionId;
    constructor(provider?: MemoryProvider);
    /** The provider currently backing this manager ('local', 'mem0', ...). */
    get activeProvider(): MemoryProvider;
    /** Swap the backend provider (Phase F1 registers Mem0 here). */
    setProvider(provider: MemoryProvider): void;
    /** Begin a session — clears per-session state on the provider. */
    startSession(sessionId: string): Promise<void>;
    /**
     * Build the persistent-memory context block for a query (planner/chat prompt
     * injection). Trivial prompts (greetings, one-word acks) return an empty
     * block with no store access — the is_trivial_prompt gate.
     */
    buildMemoryBlock(query: string, callLLM?: LLMCallFn): Promise<MemoryPrefetchResult>;
    /** Record a completed user↔assistant turn (buffered, zero-cost). */
    recordTurn(userText: string, assistantText: string, callLLM?: LLMCallFn): Promise<void>;
    /**
     * End the session — flushes buffered turns into durable facts.
     * Returns the sessionId that just ended (or null if none was active).
     */
    endSession(callLLM?: LLMCallFn): Promise<string | null>;
    /** True when a session is currently active. */
    get inSession(): boolean;
}
export declare function getMemoryManager(): MemoryManager;
/** Reset the singleton (test isolation). */
export declare function resetMemoryManager(): void;
//# sourceMappingURL=manager.d.ts.map