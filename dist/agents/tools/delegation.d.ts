/**
 * H2 — Sub-agent registry + live delegation (`src/agents/tools/delegation.ts`).
 *
 * The second half of the "missing core" (capability gap #2):
 * a parent task — or the chat model via the `delegate` tool — can spawn
 * specialized agents (context-gatherer, reviewer, security, tester, ...) as
 * sub-tasks, each with a FRESH, isolated context.
 * `tools/delegate_tool.py`: the child gets a fresh conversation, isolated
 * context, its own task id, and a focused system prompt — the parent only ever
 * sees the delegation call + summary result, never the child's intermediate
 * turns.
 *
 * Design:
 * - Agent lookup through the SAME ModuleRegistry the orchestrator uses — the
 *   registry is the only place agents are declared (H2 acceptance).
 * - `spawnSubagent()` runs one sub-agent; `spawnSubagents()` fans out in
 *   parallel and aggregates (the orchestrator's Promise.all pattern).
 * - Budget/loop guards: max sub-agents per turn, per-sub-agent timeout, and an
 *   AbortSignal kill-switch.
 * - Every spawn/result/error streams `delegation:*` events on the EventBus so
 *   the E2 board renders live lanes (and the NDJSON stream + web dashboard
 *   reuse the same source of truth).
 */
import { type ModuleRegistry } from '../module-registry.js';
import type { LLMCallFn, TaskDelegation } from '../agent.js';
/**
 * A single sub-agent request. Alias of the shared `TaskDelegation` shape so a
 * delegate plan step and a direct spawnSubagent call speak ONE vocabulary
 * (the SAME shape flows taskStep.delegation → spawnSubagents).
 */
export type SubagentRequest = TaskDelegation;
/** Options for spawning one or many sub-agents. */
export interface SpawnSubagentOptions {
    /** The LLM function the sub-agent uses (the parent's resolved provider). */
    callLLM: LLMCallFn;
    /** Working directory for the sub-agent context (default: process.cwd()). */
    cwd?: string;
    /** Agent registry (default: the global ModuleRegistry with builtins). */
    registry?: ModuleRegistry;
    /** Event sink (default: the global EventBus emit). Injectable for tests. */
    emit?: (event: string, data: unknown, source?: string) => void;
    /** Per-sub-agent timeout in ms (default: 120_000). */
    timeoutMs?: number;
    /** Max sub-agents per fan-out (default: 4). Extra requests are skipped. */
    maxSubagents?: number;
    /** External kill-switch — aborting the signal kills in-flight sub-agents. */
    signal?: AbortSignal;
}
/** The result of one sub-agent run — a SUMMARY, never the child's transcript. */
export interface SubagentResult {
    id: string;
    agentType: string;
    success: boolean;
    summary: string;
    durationMs: number;
    error?: string;
    timedOut?: boolean;
    killed?: boolean;
    skipped?: boolean;
}
/**
 * Spawn ONE sub-agent with a fresh, isolated context and a summary result.
 *
 * Streams `delegation:spawn` → `delegation:result` (or `delegation:error`) on
 * the event bus so the live board renders a lane. Never throws: failures,
 * timeouts, and kills all resolve to a `SubagentResult` with `success: false`.
 */
export declare function spawnSubagent(request: SubagentRequest, opts: SpawnSubagentOptions): Promise<SubagentResult>;
/**
 * Spawn N sub-agents in PARALLEL and aggregate their summary results
 * (spawn_agents / orchestrator Promise.all pattern).
 *
 * Budget guard: requests beyond `maxSubagents` (default 4) are NOT spawned —
 * they resolve as `skipped` results so the caller/model sees the truncation.
 */
export declare function spawnSubagents(requests: SubagentRequest[], opts: SpawnSubagentOptions): Promise<SubagentResult[]>;
//# sourceMappingURL=delegation.d.ts.map