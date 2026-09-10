/**
 * WriterAgentToolCalling — Tool-calling version of the writer agent.
 *
 * Instead of producing complete file content in one LLM call, this agent:
 * 1. Reads existing files to understand their structure
 * 2. Proposes surgical changes using propose_change
 * 3. Reads other files as needed
 * 4. Creates new files when necessary
 * 5. Runs tests to verify changes
 *
 * KEY: This agent does NOT write to disk. It proposes FileChange objects
 * in context.fileChanges. The Orchestrator applies them after the agent returns.
 *
 * Reference:
 * - Freebuff: packages/agent-runtime/src/run-agent-step.ts
 * - Hermes: run_agent.py AIAgent tool dispatch loop
 */
import { ToolCallingAgent, type AgentTool, type ParsedResponse } from '../tool-calling-agent.js';
import type { AgentContext } from '../agent.js';
export declare class WriterToolCallingAgent extends ToolCallingAgent {
    readonly name = "Writer";
    readonly description = "Implements code changes using iterative tool calls";
    /**
     * Override getTools to include MCP tools from connected servers.
     * MCP tools are injected alongside built-in tools so the LLM can
     * call external services (filesystem, databases, APIs) directly.
     */
    protected getTools(context: AgentContext): AgentTool[];
    protected buildSystemPrompt(context: AgentContext): string;
    protected buildUserPrompt(context: AgentContext): string;
    protected parseResponse(response: string): ParsedResponse;
    private tryParseToolCall;
}
//# sourceMappingURL=writer-tool-calling.d.ts.map