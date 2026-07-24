/**
 * WriterAgent — Proposes code changes based on the task plan and gathered context.
 *
 * For each "writer" step in the execution plan, this agent:
 * 1. Reads the relevant source files (from artifacts in the context bus)
 * 2. Generates modified versions using the LLM
 * 3. Stores FileChange objects in the context bus for the orchestrator to apply
 *
 * The agent does NOT write to disk — it only proposes changes.
 * The orchestrator decides whether to apply them (based on dry-run mode).
 */
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '../agent.js';
/**
 * WriterAgent — Proposes code changes by reading files, generating new versions
 * via the LLM, and storing FileChange objects in the shared context.
 * Does NOT write to disk directly; the orchestrator handles that.
 *
 * Retry strategy:
 * 1. Rate-limit (429) errors with LONG wait (>3s): invokes onRateLimit callback
 *    (if available) to let the user choose: wait, switch model, skip, or abort.
 * 2. Rate-limit errors with SHORT wait (<=3s): auto-retry with smart delay.
 * 3. Other transient errors (timeouts, network): auto-retry with backoff.
 * 4. Empty parse results (format issue): retry once with stricter prompt.
 */
export declare class WriterAgent extends Agent {
    readonly name = "Writer";
    readonly description = "Generates code changes based on the plan and context";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Perform a single write attempt.
     * Optionally uses a stricter retry prompt.
     */
    private attemptWrite;
    /**
     * Build the prompt for the writer agent from the shared context.
     * Limits the number of files sent to avoid token budget issues.
     * When isRetry is true, uses a more explicit prompt.
     */
    private buildPrompt;
    /**
     * Parse the LLM response to extract file changes.
     */
    private parseFileChanges;
    /**
     * Select files within the given character budget.
     * Prioritizes smaller files first so the LLM sees as much complete context as possible.
     */
    private selectFilesWithinBudget;
    private addFileChange;
}
//# sourceMappingURL=writer.d.ts.map