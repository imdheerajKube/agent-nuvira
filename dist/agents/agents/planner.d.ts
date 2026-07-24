/**
 * PlannerAgent — Analyzes a user goal and produces an ordered, dependency-aware
 * execution plan consisting of TaskSteps for other agents to execute.
 *
 * The planner is the first agent to run in every orchestration session.
 * It now receives the project file tree (injected by the Orchestrator via
 * context.metadata.projectFileTree) so it can make informed decisions about
 * which files to create, modify, or reference in its plan.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * PlannerAgent — Decomposes user goals into ordered task plans.
 * Now accepts `projectFileTree` from context.metadata to make informed plans.
 */
export declare class PlannerAgent extends Agent {
    readonly name = "Planner";
    readonly description = "Analyzes user goals and creates detailed execution plans";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Extract the task plan from the LLM response.
     * Tries JSON.parse first, then falls back to extracting from code blocks.
     */
    private parsePlan;
}
//# sourceMappingURL=planner.d.ts.map