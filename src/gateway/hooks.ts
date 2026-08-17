/**
 * I2 — Hook registry (`src/gateway/hooks.ts`).
 *
 * Lifecycle hooks the agent
 * runtime fires at well-defined moments. Two events today (extensible):
 *
 * - `post_tool_call`  — after the tool loop executes a registry tool. Driven
 *   by the `tool:called` event-bus event emitted from `src/tools/tool-loop.ts`
 *   (the `post_tool_call` hook). Handlers receive the tool name,
 *   result, success flag and duration.
 * - `on_session_end`  — after a pipeline run finishes (execute:completed /
 *   execute:failed). Handlers receive the run's success + summary.
 *
 * Wiring is through the EXISTING observability event bus — hooks are typed
 * consumers, not a parallel system. `installHooks(bus)` subscribes and returns
 * an unsubscribe; the default built-in hook logs session summaries.
 */

import { logger } from '../utils/logger.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type HookEvent = 'post_tool_call' | 'on_session_end';

/** Context for `post_tool_call` handlers. */
export interface ToolCallHookContext {
  tool: string;
  ok: boolean;
  /** The tool-result text fed back to the model (truncated for hooks). */
  result?: string;
  /** Error text when the tool failed. */
  error?: string;
  /** Execution duration in ms. */
  durationMs?: number;
}

/** Context for `on_session_end` handlers. */
export interface SessionEndHookContext {
  success: boolean;
  summary?: string;
  /** The pipeline goal when known. */
  goal?: string;
}

/** A hook handler — sync or async; the registry runs them serially. */
export type HookHandler<T> = (ctx: T) => void | Promise<void>;

// ─── Registry ───────────────────────────────────────────────────────────────

class HookRegistry {
  private handlers = new Map<HookEvent, Array<HookHandler<any>>>();

  /** Register a handler for a hook event. Idempotent per (event, fn) pair. */
  register<T extends HookEvent>(event: T, handler: HookHandler<HookContextFor<T>>): void {
    const list = this.handlers.get(event) ?? [];
    if (!list.includes(handler)) list.push(handler);
    this.handlers.set(event, list);
  }

  /** Remove a handler (tests + dynamic hook lifecycle). No-op when absent. */
  unregister<T extends HookEvent>(event: T, handler: HookHandler<HookContextFor<T>>): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.handlers.delete(event);
  }

  /** Run every handler for an event, serially, best-effort (never throws). */
  async run<T extends HookEvent>(event: T, ctx: HookContextFor<T>): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        await handler(ctx);
      } catch (err) {
        logger.debug(`hook '${event}' handler failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Registered handler counts per event (CLI/tests introspection). */
  list(): Record<HookEvent, number> {
    return {
      post_tool_call: this.handlers.get('post_tool_call')?.length ?? 0,
      on_session_end: this.handlers.get('on_session_end')?.length ?? 0,
    };
  }
}

type HookContextFor<T extends HookEvent> = T extends 'post_tool_call'
  ? ToolCallHookContext
  : SessionEndHookContext;

/** The singleton registry. */
export const hooks = new HookRegistry();

// ─── Bus wiring ─────────────────────────────────────────────────────────────

/** Wire the registry to the event bus. Returns an unsubscribe function. */
export function installHooks(bus = getEventBus()): () => void {
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    bus.on(EventNames.TOOL_CALLED, (record) => {
      const d = (record.data ?? {}) as Partial<ToolCallHookContext> & { error?: string };
      void hooks.run('post_tool_call', {
        tool: d.tool ?? 'unknown',
        ok: d.ok !== false,
        result: typeof d.result === 'string' ? d.result.slice(0, 500) : undefined,
        error: d.error,
        durationMs: d.durationMs,
      });
    }),
  );

  unsubscribers.push(
    bus.on(EventNames.EXECUTE_COMPLETED, (record) => {
      const d = (record.data ?? {}) as Partial<SessionEndHookContext> & { summary?: string; goal?: string };
      void hooks.run('on_session_end', {
        success: d.success !== false,
        summary: d.summary,
        goal: d.goal,
      });
    }),
  );

  unsubscribers.push(
    bus.on(EventNames.EXECUTE_FAILED, (record) => {
      const d = (record.data ?? {}) as Partial<SessionEndHookContext> & { error?: string };
      void hooks.run('on_session_end', {
        success: false,
        summary: d.summary ?? d.error,
        goal: d.goal,
      });
    }),
  );

  return () => {
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
  };
}

// ─── Built-in hooks ─────────────────────────────────────────────────────────

/**
 * Default built-in: log pipeline session summaries ("session end
 * summary" builtin hook parity). Registered once at module load.
 */
export function registerBuiltinHooks(): void {
  hooks.register('on_session_end', (ctx) => {
    logger.info(
      ctx.success
        ? `gateway: session complete — ${ctx.summary ?? 'ok'}`
        : `gateway: session failed — ${ctx.summary ?? 'unknown error'}`,
    );
  });
}

// Install the builtin once (idempotent — register() dedupes by function ref).
registerBuiltinHooks();
