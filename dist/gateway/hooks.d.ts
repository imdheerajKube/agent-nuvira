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
declare class HookRegistry {
    private handlers;
    /** Register a handler for a hook event. Idempotent per (event, fn) pair. */
    register<T extends HookEvent>(event: T, handler: HookHandler<HookContextFor<T>>): void;
    /** Remove a handler (tests + dynamic hook lifecycle). No-op when absent. */
    unregister<T extends HookEvent>(event: T, handler: HookHandler<HookContextFor<T>>): void;
    /** Run every handler for an event, serially, best-effort (never throws). */
    run<T extends HookEvent>(event: T, ctx: HookContextFor<T>): Promise<void>;
    /** Registered handler counts per event (CLI/tests introspection). */
    list(): Record<HookEvent, number>;
}
type HookContextFor<T extends HookEvent> = T extends 'post_tool_call' ? ToolCallHookContext : SessionEndHookContext;
/** The singleton registry. */
export declare const hooks: HookRegistry;
/** Wire the registry to the event bus. Returns an unsubscribe function. */
export declare function installHooks(bus?: import("../index.js").EventBus): () => void;
/**
 * Default built-in: log pipeline session summaries ("session end
 * summary" builtin hook parity). Registered once at module load.
 */
export declare function registerBuiltinHooks(): void;
export {};
//# sourceMappingURL=hooks.d.ts.map