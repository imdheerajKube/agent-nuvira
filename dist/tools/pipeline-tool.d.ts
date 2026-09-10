/**
 * H1/E3b — Pipeline tool (`src/tools/pipeline-tool.ts`).
 *
 * The orchestrator pipeline as a CALLABLE TOOL — a first-class
 * tool-call model ("a chat turn can invoke plan/execute/edit as a tool call",
 * H1 acceptance). Extracted from `runDeveloperMode` (chat.ts) so the same
 * pipeline core serves three entry points with zero divergence:
 *   1. `nuvira chat` pre-dispatch (runDeveloperMode — thin wrapper, prints).
 *   2. The H1 tool registry (build/resume/repair tools — return a summary
 *      text fed back to the model).
 *   3. Any future command (execute/plan/run) — STANDING RULE.
 *
 * Everything the old runDeveloperMode did is preserved: auto provider/model
 * resolution (never a literal 'auto' handed to the orchestrator), model
 * health repair via resolveWorkingModel, the E3a understand-card on the live
 * board, and D1 recall wiring for `continue` (mode 'recall').
 */
import { type OrchestrationResult } from '../agents/orchestrator.js';
import type { ModeHint } from '../nlu/intent.js';
import type { TaskIntent } from '../learning/auto-router.js';
import type { ToolContext } from './registry.js';
/** Options for a pipeline tool run. */
export interface PipelineToolOptions {
    provider?: string;
    model?: string;
    /**
     * The pipeline that runs (dev/execute/recall). When absent, derived from
     * the goal's NLU dispatch (mirrors the legacy runDeveloperMode behavior —
     * `continue` requests recall automatically).
     */
    mode?: ModeHint;
    /** Router task-intent seed. */
    taskIntentHint?: TaskIntent;
    /** Pre-built recall context (resume builds it from query + timeRange). */
    recallContext?: string;
    /** Show the live ink board (default: true). */
    board?: boolean;
    /** Extra understand-card note lines (tool name transparency). */
    notes?: string[];
    /**
     * P2 — origin context for gateway-triggered runs (e.g. "WhatsApp chat
     * 9188…"): appended to the goal so the pipeline model knows who it's
     * talking to and where replies/forwarding should go.
     */
    origin?: string;
}
/** The tool-callable pipeline result. */
export interface PipelineToolResult {
    success: boolean;
    /** One-line summary (fed back to the model on tool calls). */
    summary: string;
    /** Detail lines (agent results, file changes). */
    details: string[];
    /** The raw orchestration result (for callers that print it). */
    result: OrchestrationResult | null;
    error?: string;
}
/**
 * Run the orchestrator pipeline for a goal — the shared core.
 * Returns a summary; NEVER throws (failures are captured in the result).
 */
export declare function runPipelineTool(goal: string, configManager: any, opts: PipelineToolOptions): Promise<PipelineToolResult>;
/** Detail lines from an orchestration result (agent summaries + file changes). */
export declare function buildResultDetails(result: OrchestrationResult): string[];
/**
 * H1 tool-registry adapter — runs the pipeline for a build/resume/repair tool
 * call (or an E3c task tool: document/website/analyze/test) and returns the
 * model-feedable result text (never throws).
 */
export declare function runPipelineToolFromRegistry(action: string, args: unknown, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=pipeline-tool.d.ts.map