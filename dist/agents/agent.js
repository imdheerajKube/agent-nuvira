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
    /**
     * Id of the task step this agent instance is currently working on.
     * Set by the orchestrator right before execute(); used to attach agent
     * "thinking" updates to the correct task line (safe under parallelism
     * because a fresh agent instance is created per task).
     */
    currentTaskId;
    /**
     * Stream a user-readable "thinking" update to the pipeline UI.
     *
     * Best-effort: never throws. If no listener is attached (e.g. tests or
     * non-UI callers), the call is a no-op.
     *
     * @param context  The shared context bus (provides the onAgentUpdate sink)
     * @param stage    Short stage label (e.g. 'analyzing', 'drafting')
     * @param message  User-readable description of what the agent is doing
     */
    report(context, stage, message) {
        try {
            context.onAgentUpdate?.({
                agentType: this.name,
                stage,
                message,
                taskId: this.currentTaskId,
            });
        }
        catch {
            // Transparency is best-effort — never let a reporting failure break the agent.
        }
    }
}
//# sourceMappingURL=agent.js.map