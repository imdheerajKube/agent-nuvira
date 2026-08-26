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

import { ToolCallingAgent, type AgentTool, type ParsedResponse, type ToolResult } from '../tool-calling-agent.js';
import type { AgentContext } from '../agent.js';
import type { McpToolEntry } from './mcp-agent.js';
import { getMCPManager } from '../../mcp/manager.js';

export class ReviewerToolCallingAgent extends ToolCallingAgent {
  readonly name = 'Reviewer';
  readonly description = 'Reviews code changes and proposes fixes using iterative tool calls';

  /**
   * Override getTools to include MCP tools from connected servers.
   * The reviewer may need to read files from external services.
   */
  protected getTools(context: AgentContext): AgentTool[] {
    const builtInTools = super.getTools(context);
    const mcpEntries = context.metadata?.mcpTools as McpToolEntry[] | undefined;

    if (!mcpEntries || mcpEntries.length === 0) {
      return builtInTools;
    }

    const mcpTools: AgentTool[] = mcpEntries.map((entry) => ({
      name: `mcp_${entry.tool.name}`,
      description: `[MCP:${entry.server}] ${entry.tool.description || entry.tool.name}`,
      parameters: entry.tool.inputSchema || { type: 'object', properties: {} },
      async execute(args: Record<string, any>, _ctx: AgentContext): Promise<ToolResult> {
        try {
          const manager = getMCPManager();
          const result = await manager.callTool(entry.tool.name, args);
          if (result === null || result === undefined) {
            return { success: false, output: '', error: `MCP tool '${entry.tool.name}' returned null` };
          }
          const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { success: true, output: output.slice(0, 50_000) };
        } catch (err) {
          return { success: false, output: '', error: `MCP tool error: ${err}` };
        }
      },
    }));

    return [...builtInTools, ...mcpTools];
  }

  protected buildSystemPrompt(context: AgentContext): string {
    return `You are a senior code reviewer. Your job is to review code changes for quality, correctness, and security.

## Review Focus

1. **Correctness** — Does the code correctly implement the described task?
2. **Security** — Any SQL injection, XSS, path traversal, or other vulnerabilities?
3. **Error handling** — Are edge cases and invalid inputs handled?
4. **Code quality** — Is the code clean, readable, and maintainable?
5. **Type safety** — Are there any type mismatches or implicit any types?
6. **Performance** — Any obvious performance issues?

## Approach

1. **Read the changes**: Use \`read_file\` to examine the proposed file changes
2. **Read context**: Read the original files to understand what changed
3. **Identify issues**: List specific issues with file paths and line numbers
4. **Propose fixes**: Use \`propose_change\` to fix each issue (include COMPLETE updated file)
5. **Verify**: Re-read the fixed files to confirm the fixes are correct

## Rules

- Only flag issues that actually exist (no hypothetical issues)
- Be specific: include file path, line number, and description
- For each issue, propose a concrete fix
- If no issues found, produce a clean review summary
- Do NOT propose changes to files you haven't read
- When proposing fixes, include the COMPLETE file content, not a diff

## Output Format

When you're done reviewing, produce a final summary in this format:

### Review Summary

**Files reviewed:** [list of files]
**Issues found:** [count]

#### Issues
- [SEVERITY] [file:line] [description]
  Fix: [what to change]

Or if no issues:
✅ Review passed. No issues found.`;
  }

  protected buildUserPrompt(context: AgentContext): string {
    // Find the current reviewer task
    const currentTaskId = context.metadata.currentTaskId as string | undefined;
    const reviewerTask = context.taskPlan.find(
      (s) => s.agentType === 'reviewer' &&
        (currentTaskId ? s.id === currentTaskId : s.status === 'running'),
    );
    const taskDescription = reviewerTask?.description || context.goal;

    // Format the file changes as diffs
    const diffs = context.fileChanges
      .map((change) => {
        const header = `--- a/${change.path}\n+++ b/${change.path}`;
        if (change.originalContent && change.newContent) {
          return `${header}\n@@ ... @@\n${change.originalContent.slice(0, 500)}\n---\n${change.newContent.slice(0, 500)}`;
        }
        if (change.status === 'created') {
          return `${header}\n@@ -0,0 +1 @@\n+ (new file, ${change.newContent?.length || 0} chars)`;
        }
        return header;
      })
      .join('\n\n');

    // Acceptance criteria
    const acceptanceCriteria = (context.metadata?.acceptanceCriteria as string[] | undefined) ?? [];
    const criteriaSection = acceptanceCriteria.length > 0
      ? `\n\n## Acceptance Criteria\nThe user defined these success criteria. Verify EACH one:\n${acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    // Wire failure lessons into reviewer
    const failureLessonContext = context.metadata?.failureLessonContext as string | undefined;
    const memorySection = failureLessonContext
      ? `\n\n## Known Failure Patterns\nCheck specifically for these issues — they caused failures in similar past tasks:${failureLessonContext}`
      : '';

    return `## Task\n${taskDescription}\n\n## Goal\n${context.goal}\n\n## Changes to Review\n${diffs || '(No changes provided — use read_file to examine the proposed changes)'}${criteriaSection}${memorySection}\n\n## Instructions\nReview the proposed changes. Use read_file to examine the actual files. Identify issues and propose fixes using propose_change. If no issues are found, produce a clean review summary.`;
  }

  protected parseResponse(response: string): ParsedResponse {
    const trimmed = response.trim();

    // Try to parse as JSON tool call in code block
    const jsonBlockMatch = trimmed.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      const parsed = this.tryParseToolCall(jsonBlockMatch[1].trim());
      if (parsed) return parsed;
    }

    // Try to find inline JSON tool call
    const inlineMatch = trimmed.match(/\{"tool":\s*"([^"]+)",\s*"args":\s*(\{[\s\S]*?\})\}/);
    if (inlineMatch) {
      try {
        const args = JSON.parse(inlineMatch[2]);
        return {
          toolCalls: [{
            id: `call-${Date.now()}`,
            name: inlineMatch[1],
            arguments: args,
          }],
          done: false,
        };
      } catch {
        // Not valid JSON
      }
    }

    // No tool calls — this is the final review
    return {
      text: trimmed,
      done: true,
    };
  }

  private tryParseToolCall(jsonStr: string): ParsedResponse | null {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.tool && parsed.args) {
        return {
          toolCalls: [{
            id: `call-${Date.now()}`,
            name: parsed.tool,
            arguments: parsed.args,
          }],
          done: false,
        };
      }
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].tool) {
        return {
          toolCalls: parsed.map((tc: any, i: number) => ({
            id: `call-${Date.now()}-${i}`,
            name: tc.tool,
            arguments: tc.args || {},
          })),
          done: false,
        };
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }
}
