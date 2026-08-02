/**
 * EventBus — Structured observability system for the agent execution engine.
 *
 * Every module emits typed events that are dispatched to registered consumers.
 * Built-in consumers provide logging, DAG visualization, telemetry, and
 * failure debugging without coupling the modules to any specific output.
 *
 * @see ARCHITECTURE.md §4.2 — Observability Bus
 */
/** All event names emitted by the system */
export declare const EventNames: {
    readonly PLAN_STARTED: "plan:started";
    readonly PLAN_STEP_CREATED: "plan:step-created";
    readonly PLAN_COMPLETED: "plan:completed";
    readonly INSPECT_SCANNING: "inspect:scanning";
    readonly INSPECT_FILE_FOUND: "inspect:file-found";
    readonly INSPECT_LLM_CLASSIFY: "inspect:llm-classify";
    readonly INSPECT_COMPLETED: "inspect:completed";
    readonly EDIT_GENERATING: "edit:generating";
    readonly EDIT_VALIDATING: "edit:validating";
    readonly EDIT_WRITTEN: "edit:written";
    readonly EDIT_SKIPPED: "edit:skipped";
    readonly EXECUTE_STARTING: "execute:starting";
    readonly EXECUTE_COMPLETED: "execute:completed";
    readonly EXECUTE_FAILED: "execute:failed";
    readonly TEST_STARTED: "test:started";
    readonly TEST_FAILURE: "test:failure";
    readonly TEST_COMPLETED: "test:completed";
    readonly TEST_SANDBOX_CREATED: "test:sandbox-created";
    readonly RECOVER_CLASSIFIED: "recover:classified";
    readonly RECOVER_ATTEMPT: "recover:attempt";
    readonly RECOVER_MODEL_SWITCH: "recover:model-switch";
    readonly RECOVER_BUDGET_EXHAUSTED: "recover:budget-exhausted";
    readonly RECOVER_RESULT: "recover:result";
    readonly VERIFY_STARTING: "verify:starting";
    readonly VERIFY_CHECK: "verify:check";
    readonly VERIFY_COMPLETED: "verify:completed";
    readonly REPORT_GENERATED: "report:generated";
    readonly REGISTRY_MODULE_REGISTERED: "registry:module-registered";
    readonly REGISTRY_MODULE_UNREGISTERED: "registry:module-unregistered";
    readonly REGISTRY_MODULE_LOOKUP: "registry:module-lookup";
    readonly ORCHESTRATOR_PIPELINE_STARTED: "orchestrator:pipeline-started";
    readonly ORCHESTRATOR_PIPELINE_COMPLETED: "orchestrator:pipeline-completed";
    readonly ORCHESTRATOR_TASK_STARTED: "orchestrator:task-started";
    readonly ORCHESTRATOR_TASK_COMPLETED: "orchestrator:task-completed";
    readonly SAFE_EXEC_FILE_VALIDATED: "safe-exec:file-validated";
    readonly SAFE_EXEC_SANDBOX_STARTING: "safe-exec:sandbox-starting";
    readonly SAFE_EXEC_SANDBOX_CREATED: "safe-exec:sandbox-created";
    readonly SAFE_EXEC_SANDBOX_COMPLETED: "safe-exec:sandbox-completed";
    readonly SAFE_EXEC_SANDBOX_FAILED: "safe-exec:sandbox-failed";
    readonly SAFE_EXEC_LLM_STARTING: "safe-exec:llm-starting";
    readonly SAFE_EXEC_LLM_BLOCKED: "safe-exec:llm-blocked";
    readonly SAFE_EXEC_LLM_RETRY: "safe-exec:llm-retry";
    readonly SAFE_EXEC_LLM_COMPLETED: "safe-exec:llm-completed";
    readonly SAFE_EXEC_LLM_FAILED: "safe-exec:llm-failed";
    readonly SYSTEM_ERROR: "system:error";
    readonly SYSTEM_WARN: "system:warn";
};
export type EventName = (typeof EventNames)[keyof typeof EventNames];
/** A single event record stored in the bus history */
export interface EventRecord {
    /** The event name (e.g. 'recover:classified') */
    event: EventName;
    /** The timestamp when the event was emitted (ms since epoch) */
    timestamp: number;
    /** The payload data associated with the event */
    data: unknown;
    /** Optional source module that emitted the event */
    source?: string;
}
/** Filter for querying event history */
export interface EventFilter {
    /** Include only events matching these names */
    eventNames?: EventName[];
    /** Include only events from these sources */
    sources?: string[];
    /** Include only events after this timestamp */
    after?: number;
    /** Include only events before this timestamp */
    before?: number;
    /** Maximum number of records to return */
    limit?: number;
}
/** Handler function registered for event notifications */
export type EventHandler = (record: EventRecord) => void;
/**
 * EventBus — Central event dispatch and history store.
 *
 * Features:
 * - Subscribe to events by name or wildcard (*)
 * - Emit typed events with structured payloads
 * - Query event history with filters
 * - Lifecycle management (start/stop, clear history)
 *
 * @example
 * ```typescript
 * const bus = new EventBus();
 * bus.on('recover:classified', (record) => {
 *   logger.info(`[${record.event}] ${JSON.stringify(record.data)}`);
 * });
 * bus.emit('recover:classified', { category: 'llm-error', strategy: 're-prompt' });
 * ```
 */
export declare class EventBus {
    /** Registered event handlers, keyed by event name ('*' for all events) */
    private handlers;
    /** Ordered event history */
    private history;
    /** Maximum history length (default: 10000, 0 = unlimited) */
    private maxHistory;
    /** Whether the bus is accepting new events */
    private active;
    constructor(maxHistory?: number);
    /**
     * Register a handler for a specific event name or wildcard ('*').
     *
     * @param event - Event name to listen for, or '*' for all events
     * @param handler - Callback invoked with the event record
     * @returns Unsubscribe function
     */
    on(event: EventName | '*', handler: EventHandler): () => void;
    /**
     * Register a one-time handler that auto-unsubscribes after the first event.
     */
    once(event: EventName | '*', handler: EventHandler): () => void;
    /**
     * Remove all handlers for a specific event or all events.
     */
    off(event?: EventName | '*'): void;
    /**
     * Emit an event to all registered handlers.
     *
     * @param event - The event name
     * @param data - Structured payload (will be frozen in history)
     * @param source - Optional source module identifier
     */
    emit(event: EventName, data: unknown, source?: string): void;
    /**
     * Query event history with optional filters.
     */
    getHistory(filter?: EventFilter): EventRecord[];
    /**
     * Clear all event history (does not remove handlers).
     */
    clearHistory(): void;
    /**
     * Get the total number of events recorded.
     */
    get eventCount(): number;
    /**
     * Pause event processing. Events emitted while paused are silently dropped.
     */
    pause(): void;
    /**
     * Resume event processing.
     */
    resume(): void;
    /**
     * Get whether the bus is currently active.
     */
    get isActive(): boolean;
    /**
     * Reset the bus: clear all handlers and history.
     */
    reset(): void;
}
/**
 * Consumer interface for registering with an EventBus.
 */
export interface EventBusConsumer {
    /** Human-readable consumer name for logging */
    readonly name: string;
    /** Called with the EventBus instance so the consumer can register handlers */
    attach(bus: EventBus): void;
    /** Called to detach handlers (cleanup) */
    detach(bus: EventBus): void;
}
/**
 * LoggerConsumer — Writes events to console (activated by --verbose flag).
 *
 * Maps each event type to a styled log line using the project's logger utility.
 */
export declare class LoggerConsumer implements EventBusConsumer {
    readonly name = "LoggerConsumer";
    private unsubscribers;
    attach(bus: EventBus): void;
    detach(bus: EventBus): void;
}
/**
 * DAGConsumer — Pushes events to the web dashboard DAG visualization.
 *
 * Uses dynamic import to gracefully handle the case where the dashboard
 * module hasn't been built or isn't available.
 */
export declare class DAGConsumer implements EventBusConsumer {
    readonly name = "DAGConsumer";
    private unsubscribers;
    private dagModule;
    private loadAttempted;
    /**
     * Ensure the dashboard module is loaded for the given event.
     * Uses lazy initialization per-event to avoid race conditions where
     * events arrive before the async import completes.
     */
    private ensureForEvent;
    attach(bus: EventBus): void;
    detach(_bus: EventBus): void;
}
/** Aggregated telemetry snapshot */
export interface TelemetrySnapshot {
    eventsByType: Record<string, number>;
    moduleEventCount: Record<string, number>;
    totalEvents: number;
    startTime: number;
    errors: number;
    warnings: number;
    repairAttempts: number;
    repairsSucceeded: number;
    repairsFailed: number;
}
/**
 * TelemetryConsumer — Aggregates metrics for performance monitoring.
 *
 * Tracks event counts by type, module activity, and key performance
 * indicators (repair success rate, error counts, etc.).
 */
export declare class TelemetryConsumer implements EventBusConsumer {
    readonly name = "TelemetryConsumer";
    private unsubscribers;
    private counts;
    private moduleCounts;
    private startTime;
    private errorCount;
    private warningCount;
    private repairAttempts;
    private repairsSucceeded;
    private repairsFailed;
    attach(bus: EventBus): void;
    /**
     * Get a snapshot of current telemetry data.
     */
    snapshot(): TelemetrySnapshot;
    detach(_bus: EventBus): void;
}
/**
 * DebugConsumer — Dumps full event history on failure for debugging.
 *
 * Monitors pipeline completion and dumps the event history to stderr
 * if the pipeline ended with failures.
 */
export declare class DebugConsumer implements EventBusConsumer {
    readonly name = "DebugConsumer";
    private unsubscribers;
    private busRef;
    private pipelineFailed;
    attach(bus: EventBus): void;
    detach(_bus: EventBus): void;
}
/**
 * Get or create the global EventBus singleton.
 * First call creates the bus and attaches all built-in consumers.
 */
export declare function getEventBus(): EventBus;
/**
 * Reset the global EventBus singleton.
 * Primarily useful in tests.
 */
export declare function resetEventBus(): void;
/**
 * Get the list of attached consumer instances.
 */
export declare function getEventBusConsumers(): ReadonlyArray<EventBusConsumer>;
//# sourceMappingURL=event-bus.d.ts.map