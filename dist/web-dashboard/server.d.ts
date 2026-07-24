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
/**
 * A real-time DAG state that the orchestrator can push updates to.
 * Reset before each new execution. Served via /api/dag and SSE events.
 */
interface DAGNode {
    id: string;
    agentType: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    description: string;
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
export declare function createDashboardServer(): {
    server: ReturnType<typeof createServer>;
    port: number;
    host: string;
};
export declare const DASHBOARD_DEFAULTS: {
    PORT: number;
    HOST: string;
};
export {};
//# sourceMappingURL=server.d.ts.map