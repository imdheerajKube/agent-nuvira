/**
 * Web Dashboard Server — Serves the Agent-Nuvira dashboard UI and data APIs.
 *
 * Uses only Node.js built-in modules (no Express, no WebSocket libraries):
 * - Static files: HTML, CSS, JS from public/
 * - REST API: cost, history, benchmark, memory, health data
 * - SSE (Server-Sent Events): real-time updates
 *
 * Start with: agent-nuvira dashboard
 * Opens at: http://localhost:3030
 */
import { createServer } from 'node:http';
import { WhatsAppPairingManager } from './whatsapp-pairing.js';
import { ChatConsole } from './chat-console.js';
/** Test hook: is the quota file watcher currently armed? */
export declare function isQuotaWatcherArmed(): boolean;
/** Test hook: override the always-on quota watcher flag (config re-read on next create). */
export declare function setAlwaysWatchQuota(value: boolean): void;
/** Broadcast a typing indicator event to all SSE clients. */
export declare function broadcastTyping(event: {
    platform: string;
    channelId: string;
    typing: boolean;
}): void;
/**
 * A real-time DAG state that the orchestrator can push updates to.
 * Reset before each new execution. Served via /api/dag and SSE events.
 */
interface DAGNode {
    id: string;
    agentType: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    description: string;
    /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
    complexity?: string;
    summary?: string;
    startedAt?: number;
    completedAt?: number;
}
interface DAGEdge {
    from: string;
    to: string;
}
/** One recorded tool call of a loop turn. */
export interface LoopToolCallTelemetry {
    tool: string;
    ok?: boolean;
    durationMs?: number;
    error?: string;
}
/** Per-turn loop telemetry (the DAG view's turn card + persisted run field). */
export interface LoopTurnTelemetry {
    turnId: string;
    /** First user message of the turn (truncated) — the run/goal label. */
    title: string;
    startedAt: number;
    endedAt?: number;
    toolCalls: LoopToolCallTelemetry[];
    toolCallCount: number;
    erroredToolCount: number;
    provider?: string;
    model?: string;
    bounded?: boolean;
    generationFailed?: boolean;
    cancelled?: boolean;
    active: boolean;
}
/**
 * Stamp the engine context for the DAG badge (Phase 4). Called by the
 * pipeline path (pushDAGUpdate → 'pipeline') and the loop-turn hooks
 * (beginLoopTurn → 'loop'). `explanation` is the engine router's audit line.
 */
export declare function setLoopEngineContext(engine: 'loop' | 'pipeline', explanation?: string): void;
/**
 * Begin a loop turn's telemetry window (Phase 4). Any previous turn is
 * replaced (the DAG view shows the CURRENT/LATEST turn only).
 */
export declare function beginLoopTurn(turnId: string, title: string, provider?: string, model?: string): void;
/** Record one tool call of the active loop turn (no-op when none). */
export declare function recordLoopToolCall(call: LoopToolCallTelemetry): void;
/**
 * End the active loop turn (Phase 4): stamp the outcome, persist a
 * loop-engine run to the timeline (phases = tool calls, engine 'loop'), and
 * mark the turn inactive (its card remains until the next run/turn).
 */
export declare function endLoopTurn(extra: {
    bounded?: boolean;
    generationFailed?: boolean;
    cancelled?: boolean;
}): void;
/** Clear the loop-turn card (new pipeline run replaces the loop view). */
export declare function clearLoopTurn(): void;
/**
 * Called by the orchestrator to push a DAG update in real time.
 * Clears the pipeline when a new execution starts.
 */
export declare function pushDAGUpdate(update: {
    pipelineId?: string;
    pipelineDescription?: string;
    nodes: Array<Omit<DAGNode, 'startedAt' | 'completedAt'>>;
    edges: DAGEdge[];
}): void;
/** Update a single node's status (called by orchestrator as each agent finishes) */
export declare function updateDAGNode(nodeId: string, update: {
    status: DAGNode['status'];
    summary?: string;
}): void;
/** Reset the DAG state for a fresh execution */
export declare function resetDAG(): void;
/** Read DAG data: in-memory first, fall back to recent trajectories */
export declare function readDAGData(): Record<string, unknown>;
/**
 * A phase in a pipeline run — mirrors the DAG node shape with a computed
 * duration so the frontend can size timeline blocks proportionally.
 */
interface PipelinePhase {
    id: string;
    agentType: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    description: string;
    /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
    complexity?: string;
    summary?: string;
    startedAt?: number;
    completedAt?: number;
    /** Computed duration (ms) when both timestamps are known. */
    durationMs?: number;
}
/** One persisted pipeline execution, rebuilt from the event-bus DAG timeline. */
interface PipelineRun {
    id: string;
    goal: string;
    startedAt: number;
    endedAt?: number;
    success?: boolean;
    totalDurationMs: number;
    phases: PipelinePhase[];
    /** Phase 4 — which engine executed ('pipeline' | 'loop'). */
    engine?: 'pipeline' | 'loop';
    /** Phase 4 — loop-engine turns: per-turn tool-call telemetry. */
    turnTelemetry?: {
        toolCallCount: number;
        erroredToolCount: number;
        bounded?: boolean;
        generationFailed?: boolean;
        provider?: string;
        model?: string;
    };
}
/**
 * Read the persisted pipeline runs, most recent first.
 */
export declare function readPipelineRuns(): {
    total: number;
    runs: PipelineRun[];
};
/** One LLM call recorded in a trace (matches the CLI's reasoning-trace shape). */
interface DashboardTraceStep {
    seq: number;
    timestamp: number;
    agentType: string;
    taskId?: string;
    description?: string;
    provider: string;
    model: string;
    promptDigest: string;
    promptPreview: string;
    responsePreview: string;
    responseLength: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    success: boolean;
    error?: string;
    routing?: {
        provider: string;
        model: string;
        score: number;
        complexity: string;
        explanation: string;
    };
}
interface DashboardTrace {
    id: string;
    goal: string;
    source: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    provider?: string;
    model?: string;
    success?: boolean;
    /**
     * WHAT ACTUALLY HAPPENED — `answered` (text only) vs `acted` (a tool ran),
     * plus `unverifiedClaim`. Shown in the Trace tab so a hallucinated
     * "I sent it" can never look like a real delivery.
     */
    outcome?: {
        kind: 'answered' | 'acted' | 'failed' | 'cancelled';
        tools?: string[];
        delivered?: boolean;
        unverifiedClaim?: boolean;
    };
    steps: DashboardTraceStep[];
}
/**
 * List traces, most recent first, WITHOUT prompt/response previews (the index
 * view stays small). Includes per-trace aggregate counts so the panel can
 * render summary cards without the full steps.
 */
export declare function readTracesData(): {
    total: number;
    traces: Array<Omit<DashboardTrace, 'steps'> & {
        stepCount: number;
        failedSteps: number;
        totalTokens: number;
    }>;
};
/** Full trace detail (steps included) for the replay view. */
export declare function readTraceDetail(id: string): DashboardTrace | null;
/** Test hook: swap the chat console (e.g. a fake engine) — routes read the
 * module variable at request time, so this works anytime. The Phase 4
 * DAG-telemetry hook is re-attached to the replacement. */
export declare function setChatConsoleForTest(console: ChatConsole): void;
/**
 * Run the dashboard shutdown action (test hook: swap to a no-op so API tests
 * exercising /api/admin/shutdown never exit the test runner).
 */
export declare function setDashboardShutdownForTest(action: (() => void) | null): void;
/** Test hook: stub the gateway-stop action (null restores the real one). */
export declare function setGatewayShutdownForTest(action: (() => Promise<{
    stopped: boolean;
    pid?: number;
    reason?: string;
}>) | null): void;
/**
 * Test hook: swap the pairing manager (e.g. for a fake-bridge manager) so
 * /api/whatsapp integration tests never open a real WhatsApp connection.
 * Routes read the module variable at request time, so this works anytime.
 */
export declare function setWhatsappPairingForTest(manager: WhatsAppPairingManager): void;
export interface DashboardServerHandle {
    server: ReturnType<typeof createServer>;
    port: number;
    host: string;
    /**
     * IPv6-loopback twin sharing the SAME request handler — the permanent fix
     * for the "Dashboard server unreachable / Failed to fetch" issue. macOS
     * resolves `localhost` → `::1` (IPv6) BEFORE `127.0.0.1` (IPv4), so an
     * IPv4-only bind makes the browser hit `[::1]:port` → ECONNREFUSED → the
     * Models page error banner. Binding BOTH loopback families means `localhost`
     * works regardless of resolution order. Undefined when IPv6 loopback is
     * unavailable or the primary host is non-loopback.
     */
    ipv6Twin?: ReturnType<typeof createServer>;
}
export declare function createDashboardServer(opts?: {
    port?: number;
    host?: string;
}): DashboardServerHandle;
export declare const DASHBOARD_DEFAULTS: {
    PORT: number;
    HOST: string;
};
export {};
//# sourceMappingURL=server.d.ts.map