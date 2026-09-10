/**
 * ResilientCallLLM — Smart proxy that wraps the auto-router and provides
 * automatic failover for ANY LLM call, anywhere in the codebase.
 *
 * Problem it solves:
 * - Tools, skills, sub-agents, memory all receive a FIXED callLLM bound to
 *   one provider at task start. If that provider fails mid-execution, the
 *   tool just fails.
 * - The 3-candidate cap in chat.ts means only 3 providers are tried.
 * - Session failures aren't persisted across pipelines.
 *
 * Solution:
 * - callLLM becomes a smart proxy that internally re-routes on ANY failure
 * - Tries ALL ranked candidates (no cap)
 * - Tracks failures across the entire session (not just per-task)
 * - Tools/sub-agents use it transparently — they don't know failover happens
 *
 * Usage:
 *   const callLLM = createResilientCallLLM(task, configManager, options);
 *   // Now callLLM automatically re-routes on failure
 *   const result = await callLLM("Implement JWT auth");
 *
 * Integration:
 *   - Orchestrator: replace createAutoRoutedLLM with createResilientCallLLM
 *   - Chat: replace buildToolCallModel's tryGenerate with resilient wrapper
 *   - Tools: ctx.callLLM is already resilient (inherited from orchestrator)
 */
import type { ConfigManager } from '../config/manager.js';
import type { LLMCallFn } from '../agents/agent.js';
/** Configuration for the resilient proxy. */
export interface ResilientCallOptions {
    /** Whether to persist failures to disk for cross-pipeline memory (default: true). */
    crossPipelineMemory?: boolean;
    /** Verbose logging (default: false). */
    verbose?: boolean;
    /** Original task info for routing decisions. */
    task: {
        agentType: string;
        description: string;
        complexity?: string;
        taskId?: string;
        contextHintTokens?: number;
    };
}
/**
 * Create a resilient callLLM that auto-routes on ANY failure.
 *
 * Unlike the orchestrator's fixed-bound callLLM, this proxy:
 * 1. Routes to the auto-router's best candidate initially
 * 2. On ANY failure (not just rate-limit), re-routes to the next candidate
 * 3. Tries ALL ranked candidates (no 3-candidate cap)
 * 4. Tracks failures across the session AND persists to disk
 * 5. Tools/sub-agents use it transparently
 */
export declare function createResilientCallLLM(configManager: ConfigManager, options: ResilientCallOptions): LLMCallFn;
//# sourceMappingURL=resilient-call.d.ts.map