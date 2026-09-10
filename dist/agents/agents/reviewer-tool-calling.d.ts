/**
 * ReviewerToolCallingAgent — Tool-calling version of the reviewer agent.
 *
 * Instead of reviewing changes in one LLM call, this agent:
 * 1. Reads the proposed file changes
 * 2. Reads the original files for context
 * 3. Identifies issues (security, correctness, style)
 * 4. Proposes fixes for each issue
 * 5. Verifies the fixes are correct
 *
 * KEY: This agent does NOT write to disk. It proposes additional FileChange
 * objects in context.fileChanges to fix issues found during review.
 *
 * Reference:
 * - Freebuff: packages/agent-runtime/src/run-agent-step.ts
 * - Hermes: run_agent.py AIAgent tool dispatch loop
 */
import { ToolCallingAgent, type AgentTool, type ParsedResponse } from '../tool-calling-agent.js';
import type { AgentContext } from '../agent.js';
export declare class ReviewerToolCallingAgent extends ToolCallingAgent {
    readonly name = "Reviewer";
    readonly description = "Reviews code changes and proposes fixes using iterative tool calls";
    /**
     * Override getTools to include MCP tools from connected servers.
     * The reviewer may need to read files from external services.
     */
    protected getTools(context: AgentContext): AgentTool[];
    protected buildSystemPrompt(context: AgentContext): string;
    protected buildUserPrompt(context: AgentContext): string;
    protected parseResponse(response: string): ParsedResponse;
    private tryParseToolCall;
}
//# sourceMappingURL=reviewer-tool-calling.d.ts.map