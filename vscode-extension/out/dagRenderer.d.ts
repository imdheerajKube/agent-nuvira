/**
 * DAG Renderer — SVG DAG visualization for the agent execution pipeline.
 *
 * Renders a directed acyclic graph (DAG) of the multi-agent pipeline inline
 * in the chat panel. Supports real-time updates with animated transitions
 * for running, completed, and failed agent nodes.
 *
 * Ported from the web dashboard's React DAGView component (src/web-dashboard/src/components/DAGView.tsx)
 * to vanilla JS for use in the VS Code webview.
 */
export interface PipelineNode {
    id: string;
    agentType: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    description: string;
    summary?: string;
    startedAt?: number;
    completedAt?: number;
}
export interface PipelineEdge {
    from: string;
    to: string;
}
export interface PipelineState {
    pipeline: string;
    active: boolean;
    nodes: PipelineNode[];
    edges: PipelineEdge[];
}
/**
 * Render a pipeline state as an SVG HTML string.
 *
 * @param state - The current pipeline state (nodes, edges, metadata)
 * @returns An SVG HTML string ready to inject into the chat panel
 */
export declare function renderDAG(state: PipelineState): string;
/**
 * Render an empty pipeline state (no active pipeline).
 */
export declare function renderEmptyDAG(): string;
/**
 * Build a PipelineState from a list of completed agent results.
 * Useful for rendering the final DAG after a pipeline completes.
 */
export declare function buildPipelineState(pipelineName: string, agents: Array<{
    agentType: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    summary?: string;
    startedAt?: number;
    completedAt?: number;
}>): PipelineState;
//# sourceMappingURL=dagRenderer.d.ts.map