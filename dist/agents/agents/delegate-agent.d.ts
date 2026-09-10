/**
 * H2 — DelegateAgent (`src/agents/agents/delegate-agent.ts`).
 *
 * The MODULE-REGISTRY side of H2 (acceptance: "a plan step can delegate to 3
 * sub-agents in parallel and render each live lane"). When the planner (or a
 * workflow template) emits a task step whose agentType is `delegate` and whose
 * `delegation` array carries sub-agent specs, the orchestrator runs this agent:
 * it fans the specs out in parallel via `spawnSubagents` (each with a FRESH
 * isolated context) and aggregates the summary results into a single
 * AgentResult. The parent task line renders on the board alongside the live
 * delegation lanes.
 *
 * Kept in its OWN file (not inside `tools/delegation.ts`) with a lazy dynamic
 * import of `spawnSubagents` so there is NO import cycle: the ModuleRegistry
 * imports this agent, and `tools/delegation.ts` imports the ModuleRegistry.
 * Same convention as `tools/registry.ts`' deferred imports.
 */
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '../agent.js';
import type { ModuleRegistry } from '../module-registry.js';
export declare class DelegateAgent extends Agent {
    readonly name = "Delegate";
    readonly description = "Fans out sub-agent delegation specs (taskStep.delegation) in parallel with fresh isolated contexts and aggregates their summary results";
    /**
     * Registry override for tests (matches the codebase pattern of public
     * agent-instance fields, like `currentTaskId`). Production leaves this
     * unset so spawnSubagents resolves the global ModuleRegistry.
     */
    delegationRegistry?: ModuleRegistry;
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
//# sourceMappingURL=delegate-agent.d.ts.map