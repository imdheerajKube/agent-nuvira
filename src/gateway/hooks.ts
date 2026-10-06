/**
 * I2 — Hook registry (`src/gateway/hooks.ts`).
 *
 * Lifecycle hooks the agent runtime fires at well-defined moments. The tool
 * phases are the WS4 (#26) triple, in the order a call goes through them:
 *
 * - `before_tool_call` — BEFORE the call runs, and the ONLY phase that can stop
 *   it: a handler returns a {@link HookDecision} and the call is not made.
 * - `after_tool_call`  — the call ran and succeeded. Handlers receive the tool
 *   name, the result, the success flag and the duration.
 * - `failed_tool_call` — the call ran and did NOT succeed (a thrown error, or a
 *   result the loop`s own convention marks as a failure).
 * - `on_session_end`   — after a pipeline run finishes (execute:completed /
 *   execute:failed). Handlers receive the run`s success + summary.
 *
 * `post_tool_call` was this event`s previous name. It is renamed rather than
 * aliased so the three phases read exactly as the capability is stated
 * (before/after/failed); nothing in production subscribed to it, and an alias
 * would leave two names for one moment — the drift this repo removes elsewhere.
 *
 * THE TOOL PHASES ARE DRIVEN BY THE EXECUTION SEAM, not the event bus, and that
 * is a deliberate reversal of the original wiring. A bus subscription is
 * fire-and-forget: it cannot stop a call, it cannot tell the loop what a
 * subscriber decided, and it only fires on a surface that happens to put
 * `tool:called` on the bus — so a hook installed that way reached the gateway and
 * nowhere else. `src/tools/tool-loop.ts` and `src/tools/child-agent-runtime.ts`
 * call {@link HookRegistry.runBefore} / {@link HookRegistry.run} directly, which
 * is what makes the hooks fire on all five surfaces and lets a veto be honoured.
 */

import { logger } from '../utils/logger.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
// The declarative contract (operator-authored rules) binds to this registry.
// Import direction is one-way: hook-contract.ts imports only TYPES from here,
// so there is no runtime cycle.
import { installDeclaredHooks } from './hook-contract.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type HookEvent =
  | 'before_tool_call'
  | 'after_tool_call'
  | 'failed_tool_call'
  | 'on_session_end';

/**
 * What a `before_tool_call` handler may return to stop the call.
 *
 * A RETURN VALUE rather than a mutation, because the registry has to hand the
 * decision back to the caller that is about to run the tool: a subscriber that
 * could only observe could not veto.
 */
export interface HookDecision {
  /** `true` stops the call. There is no "deny: false" — an absent decision allows. */
  deny: true;
  /** Why, in the operator's words. Flows to the model and to the turn's trace. */
  reason?: string;
  /** Which hook decided (a declaration label, or a subscriber's own name). */
  by?: string;
}

/**
 * The call itself, as every tool phase sees it.
 *
 * `report` is how a subscriber says something went wrong in its OWN handling.
 * It exists because the seam FAILS OPEN: a broken hook must not block work, so if
 * there were no way to report one, a hook that silently stopped working would be
 * indistinguishable from a hook that allowed everything.
 */
export interface ToolCallRef {
  tool: string;
  /** The call's arguments, as the model produced them. */
  args?: Record<string, unknown>;
  /** The provider's call id, when there is one. */
  callId?: string;
  /** The surface label the turn declared (`cli-chat`, `subagent`, …). */
  surface?: string;
  cwd?: string;
  report?: (message: string) => void;
}

/** Context for `after_tool_call` handlers. */
export interface ToolCallHookContext extends ToolCallRef {
  ok: boolean;
  /** The tool-result text fed back to the model (truncated for hooks). */
  result?: string;
  /** Execution duration in ms. */
  durationMs?: number;
}

/** Context for `failed_tool_call` handlers. */
export interface FailedToolCallHookContext extends ToolCallRef {
  /** Why it failed — the thrown message, or the failing result's own text. */
  error: string;
  /** The result text, when the tool returned a failure rather than throwing. */
  result?: string;
  durationMs?: number;
}

/** Context for `on_session_end` handlers. */
export interface SessionEndHookContext {
  success: boolean;
  summary?: string;
  /** The pipeline goal when known. */
  goal?: string;
}

/**
 * A hook handler — sync or async; the registry runs them serially.
 *
 * A returned {@link HookDecision} is honoured for `before_tool_call` (the only
 * phase where stopping the call is possible) and ignored elsewhere, so one
 * handler type serves the whole registry.
 */
export type HookHandler<T> = (ctx: T) => void | HookDecision | Promise<void | HookDecision>;

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
        const message = `hook '${event}' handler failed: ${err instanceof Error ? err.message : err}`;
        // Told to the CALLER as well as the log, because a handler that throws is
        // fail-open: without this, a broken subscriber is indistinguishable from
        // one that approved.
        (ctx as ToolCallRef).report?.(message);
        logger.debug(message);
      }
    }
  }

  /**
   * Run the `before_tool_call` handlers and return the FIRST decision.
   *
   * Serial by construction: two hooks must not race over whether a call happens,
   * and the first denial is the answer — a later hook cannot un-deny a call that
   * has already been stopped. A handler that throws is reported and skipped
   * (FAIL OPEN), so one broken hook cannot stop every tool call in the process.
   */
  async runBefore(ctx: BeforeToolCallHookContext): Promise<HookDecision | null> {
    for (const handler of this.handlers.get('before_tool_call') ?? []) {
      let decision: void | HookDecision;
      try {
        decision = await handler(ctx);
      } catch (err) {
        const message = `hook 'before_tool_call' handler failed: ${err instanceof Error ? err.message : err}`;
        ctx.report?.(message);
        logger.debug(message);
        continue;
      }
      if (decision && decision.deny) return decision;
    }
    return null;
  }

  /** Registered handler counts per event (CLI/tests introspection). */
  list(): Record<HookEvent, number> {
    return {
      before_tool_call: this.handlers.get('before_tool_call')?.length ?? 0,
      after_tool_call: this.handlers.get('after_tool_call')?.length ?? 0,
      failed_tool_call: this.handlers.get('failed_tool_call')?.length ?? 0,
      on_session_end: this.handlers.get('on_session_end')?.length ?? 0,
    };
  }
}

/** Context for `before_tool_call` handlers: the call, before it happens. */
export type BeforeToolCallHookContext = ToolCallRef;

type HookContextFor<T extends HookEvent> = T extends 'before_tool_call'
  ? BeforeToolCallHookContext
  : T extends 'after_tool_call'
    ? ToolCallHookContext
    : T extends 'failed_tool_call'
      ? FailedToolCallHookContext
      : SessionEndHookContext;

/** The singleton registry. */
export const hooks = new HookRegistry();

// ─── Bus wiring ─────────────────────────────────────────────────────────────

/** Wire the registry to the event bus. Returns an unsubscribe function. */
export function installHooks(bus = getEventBus()): () => void {
  const unsubscribers: Array<() => void> = [];

  // NOTE: there is deliberately no `tool:called` subscription here any more. The
  // tool phases are driven by the execution seam (see the module header), and a
  // bus subscription would fire every tool hook a SECOND time on any surface
  // that puts the event on the bus — which is the kind of double-fire nobody
  // notices until a hook has an external side effect.

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

// Install the operator-authored declarative hooks (src/gateway/hook-contract.ts).
// They are rules, not code: the allow-list is deny / notify / scan-args, all
// implemented natively, so loading them can never execute third-party code.
// Best-effort — a failure here must never stop the process from starting.
try {
  installDeclaredHooks(hooks);
} catch (err) {
  logger.debug(`hook contract install skipped: ${err instanceof Error ? err.message : err}`);
}
