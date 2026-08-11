/**
 * MemoryManager — Orchestrates the active MemoryProvider (Phase B2).
 *
 * Mirrors Hermes `agent/memory_manager.py`: the manager injects the provider's
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
import {
  emptyPrefetchResult,
  getMemoryProvider,
  resetMemoryProvider,
  type MemoryProvider,
  type MemoryPrefetchResult,
} from './provider.js';
import { logger } from '../utils/logger.js';
import { countMetric } from '../enterprise/metrics.js';

// ─── MemoryManager ──────────────────────────────────────────────────────────

export class MemoryManager {
  private provider: MemoryProvider;
  private sessionId: string | null = null;

  constructor(provider?: MemoryProvider) {
    this.provider = provider ?? getMemoryProvider();
  }

  /** The provider currently backing this manager ('local', 'mem0', ...). */
  get activeProvider(): MemoryProvider {
    return this.provider;
  }

  /** Swap the backend provider (Phase F1 registers Mem0 here). */
  setProvider(provider: MemoryProvider): void {
    this.provider = provider;
  }

  /** Begin a session — clears per-session state on the provider. */
  async startSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.provider.initialize(sessionId).catch(() => {
      // Best-effort — a provider reset must never break the session.
    });
  }

  /**
   * Build the persistent-memory context block for a query (planner/chat prompt
   * injection). Trivial prompts (greetings, one-word acks) return an empty
   * block with no store access — the Hermes is_trivial_prompt gate.
   */
  async buildMemoryBlock(query: string, callLLM?: LLMCallFn): Promise<MemoryPrefetchResult> {
    const result = await this.provider.prefetch(query, this.sessionId ?? undefined, callLLM).catch((err) => {
      logger.debug(`Memory block build failed (non-critical): ${err}`);
      return emptyPrefetchResult();
    });
    // K2: memory hit/miss — a hit returns at least one context fragment
    // (facts, trajectories, patterns, or lessons), a miss returns nothing.
    const hit =
      result.block.trim().length > 0 ||
      result.trajectories.length > 0 ||
      result.factContext.trim().length > 0 ||
      result.patternContext.trim().length > 0 ||
      result.failureLessonContext.trim().length > 0;
    countMetric(hit ? 'memory.hits' : 'memory.misses');
    return result;
  }

  /** Record a completed user↔assistant turn (buffered, zero-cost). */
  async recordTurn(userText: string, assistantText: string, callLLM?: LLMCallFn): Promise<void> {
    await this.provider.syncTurn(userText, assistantText, callLLM).catch(() => {
      // Best-effort — never break the chat loop over memory.
    });
  }

  /**
   * End the session — flushes buffered turns into durable facts.
   * Returns the sessionId that just ended (or null if none was active).
   */
  async endSession(callLLM?: LLMCallFn): Promise<string | null> {
    const sid = this.sessionId;
    if (sid) {
      await this.provider.onSessionEnd(sid, callLLM).catch(() => {
        // Best-effort — never break the exit path over memory extraction.
      });
      this.sessionId = null;
    }
    return sid;
  }

  /** True when a session is currently active. */
  get inSession(): boolean {
    return this.sessionId !== null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let managerInstance: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!managerInstance) {
    managerInstance = new MemoryManager();
  }
  return managerInstance;
}

/** Reset the singleton (test isolation). */
export function resetMemoryManager(): void {
  managerInstance = null;
  resetMemoryProvider();
}
