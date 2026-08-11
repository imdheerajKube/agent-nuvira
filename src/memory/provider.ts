/**
 * MemoryProvider — Pluggable persistent-memory lifecycle (Phase B2).
 *
 * Mirrors Hermes `agent/memory_provider.py` exactly: a provider exposes
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
 * The trivial-prompt gate (`isTrivialPrompt`) mirrors Hermes `is_trivial_prompt`
 * (single source of truth, shared by every caller) so greetings / one-word
 * acknowledgements never burn a prefetch call.
 */

import type { LLMCallFn } from '../agents/agent.js';
import type { Trajectory } from './trajectory-store.js';
import { getFactStore } from './fact-store.js';
import { logger } from '../utils/logger.js';

// ─── Trivial-prompt gate (mirrors Hermes TRIVIAL_PROMPT_RE) ─────────────────

/**
 * Prompts that carry no semantic signal — bare greetings, acknowledgements,
 * and yes/no answers (with optional trailing punctuation). Anchored so words
 * that merely START with a trivial word ("k8s", "yolo", "note") do NOT match,
 * while "hi!", "thanks :)", "done???" do.
 */
const TRIVIAL_PROMPT_RE =
  /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?.:;,"'~…()\[\]{}<>*&^%$#@!+=`\u00a0]*$/i;

/**
 * Return true when a user prompt is too trivial to warrant memory recall.
 * Empty input, slash commands, and bare greetings/acknowledgements count as
 * trivial. Callers (MemoryManager.prefetch) use this to skip the prefetch on
 * turns with no semantic signal.
 */
export function isTrivialPrompt(text: string | null | undefined): boolean {
  if (!text) return true;
  const stripped = text.trim();
  if (!stripped) return true;
  if (stripped.startsWith('/')) return true;
  return TRIVIAL_PROMPT_RE.test(stripped);
}

// ─── Types ──────────────────────────────────────────────────────────────────

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
 * The lifecycle a memory backend implements (Hermes `MemoryProvider` ABC).
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

// ─── LocalMemoryProvider ────────────────────────────────────────────────────

/**
 * The default provider, composed over the EXISTING stores:
 * - prefetch → `retrieveMemoryContext` (trajectories + patterns + failure
 *   lessons + project facts — the same recall the orchestrator already uses),
 *   gated by isTrivialPrompt.
 * - syncTurn → buffers the turn (zero-cost).
 * - onSessionEnd → flushes the buffered turns through fact-store extraction
 *   (rules when no callLLM; rules + one LLM JSON call when one is available).
 */
export class LocalMemoryProvider implements MemoryProvider {
  readonly name = 'local';

  /** Turns recorded via syncTurn, flushed into facts at session end. */
  private pendingTurns: Array<{ userText: string; assistantText: string }> = [];

  /** Cap for the per-session turn buffer (most recent N flushed). */
  private static readonly MAX_BUFFERED_TURNS = 10;

  /**
   * No-op LLM used when prefetch is called without one: embed() falls through
   * to zero-vector handling and retrieval returns empty — the call itself is
   * never made. Module-level so we don't allocate a closure per call.
   */
  private static readonly NOOP_LLM: LLMCallFn = async () => '';

  isAvailable(): boolean {
    return true;
  }

  async initialize(_sessionId: string): Promise<void> {
    // Fresh session → fresh buffer. Best-effort (a reset must never throw).
    try {
      this.pendingTurns = [];
    } catch {
      // Non-critical
    }
  }

  systemPromptBlock(): string {
    return (
      'You have persistent memory of this project: past successful runs, failure lessons, ' +
      'coding patterns, and facts/preferences the user has shared. Use them to avoid ' +
      'repeating past mistakes and to match the user\'s established conventions.'
    );
  }

  async prefetch(
    query: string,
    _sessionId?: string,
    callLLM?: LLMCallFn,
  ): Promise<MemoryPrefetchResult> {
    // Hermes is_trivial_prompt gate: greetings / one-word acks never prefetch.
    if (isTrivialPrompt(query)) return emptyPrefetchResult();

    try {
      const { retrieveMemoryContext } = await import('./memory-integration.js');
      const result = await retrieveMemoryContext(query, callLLM ?? LocalMemoryProvider.NOOP_LLM, 3);
      const parts = [
        result.fewShotContext,
        result.patternContext,
        result.failureLessonContext,
        result.factContext,
      ].filter((s) => s && s.trim().length > 0);
      // Compose the FULL persistent-memory block: the provider's static system
      // block FRAMES the per-field recall so `systemPromptBlock()` actually
      // reaches the planner prompt (Hermes puts it in the system prompt; here
      // it heads the injected block). Empty when there is nothing to recall.
      const block = parts.length > 0
        ? `\n---\n${this.systemPromptBlock()}\n\nPersistent memory for this project:\n${parts.join('\n')}\n---\n`
        : '';
      return { ...result, block };
    } catch (err) {
      logger.debug(`Memory prefetch failed (non-critical): ${err}`);
      return emptyPrefetchResult();
    }
  }

  async syncTurn(userText: string, assistantText: string, _callLLM?: LLMCallFn): Promise<void> {
    try {
      const text = (userText || '').trim();
      if (!text || isTrivialPrompt(text)) return; // nothing durable to record
      this.pendingTurns.push({ userText: text, assistantText: assistantText || '' });
      // Bound the buffer — only the most recent turns are worth distilling.
      if (this.pendingTurns.length > LocalMemoryProvider.MAX_BUFFERED_TURNS) {
        this.pendingTurns.shift();
      }
    } catch {
      // Best-effort — a buffering failure must never break the chat loop.
    }
  }

  async onSessionEnd(_sessionId: string, callLLM?: LLMCallFn): Promise<void> {
    if (this.pendingTurns.length === 0) return;
    try {
      const { deriveProjectId } = await import('../config/workspace.js');
      const { id: projectId } = deriveProjectId(process.cwd());
      const turns = this.pendingTurns;
      this.pendingTurns = []; // clear FIRST so a failure never re-flushes
      let stored = 0;
      for (const turn of turns) {
        stored += await getFactStore().extractFactsFromTurn(
          projectId,
          {
            userText: turn.userText,
            assistantText: turn.assistantText,
            source: 'chat',
          },
          callLLM,
        );
      }
      if (stored > 0) {
        logger.debug(`Session-end memory extraction: ${stored} fact(s) stored for '${projectId}'`);
      }
    } catch (err) {
      logger.debug(`Session-end memory extraction failed (non-critical): ${err}`);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A shared empty result (no recall, nothing to inject). */
export function emptyPrefetchResult(): MemoryPrefetchResult {
  return {
    block: '',
    trajectories: [],
    fewShotContext: '',
    patternContext: '',
    failureLessonContext: '',
    factContext: '',
  };
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let providerInstance: MemoryProvider | null = null;

/** The active memory provider (default: LocalMemoryProvider). */
export function getMemoryProvider(): MemoryProvider {
  if (!providerInstance) {
    providerInstance = new LocalMemoryProvider();
  }
  return providerInstance;
}

/** Swap the active provider (Phase F1 registers Mem0 here). */
export function setMemoryProvider(provider: MemoryProvider): void {
  providerInstance = provider;
}

/** Reset the singleton (test isolation). */
export function resetMemoryProvider(): void {
  providerInstance = null;
}
