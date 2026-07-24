/**
 * @agent-nuvira/sdk/agent — Abstract base class for building custom agents.
 *
 * To create a custom agent:
 * ```ts
 * import { Agent, type AgentContext, type AgentResult } from '@agent-nuvira/sdk';
 *
 * export class MyAgent extends Agent {
 *   readonly name = 'MyAgent';
 *   readonly description = 'Does something useful';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     // Read context artifacts, call the LLM, produce results
 *     return { success: true, summary: 'Task completed' };
 *   }
 * }
 * ```
 *
 * @module @agent-nuvira/sdk/agent
 */
// ─── Base Agent ─────────────────────────────────────────────────────────────
/**
 * Abstract base class for all specialized agents.
 *
 * Every agent in the system extends this class. Agents are executed by the
 * Orchestrator, which provides them with a shared {@link AgentContext} and an
 * {@link LLMCallFn} for invoking the configured language model.
 *
 * ## Agent Lifecycle
 *
 * 1. **Construct** — The agent is created by the orchestrator's agent registry
 * 2. **Validate** — {@link validate} is called (override to check prerequisites)
 * 3. **Execute** — {@link execute} is called with the full context and LLM function
 * 4. **Cleanup** — {@link cleanup} is called regardless of success/failure
 *
 * ## Example
 *
 * ```ts
 * class CodeFormatterAgent extends Agent {
 *   readonly name = 'CodeFormatter';
 *   readonly description = 'Formats source code using project conventions';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     const code = context.artifacts.find(a => a.path.endsWith('.ts'));
 *     if (!code) {
 *       return { success: false, summary: 'No TypeScript file found' };
 *     }
 *
 *     const formatted = await callLLM(
 *       `Format this code:\n\`\`\`\n${code.content}\n\`\`\``
 *     );
 *
 *     context.fileChanges.push({
 *       path: code.path,
 *       originalContent: code.content,
 *       newContent: formatted,
 *       status: 'modified',
 *     });
 *
 *     return { success: true, summary: `Formatted ${code.path}` };
 *   }
 * }
 * ```
 */
export class Agent {
    /**
     * Validate that the agent can run with the given context.
     * Override this to check prerequisites before execution.
     *
     * Default implementation returns `true` (no validation).
     *
     * @param context  The shared context bus
     * @returns        `true` if the agent is ready to execute, or a string error message
     */
    validate(_context) {
        return true;
    }
    /**
     * Cleanup hook called after execution, regardless of success or failure.
     * Override this to release resources, close connections, etc.
     *
     * Default implementation does nothing.
     */
    cleanup() {
        // Override to add cleanup logic
    }
}
//# sourceMappingURL=agent.js.map