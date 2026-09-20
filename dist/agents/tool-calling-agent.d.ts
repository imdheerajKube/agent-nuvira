/**
 * ToolCallingAgent — Base class for agents that use a tool-calling loop.
 *
 * Adopts the proven pattern from Freebuff and Hermes:
 *   LLM generates tool call → Agent executes tool → Result fed back → Loop
 *
 * KEY CONSTRAINT: This agent does NOT write to disk. Tools propose FileChange
 * objects in context.fileChanges. The Orchestrator applies them after the
 * agent returns. This preserves dry-run mode, rollback, and audit trail.
 *
 * Reference:
 * - Freebuff: packages/agent-runtime/src/run-agent-step.ts (tool-calling loop)
 * - Hermes: run_agent.py AIAgent.run_conversation() (tool dispatch loop)
 *
 * The tool-calling is prompt-based (not native function calling) because
 * the existing LLMCallFn interface doesn't support tool definitions.
 * The LLM is prompted to produce tool calls in a structured format,
 * and the agent parses and executes them.
 */
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from './agent.js';
/** A tool that the agent can call */
export interface AgentTool {
    /** Tool name (e.g. 'read_file', 'propose_change') */
    name: string;
    /** Human-readable description */
    description: string;
    /** JSON Schema for the tool's parameters */
    parameters: Record<string, any>;
    /** Execute the tool with the given arguments */
    execute(args: Record<string, any>, context: AgentContext): Promise<ToolResult>;
}
/** Result of a tool execution */
export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}
/** A tool call produced by the LLM */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}
/** Parsed LLM response that may contain tool calls */
export interface ParsedResponse {
    /** Text response from the LLM */
    text?: string;
    /** Tool calls the LLM wants to execute */
    toolCalls?: ToolCall[];
    /** Whether the LLM is done (no more tool calls needed) */
    done: boolean;
}
/**
 * Base class for agents that use a tool-calling loop.
 *
 * The LLM is prompted to produce tool calls in a structured format.
 * The agent parses and executes them, feeding results back to the LLM.
 * The loop continues until the LLM produces a final text response (no tool calls).
 *
 * CRITICAL: This agent does NOT write to disk. Tools propose FileChange objects
 * in context.fileChanges. The Orchestrator applies them after the agent returns.
 *
 * Usage:
 * ```typescript
 * class MyAgent extends ToolCallingAgent {
 *   readonly name = 'MyAgent';
 *   readonly description = 'Does something cool';
 *
 *   protected buildSystemPrompt(context: AgentContext): string {
 *     return 'You are a helpful assistant...';
 *   }
 *
 *   protected buildUserPrompt(context: AgentContext): string {
 *     return `Task: ${context.goal}`;
 *   }
 *
 *   protected parseResponse(response: string): ParsedResponse {
 *     // Parse tool calls from LLM response
 *   }
 * }
 * ```
 */
export declare abstract class ToolCallingAgent extends Agent {
    /** Get the tools available to this agent */
    protected getTools(context: AgentContext): AgentTool[];
    /** Build the system prompt for the LLM */
    protected abstract buildSystemPrompt(context: AgentContext): string;
    /** Build the user prompt for the LLM */
    protected abstract buildUserPrompt(context: AgentContext): string;
    /** Parse the LLM response to extract tool calls or final text */
    protected abstract parseResponse(response: string): ParsedResponse;
    /**
     * Whether a final text response that proposed NO file changes is a success.
     *
     * Default `true`: for a reviewing/explaining agent the text IS the
     * deliverable. An agent whose contract is "produce these file changes" MUST
     * override this — otherwise a response that never emitted a usable tool call
     * is stamped `success: true` with an empty deliverable, which is the exact
     * "masked success" bug Session 46 removed from the one-shot writer
     * (`WriterAgent` fails with `Writer produced no parseable output`). The
     * tool-calling writer inherited that bug by returning
     * `changeCount > 0 || !!parsed.text`.
     */
    protected acceptNoChangeOutcome(_context: AgentContext, _text: string): boolean;
    /** Summary + error for the rejected no-change case (see above). Overridable
     *  so the surfaced failure names the agent's own deliverable contract. */
    protected noChangeFailure(): {
        summary: string;
        error: string;
    };
    /** Build the tool definitions section of the prompt */
    protected buildToolDefinitionsPrompt(tools: AgentTool[]): string;
    /** Execute the tool-calling loop */
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Build the follow-up prompt after a tool execution.
     * Appends the assistant's response and tool result to the conversation,
     * keeping the prompt bounded to prevent token explosion.
     */
    private buildFollowUpPrompt;
}
//# sourceMappingURL=tool-calling-agent.d.ts.map