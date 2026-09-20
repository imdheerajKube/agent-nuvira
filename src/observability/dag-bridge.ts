/**
 * DAG bridge — a dependency-inversion seam for the dashboard's pipeline graph.
 *
 * WHY THIS EXISTS
 * The DAG state (`pushDAGUpdate` / `updateDAGNode` / `resetDAG`) lives in the
 * dashboard (`src/web-dashboard/server.ts`, a 270 KB module) because it is
 * broadcast to browser clients over SSE. But the producers of those updates are
 * LOW-LEVEL modules: `observability/event-bus.ts` (which nearly everything
 * imports) and `agents/orchestrator.ts`.
 *
 * They reached the dashboard with `await import('../web-dashboard/server.js')`,
 * which meant:
 *   - the import graph gained an upward edge from the observability/agent layer
 *     into the web layer (a cycle — see `scripts/check-import-cycles.mjs`);
 *   - a CLI pipeline run (`nuvira execute --engine pipeline`, no dashboard
 *     involved) still loaded the entire 270 KB dashboard module on the first
 *     DAG event, mutating in-process DAG state that nothing could read.
 *
 * The fix is inversion, not deferral: producers call THIS module, and the
 * dashboard registers its implementation when it loads. With no dashboard in
 * the process the calls are cheap no-ops — which is exactly what the state
 * updates amounted to before, minus loading the web server to discover it.
 *
 * Layering rule: anything may import this file; this file imports NOTHING from
 * web-dashboard, cli, agents, or gateway (type-only shapes are declared here).
 */

/** A pipeline-graph update: the nodes/edges of a run plus its identity. */
export interface DagUpdate {
  pipelineId?: string;
  pipelineDescription?: string;
  nodes: Array<{ id: string; agentType: string; status: string; description: string }>;
  edges: Array<{ from: string; to: string }>;
}

/** A single node transition (`running` → `completed` / `failed`). */
export interface DagNodePatch {
  status: string;
  summary?: string;
}

/** What the dashboard provides when it is present in the process. */
export interface DagHandlers {
  pushDAGUpdate(update: DagUpdate): void;
  updateDAGNode(nodeId: string, patch: DagNodePatch): void;
  resetDAG(): void;
}

let handlers: DagHandlers | null = null;

/**
 * Register the dashboard's DAG implementation. Called by the dashboard server
 * when its module loads; the LAST registration wins (re-importing the server in
 * a test replaces the previous one rather than stacking).
 */
export function registerDagHandlers(next: DagHandlers): void {
  handlers = next;
}

/** Unregister (tests). Leaves producers as no-ops. */
export function clearDagHandlers(): void {
  handlers = null;
}

/** Whether a dashboard is present in this process (diagnostics + tests). */
export function hasDagHandlers(): boolean {
  return handlers !== null;
}

/** Replace the whole graph with a pipeline's nodes/edges. No-op without a dashboard. */
export function pushDAGUpdate(update: DagUpdate): void {
  handlers?.pushDAGUpdate(update);
}

/** Transition one node. No-op without a dashboard. */
export function updateDAGNode(nodeId: string, patch: DagNodePatch): void {
  handlers?.updateDAGNode(nodeId, patch);
}

/** Clear the graph. No-op without a dashboard. */
export function resetDAG(): void {
  handlers?.resetDAG();
}
