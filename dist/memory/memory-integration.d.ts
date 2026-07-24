/**
 * MemoryIntegration — Connects the persistent memory system to the Orchestrator.
 *
 * This module provides the glue between agent execution and memory:
 * - Before planning: retrieves similar past trajectories as few-shot examples
 * - After execution: stores the successful trajectory for future use
 *
 * The Orchestrator calls these hooks when the `useMemory` option is enabled.
 */
import type { TaskStep } from '../agents/agent.js';
import type { LLMCallFn } from '../agents/agent.js';
import type { OrchestrationResult } from '../agents/orchestrator.js';
import type { Trajectory } from './trajectory-store.js';
/**
 * Retrieve relevant past trajectories to use as few-shot examples
 * for the PlannerAgent.
 *
 * @param goal     The current user goal
 * @param callLLM  LLM function for embedding generation
 * @param k        Maximum number of trajectories to retrieve
 * @returns        An object with:
 *   - trajectories: the raw trajectory objects
 *   - fewShotContext: formatted string for injection into planner prompts
 */
export declare function retrieveMemoryContext(goal: string, callLLM: LLMCallFn, k?: number): Promise<{
    trajectories: Trajectory[];
    fewShotContext: string;
    patternContext: string;
}>;
/**
 * Store a successful orchestration result as a trajectory for future use.
 * This is called at the end of the orchestration pipeline.
 *
 * @param result         The orchestration result
 * @param callLLM        LLM function for embedding generation
 * @param taskPlan       The task plan that was executed
 * @param contextFiles   The files that were gathered as context
 * @param verbose        Whether to log details
 * @returns              The trajectory ID, or empty string if not saved
 */
export declare function storeExecutionTrajectory(result: OrchestrationResult, callLLM: LLMCallFn, taskPlan: TaskStep[], contextFiles: string[], verbose?: boolean): Promise<string>;
/**
 * Get memory storage statistics.
 */
export declare function getMemoryStats(): Promise<{
    total: number;
    avgScore: number;
    byProjectFingerprint: Record<string, number>;
}>;
/**
 * Clear all stored memory (trajectories and vector index).
 * Also resets the embedding tier cache so native embeddings (Xenova/Python)
 * can be re-detected on the next embedding call.
 */
export declare function clearMemory(): Promise<void>;
//# sourceMappingURL=memory-integration.d.ts.map