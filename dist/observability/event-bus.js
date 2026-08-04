/**
 * EventBus — Structured observability system for the agent execution engine.
 *
 * Every module emits typed events that are dispatched to registered consumers.
 * Built-in consumers provide logging, DAG visualization, telemetry, and
 * failure debugging without coupling the modules to any specific output.
 *
 * @see ARCHITECTURE.md §4.2 — Observability Bus
 */
import { logger } from '../utils/logger.js';
// ─── Event Types ────────────────────────────────────────────────────────────
/** All event names emitted by the system */
export const EventNames = {
    // Plan module events
    PLAN_STARTED: 'plan:started',
    PLAN_STEP_CREATED: 'plan:step-created',
    PLAN_COMPLETED: 'plan:completed',
    // Inspect module events
    INSPECT_SCANNING: 'inspect:scanning',
    INSPECT_FILE_FOUND: 'inspect:file-found',
    INSPECT_LLM_CLASSIFY: 'inspect:llm-classify',
    INSPECT_COMPLETED: 'inspect:completed',
    // Edit module events
    EDIT_GENERATING: 'edit:generating',
    EDIT_VALIDATING: 'edit:validating',
    EDIT_WRITTEN: 'edit:written',
    EDIT_SKIPPED: 'edit:skipped',
    // Execute module events
    EXECUTE_STARTING: 'execute:starting',
    EXECUTE_COMPLETED: 'execute:completed',
    EXECUTE_FAILED: 'execute:failed',
    // Test module events
    TEST_STARTED: 'test:started',
    TEST_FAILURE: 'test:failure',
    TEST_COMPLETED: 'test:completed',
    TEST_SANDBOX_CREATED: 'test:sandbox-created',
    // Recover module events
    RECOVER_CLASSIFIED: 'recover:classified',
    RECOVER_ATTEMPT: 'recover:attempt',
    RECOVER_MODEL_SWITCH: 'recover:model-switch',
    RECOVER_BUDGET_EXHAUSTED: 'recover:budget-exhausted',
    RECOVER_RESULT: 'recover:result',
    // Verify module events
    VERIFY_STARTING: 'verify:starting',
    VERIFY_CHECK: 'verify:check',
    VERIFY_COMPLETED: 'verify:completed',
    // Report module events
    REPORT_GENERATED: 'report:generated',
    // Module registry events
    REGISTRY_MODULE_REGISTERED: 'registry:module-registered',
    REGISTRY_MODULE_UNREGISTERED: 'registry:module-unregistered',
    REGISTRY_MODULE_LOOKUP: 'registry:module-lookup',
    // Orchestrator lifecycle events
    ORCHESTRATOR_PIPELINE_STARTED: 'orchestrator:pipeline-started',
    ORCHESTRATOR_PIPELINE_COMPLETED: 'orchestrator:pipeline-completed',
    ORCHESTRATOR_TASK_STARTED: 'orchestrator:task-started',
    ORCHESTRATOR_TASK_COMPLETED: 'orchestrator:task-completed',
    /**
     * Emitted once the planner has produced a plan and the orchestrator knows
     * the full task DAG (nodes + edges). The CLI board renders the task list
     * from this event; the web dashboard DAG consumes the same data.
     */
    ORCHESTRATOR_PLAN_READY: 'orchestrator:plan-ready',
    /**
     * Emitted for live user-readable agent "thinking" updates (stage + message).
     * Powering the CLI pipeline board's activity lines.
     */
    ORCHESTRATOR_AGENT_UPDATE: 'orchestrator:agent-update',
    /**
     * Emitted for deterministic pre-flight project inspection results (framework,
     * test suite, git state) shown to the user before planning starts.
     */
    ORCHESTRATOR_INSPECTION: 'orchestrator:inspection',
    // Safe execution layer events
    SAFE_EXEC_FILE_VALIDATED: 'safe-exec:file-validated',
    SAFE_EXEC_SANDBOX_STARTING: 'safe-exec:sandbox-starting',
    SAFE_EXEC_SANDBOX_CREATED: 'safe-exec:sandbox-created',
    SAFE_EXEC_SANDBOX_COMPLETED: 'safe-exec:sandbox-completed',
    SAFE_EXEC_SANDBOX_FAILED: 'safe-exec:sandbox-failed',
    SAFE_EXEC_LLM_STARTING: 'safe-exec:llm-starting',
    SAFE_EXEC_LLM_BLOCKED: 'safe-exec:llm-blocked',
    SAFE_EXEC_LLM_RETRY: 'safe-exec:llm-retry',
    SAFE_EXEC_LLM_COMPLETED: 'safe-exec:llm-completed',
    SAFE_EXEC_LLM_FAILED: 'safe-exec:llm-failed',
    // System events
    SYSTEM_ERROR: 'system:error',
    SYSTEM_WARN: 'system:warn',
};
// ─── EventBus ───────────────────────────────────────────────────────────────
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
export class EventBus {
    /** Registered event handlers, keyed by event name ('*' for all events) */
    handlers = new Map();
    /** Ordered event history */
    history = [];
    /** Maximum history length (default: 10000, 0 = unlimited) */
    maxHistory;
    /** Whether the bus is accepting new events */
    active = true;
    constructor(maxHistory = 10_000) {
        this.maxHistory = maxHistory;
    }
    // ── Subscription ──────────────────────────────────────────────────────
    /**
     * Register a handler for a specific event name or wildcard ('*').
     *
     * @param event - Event name to listen for, or '*' for all events
     * @param handler - Callback invoked with the event record
     * @returns Unsubscribe function
     */
    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event).add(handler);
        // Return an unsubscribe function
        return () => {
            this.handlers.get(event)?.delete(handler);
        };
    }
    /**
     * Register a one-time handler that auto-unsubscribes after the first event.
     */
    once(event, handler) {
        const wrapped = (record) => {
            handler(record);
            unsubscribe();
        };
        const unsubscribe = this.on(event, wrapped);
        return unsubscribe;
    }
    /**
     * Remove all handlers for a specific event or all events.
     */
    off(event) {
        if (event) {
            this.handlers.delete(event);
        }
        else {
            this.handlers.clear();
        }
    }
    // ── Emission ──────────────────────────────────────────────────────────
    /**
     * Emit an event to all registered handlers.
     *
     * @param event - The event name
     * @param data - Structured payload (will be frozen in history)
     * @param source - Optional source module identifier
     */
    emit(event, data, source) {
        if (!this.active)
            return;
        const record = {
            event,
            timestamp: Date.now(),
            data,
            source,
        };
        // Store in history (with limit)
        this.history.push(record);
        if (this.maxHistory > 0 && this.history.length > this.maxHistory) {
            this.history = this.history.slice(-this.maxHistory);
        }
        // Dispatch to specific handlers
        const specificHandlers = this.handlers.get(event);
        if (specificHandlers) {
            for (const handler of specificHandlers) {
                try {
                    handler(record);
                }
                catch (err) {
                    console.error(`[EventBus] Handler error for '${event}':`, err);
                }
            }
        }
        // Dispatch to wildcard handlers
        const wildcardHandlers = this.handlers.get('*');
        if (wildcardHandlers) {
            for (const handler of wildcardHandlers) {
                try {
                    handler(record);
                }
                catch (err) {
                    console.error(`[EventBus] Wildcard handler error for '${event}':`, err);
                }
            }
        }
    }
    // ── History ───────────────────────────────────────────────────────────
    /**
     * Query event history with optional filters.
     */
    getHistory(filter) {
        let result = this.history;
        if (filter) {
            if (filter.eventNames && filter.eventNames.length > 0) {
                result = result.filter((r) => filter.eventNames.includes(r.event));
            }
            if (filter.sources && filter.sources.length > 0) {
                result = result.filter((r) => r.source && filter.sources.includes(r.source));
            }
            if (filter.after !== undefined) {
                result = result.filter((r) => r.timestamp >= filter.after);
            }
            if (filter.before !== undefined) {
                result = result.filter((r) => r.timestamp <= filter.before);
            }
            if (filter.limit !== undefined && filter.limit > 0) {
                result = result.slice(-filter.limit);
            }
        }
        return result;
    }
    /**
     * Clear all event history (does not remove handlers).
     */
    clearHistory() {
        this.history = [];
    }
    /**
     * Get the total number of events recorded.
     */
    get eventCount() {
        return this.history.length;
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────
    /**
     * Pause event processing. Events emitted while paused are silently dropped.
     */
    pause() {
        this.active = false;
    }
    /**
     * Resume event processing.
     */
    resume() {
        this.active = true;
    }
    /**
     * Get whether the bus is currently active.
     */
    get isActive() {
        return this.active;
    }
    /**
     * Reset the bus: clear all handlers and history.
     */
    reset() {
        this.handlers.clear();
        this.history = [];
        this.active = true;
    }
}
// ─── 1. LoggerConsumer ──────────────────────────────────────────────────────
/**
 * LoggerConsumer — Writes events to console (activated by --verbose flag).
 *
 * Maps each event type to a styled log line using the project's logger utility.
 */
export class LoggerConsumer {
    name = 'LoggerConsumer';
    unsubscribers = [];
    attach(bus) {
        // Subscribe to all events with a single wildcard handler
        this.unsubscribers.push(bus.on('*', (record) => {
            const { event, data, source } = record;
            const src = source ? `[${source}]` : '';
            // Route specific events to appropriate log levels
            // NOTE: Orchestrator task events are NOT handled here because the
            // orchestrator already logs them explicitly via logger.info().
            // Adding them here would cause duplicate output.
            switch (event) {
                // Errors & warnings
                case 'system:error':
                    logger.error(`${src} ${String(data)}`);
                    break;
                case 'system:warn':
                    logger.warn(`${src} ${String(data)}`);
                    break;
                // Plan events (not yet emitted by any module)
                case 'plan:started':
                    logger.highlight(`\n📋 Planning: ${data?.goal || ''}`);
                    break;
                case 'plan:completed':
                    logger.info(`   📋 Plan created: ${data?.stepCount || 0} steps`);
                    break;
                // Inspect events
                case 'inspect:scanning':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        if (d.directory)
                            logger.info(`   📂 Scanning ${d.directory}`);
                    }
                    break;
                case 'inspect:llm-classify':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        if (d.method === 'llm') {
                            logger.info(`   🤖 LLM classified ${d.fileCount || 0} relevant files`);
                        }
                        else {
                            logger.info(`   📂 Keyword fallback: ${d.fileCount || 0} files matched`);
                        }
                    }
                    break;
                case 'inspect:completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   📂 Found ${d.artifactCount || 0} artifacts`);
                    }
                    break;
                // Edit events
                case 'edit:written':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.success(`   ✏️ Written: ${d.path} (${d.bytes || 0} bytes)`);
                    }
                    break;
                case 'edit:skipped':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   ✏️ Skipped: ${d.path} — ${d.reason || 'no changes'}`);
                    }
                    break;
                // Execute events
                case 'execute:starting':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   ⚡ Running: ${d.command?.slice(0, 60)}`);
                    }
                    break;
                case 'execute:completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.success ? '✅' : '❌';
                        logger.info(`   ${icon} Command ${d.success ? 'succeeded' : 'failed'} (exit ${d.exitCode || '?'})`);
                    }
                    break;
                case 'execute:failed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.error(`   ❌ Execution failed: ${d.error?.slice(0, 200) || 'Unknown error'}`);
                    }
                    break;
                // Test events
                case 'test:started':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🧪 Running tests (${d.framework || 'auto-detect'})`);
                    }
                    break;
                case 'test:completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.success ? '✅' : '❌';
                        logger.info(`   ${icon} Tests: ${d.passed || 0}/${d.total || 0} passed`);
                    }
                    break;
                // Recover events
                case 'recover:classified':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🔧 Error classified: ${d.category || 'unknown'}`);
                    }
                    break;
                case 'recover:attempt':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🔧 Repair attempt ${d.attempt || '?'}: ${d.strategy || 'unknown'}`);
                    }
                    break;
                case 'recover:result':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.success ? '✅' : '❌';
                        logger.info(`   ${icon} Repair: ${d.success ? 'succeeded' : 'failed'}`);
                    }
                    break;
                // Verify events
                case 'verify:starting':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🔍 Verifying ${d.changeCount || 0} change(s) (${d.strictness || 'medium'} strictness)`);
                    }
                    break;
                case 'verify:check':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.passed ? '✅' : d.severity === 'blocking' ? '❌' : '⚠️';
                        logger.info(`   ${icon} ${d.type}: ${d.details?.slice(0, 100)}`);
                    }
                    break;
                case 'verify:completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.passed ? '✅' : '❌';
                        logger.info(`   ${icon} Verification ${d.passed ? 'passed' : 'failed'} (score: ${(d.score * 100).toFixed(0)}%)`);
                    }
                    break;
                // Registry events
                case 'registry:module-registered':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        // Built-in registrations happen on every startup — only show at debug level
                        if (d.isBuiltin) {
                            logger.debug(`   📦 Registered: ${d.agentType} (built-in)`);
                        }
                        else {
                            logger.success(`   📦 Registered: ${d.agentType}`);
                        }
                    }
                    break;
                // Pipeline lifecycle (orchestrator doesn't log these explicitly)
                case 'orchestrator:pipeline-started':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.highlight(`\n⚡ Pipeline started: ${d.goal?.slice(0, 60)}`);
                    }
                    break;
                case 'orchestrator:pipeline-completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.success ? '✅' : '❌';
                        logger.info(`   ${icon} Pipeline ${d.success ? 'succeeded' : 'failed'} (${d.tasksCompleted}/${d.tasksTotal} tasks)`);
                    }
                    break;
                case 'orchestrator:plan-ready':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   📋 Plan ready: ${d.nodeCount || 0} step(s) — ${d.parallelCount || 0} can run in parallel`);
                    }
                    break;
                case 'orchestrator:agent-update':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.debug(`   ${d.agentType || ''} · ${d.stage || ''}: ${String(d.message || '').slice(0, 120)}`);
                    }
                    break;
                case 'orchestrator:inspection':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        for (const line of d.lines || []) {
                            logger.info(`   ${line}`);
                        }
                    }
                    break;
                // Safe execution events
                case 'safe-exec:file-validated':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.passed ? '✅' : '❌';
                        logger.info(`   ${icon} File validated: ${d.path} (${d.checkCount || 0} checks)`);
                    }
                    break;
                case 'safe-exec:sandbox-starting':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🐳 Sandbox: ${d.command?.slice(0, 60)}`);
                    }
                    break;
                case 'safe-exec:sandbox-created':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.info(`   🐳 Container created: ${d.containerId}`);
                    }
                    break;
                case 'safe-exec:sandbox-completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        const icon = d.success ? '✅' : '❌';
                        logger.info(`   ${icon} Sandbox ${d.success ? 'succeeded' : 'failed'} (exit ${d.exitCode || '?'}, ${d.durationMs || 0}ms)`);
                    }
                    break;
                case 'safe-exec:sandbox-failed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.error(`   ❌ Sandbox error: ${d.error?.slice(0, 200) || 'Unknown'}`);
                    }
                    break;
                case 'safe-exec:llm-starting':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.debug(`   🤖 LLM call (${d.promptLength || 0} chars, up to ${d.maxRetries || 3} retries)`);
                    }
                    break;
                case 'safe-exec:llm-blocked':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.error(`   🚫 LLM call blocked: ${d.reason || 'unknown'} — ${d.finding?.slice(0, 80)}`);
                    }
                    break;
                case 'safe-exec:llm-retry':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.warn(`   🔄 LLM retry ${d.attempt || '?'} (backoff: ${d.backoffMs || 0}ms)`);
                    }
                    break;
                case 'safe-exec:llm-completed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.debug(`   ✅ LLM response (${d.responseLength || 0} chars${d.truncated ? ', truncated' : ''})`);
                    }
                    break;
                case 'safe-exec:llm-failed':
                    if (typeof data === 'object' && data !== null) {
                        const d = data;
                        logger.error(`   ❌ LLM call failed: ${d.error?.slice(0, 200) || 'Unknown'}`);
                    }
                    break;
                default:
                    // For verbose mode, log all events at debug level
                    logger.debug(`[event] ${event}${src} ${JSON.stringify(data).slice(0, 200)}`);
                    break;
            }
        }));
    }
    detach(bus) {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
    }
}
// ─── 2. DAGConsumer ─────────────────────────────────────────────────────────
/**
 * DAGConsumer — Pushes events to the web dashboard DAG visualization.
 *
 * Uses dynamic import to gracefully handle the case where the dashboard
 * module hasn't been built or isn't available.
 */
export class DAGConsumer {
    name = 'DAGConsumer';
    unsubscribers = [];
    dagModule = null;
    loadAttempted = false;
    /**
     * Ensure the dashboard module is loaded for the given event.
     * Uses lazy initialization per-event to avoid race conditions where
     * events arrive before the async import completes.
     */
    async ensureForEvent() {
        if (this.dagModule !== null)
            return true;
        if (this.loadAttempted)
            return false;
        this.loadAttempted = true;
        try {
            const mod = await import('../web-dashboard/server.js');
            this.dagModule = {
                pushDAGUpdate: mod.pushDAGUpdate,
                updateDAGNode: mod.updateDAGNode,
                resetDAG: mod.resetDAG,
            };
            return true;
        }
        catch {
            this.dagModule = null;
            return false;
        }
    }
    attach(bus) {
        this.unsubscribers.push(bus.on('orchestrator:pipeline-started', async (record) => {
            const loaded = await this.ensureForEvent();
            if (!loaded)
                return;
            const data = record.data;
            this.dagModule.resetDAG();
            if (data?.nodes && data?.pipelineId) {
                this.dagModule.pushDAGUpdate({
                    pipelineId: data.pipelineId,
                    pipelineDescription: data.pipelineDescription || '',
                    nodes: data.nodes,
                    edges: data.edges || [],
                });
            }
        }));
        this.unsubscribers.push(bus.on('orchestrator:task-started', async (record) => {
            const loaded = await this.ensureForEvent();
            if (!loaded)
                return;
            const data = record.data;
            if (data?.taskId) {
                this.dagModule.updateDAGNode(data.taskId, { status: 'running' });
            }
        }));
        this.unsubscribers.push(bus.on('orchestrator:task-completed', async (record) => {
            const loaded = await this.ensureForEvent();
            if (!loaded)
                return;
            const data = record.data;
            if (data?.taskId) {
                this.dagModule.updateDAGNode(data.taskId, {
                    status: data.success ? 'completed' : 'failed',
                    summary: data.summary || '',
                });
            }
        }));
    }
    detach(_bus) {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
    }
}
/**
 * TelemetryConsumer — Aggregates metrics for performance monitoring.
 *
 * Tracks event counts by type, module activity, and key performance
 * indicators (repair success rate, error counts, etc.).
 */
export class TelemetryConsumer {
    name = 'TelemetryConsumer';
    unsubscribers = [];
    counts = new Map();
    moduleCounts = new Map();
    startTime = Date.now();
    errorCount = 0;
    warningCount = 0;
    repairAttempts = 0;
    repairsSucceeded = 0;
    repairsFailed = 0;
    attach(bus) {
        this.unsubscribers.push(bus.on('*', (record) => {
            // Count by event type
            this.counts.set(record.event, (this.counts.get(record.event) || 0) + 1);
            // Count by source module
            if (record.source) {
                this.moduleCounts.set(record.source, (this.moduleCounts.get(record.source) || 0) + 1);
            }
            // Track specific metrics
            switch (record.event) {
                case 'system:error':
                    this.errorCount++;
                    break;
                case 'system:warn':
                    this.warningCount++;
                    break;
                case 'recover:attempt':
                    this.repairAttempts++;
                    break;
                case 'recover:result': {
                    const d = record.data;
                    if (d?.success)
                        this.repairsSucceeded++;
                    else
                        this.repairsFailed++;
                    break;
                }
            }
        }));
    }
    /**
     * Get a snapshot of current telemetry data.
     */
    snapshot() {
        const eventsByType = {};
        for (const [key, value] of this.counts) {
            eventsByType[key] = value;
        }
        const moduleEventCount = {};
        for (const [key, value] of this.moduleCounts) {
            moduleEventCount[key] = value;
        }
        return {
            eventsByType,
            moduleEventCount,
            totalEvents: Array.from(this.counts.values()).reduce((a, b) => a + b, 0),
            startTime: this.startTime,
            errors: this.errorCount,
            warnings: this.warningCount,
            repairAttempts: this.repairAttempts,
            repairsSucceeded: this.repairsSucceeded,
            repairsFailed: this.repairsFailed,
        };
    }
    detach(_bus) {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
    }
}
// ─── 4. DebugConsumer ───────────────────────────────────────────────────────
/**
 * DebugConsumer — Dumps full event history on failure for debugging.
 *
 * Monitors pipeline completion and dumps the event history to stderr
 * if the pipeline ended with failures.
 */
export class DebugConsumer {
    name = 'DebugConsumer';
    unsubscribers = [];
    busRef = null;
    pipelineFailed = false;
    attach(bus) {
        this.busRef = bus;
        this.unsubscribers.push(bus.on('orchestrator:task-completed', (record) => {
            const data = record.data;
            if (data?.success === false) {
                this.pipelineFailed = true;
            }
        }));
        this.unsubscribers.push(bus.on('orchestrator:pipeline-completed', () => {
            if (this.pipelineFailed && this.busRef) {
                // Dump last 50 events to stderr for debugging
                const recent = this.busRef.getHistory({ limit: 50 });
                console.error('\n=== Debug: Pipeline Failed ===');
                console.error(`Events in window: ${recent.length}`);
                for (const record of recent) {
                    const ts = new Date(record.timestamp).toISOString().slice(11, 23);
                    const src = record.source ? `[${record.source}]` : '';
                    console.error(`  ${ts} ${record.event}${src} ${JSON.stringify(record.data).slice(0, 150)}`);
                }
                console.error('=== End Debug Dump ===\n');
                this.pipelineFailed = false;
            }
        }));
    }
    detach(_bus) {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
    }
}
// ─── Global Singleton ───────────────────────────────────────────────────────
let _globalEventBus = null;
let _globalConsumers = [];
/**
 * Get or create the global EventBus singleton.
 * First call creates the bus and attaches all built-in consumers.
 */
export function getEventBus() {
    if (!_globalEventBus) {
        _globalEventBus = new EventBus();
        _globalConsumers = [
            new LoggerConsumer(),
            new DAGConsumer(),
            new TelemetryConsumer(),
            new DebugConsumer(),
        ];
        for (const consumer of _globalConsumers) {
            consumer.attach(_globalEventBus);
        }
    }
    return _globalEventBus;
}
/**
 * Reset the global EventBus singleton.
 * Primarily useful in tests.
 */
export function resetEventBus() {
    if (_globalEventBus) {
        for (const consumer of _globalConsumers) {
            consumer.detach(_globalEventBus);
        }
        _globalEventBus.reset();
    }
    _globalEventBus = null;
    _globalConsumers = [];
}
/**
 * Get the list of attached consumer instances.
 */
export function getEventBusConsumers() {
    return _globalConsumers;
}
//# sourceMappingURL=event-bus.js.map