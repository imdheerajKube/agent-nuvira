/**
 * Agent interfaces and abstract base class for the multi-agent orchestration system.
 *
 * Each agent is a specialized unit that performs a specific role in the pipeline
 * (planning, context gathering, writing, reviewing, etc.). Agents communicate
 * through a shared {@link AgentContext} bus managed by the Orchestrator.
 */
// ─── Abstract Agent ─────────────────────────────────────────────────────────
/**
 * Base class for all specialized agents.
 *
 * To create a new agent:
 * 1. Extend this class
 * 2. Set `name` and `description`
 * 3. Implement `execute(context, callLLM)`
 */
export class Agent {
}
//# sourceMappingURL=agent.js.map