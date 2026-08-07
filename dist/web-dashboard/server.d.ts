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
/** Test hook: is the quota file watcher currently armed? */
export declare function isQuotaWatcherArmed(): boolean;
/** Test hook: override the always-on quota watcher flag (config re-read on next create). */
export declare function setAlwaysWatchQuota(value: boolean): void;
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