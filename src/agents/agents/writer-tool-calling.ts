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

import { ToolCallingAgent, type AgentTool, type ParsedResponse, type ToolResult } from '../tool-calling-agent.js';
import type { AgentContext } from '../agent.js';
import type { McpToolEntry } from './mcp-agent.js';
import { getMCPManager } from '../../mcp/manager.js';
import { assessProject, type ProjectAssessment } from '../prompt-assembly.js';
import { referenceDocsFor } from '../reference-docs.js';
import { getToolsForAgent } from '../tool-bridge.js';
import { responseIndicatesNoChanges } from './writer.js';

export class WriterToolCallingAgent extends ToolCallingAgent {
  readonly name = 'Writer';
  readonly description = 'Implements code changes using iterative tool calls';

  /**
   * A writer's deliverable is FILE CHANGES, so finishing with none proposed is
   * a failure unless the model explicitly judged that no change was needed
   * ("the file already implements this") — the same distinction the one-shot
   * `WriterAgent` makes with `responseIndicatesNoChanges`. Returning success
   * for "I'll outline my approach…" silently skipped the task's real work and
   * stranded every downstream step, which is exactly what Session 46 fixed on
   * the one-shot path.
   */
  protected acceptNoChangeOutcome(_context: AgentContext, text: string): boolean {
    return responseIndicatesNoChanges(text);
  }

  protected noChangeFailure(): { summary: string; error: string } {
    return {
      summary: 'Writer produced no file changes',
      error:
        'The writer finished without proposing a single file change and without a "no changes needed" judgment ' +
        '(no propose_change/edit tool call was emitted).',
    };
  }

  /**
   * Override getTools to include MCP tools from connected servers.
   * MCP tools are injected alongside built-in tools so the LLM can
   * call external services (filesystem, databases, APIs) directly.
   */
  protected getTools(context: AgentContext): AgentTool[] {
    // Start with the base tool-calling agent tools (read_file, list_files, propose_change, run_command)
    const builtInTools = super.getTools(context);

    // Add registry tools via the bridge (code_search, edit_file, write_file, git, web_search, etc.)
    const registryTools = getToolsForAgent('writer', { maxTools: 30 });

    // Add MCP tools from connected servers
    const mcpEntries = context.metadata?.mcpTools as McpToolEntry[] | undefined;
    const mcpTools: AgentTool[] = mcpEntries
      ? mcpEntries.map((entry) => ({
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
        }))
      : [];

    // Deduplicate by name (built-in tools take precedence over registry tools)
    const seen = new Set(builtInTools.map((t) => t.name));
    const uniqueRegistryTools = registryTools.filter((t) => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });

    return [...builtInTools, ...uniqueRegistryTools, ...mcpTools];
  }

  protected buildSystemPrompt(context: AgentContext): string {
    // Assess project for framework-specific conventions
    let assessment: ProjectAssessment | undefined;
    try {
      assessment = assessProject(context.workingDirectory);
    } catch {
      // Best-effort
    }

    const base = `You are an expert software engineer implementing changes to a codebase.

Your job is to implement the requested changes by iteratively reading files, making edits, and verifying your work.

## Approach

1. **Discover**: Use \`list_files\` to understand the project structure
2. **Read first**: Always read the relevant files before making changes. Understand the existing code structure.
3. **Load methodology**: If the task involves a specific domain (game, API, Docker, etc.), use \`skill_view\` to load the full methodology for that domain.
4. **Propose changes**: Use \`propose_change\` to propose file modifications. For EXISTING files, include the COMPLETE updated file content. For NEW files, include the complete file.
5. **Verify**: After proposing changes, read the modified files to confirm your changes are correct.
6. **Test**: Run relevant tests or builds to verify your changes work.

## Rules

- ALWAYS read a file before proposing changes to it
- Make small, focused changes (one logical change at a time)
- Preserve existing code style and conventions
- Add appropriate error handling
- Write clean, well-documented code
- If you encounter errors, read the error message and fix the issue
- NEVER propose changes to files you haven't read first
- For modifications, always include the COMPLETE file content, not a diff
- For domain-specific tasks, use \`skill_view\` to load the full methodology before implementing`;

    // Inject project-specific conventions
    const conventions: string[] = [];
    if (assessment?.framework) {
      const frameworkConventions: Record<string, string> = {
        react: 'Use React functional components with hooks. Follow React best practices.',
        vue: 'Use Vue 3 Composition API with <script setup>.',
        nextjs: 'Use Next.js App Router conventions. Server components by default.',
        express: 'Use Express.js middleware patterns. Handle errors with error-handling middleware.',
        fastapi: 'Use FastAPI with Pydantic models for request/response schemas.',
        python: 'Follow PEP 8 style guide. Use type hints.',
        go: 'Follow Go conventions (gofmt, go vet). Use error wrapping.',
        rust: 'Follow Rust API guidelines. Use Result for error handling.',
      };
      if (frameworkConventions[assessment.framework]) {
        conventions.push(frameworkConventions[assessment.framework]);
      }
    }
    if (assessment?.language === 'typescript') {
      conventions.push('Use strict TypeScript. Prefer interfaces over type aliases.');
    }
    if (assessment?.isGreenfield) {
      conventions.push('This is a greenfield project — create files from scratch using list_files first to see what exists.');
    }

    if (conventions.length > 0) {
      return `${base}\n\n## Project Conventions\n${conventions.join('\n')}`;
    }

    return base;
  }

  protected buildUserPrompt(context: AgentContext): string {
    // Find the current writer task
    const currentTaskId = context.metadata.currentTaskId as string | undefined;
    const writerTask = context.taskPlan.find(
      (s) => s.agentType === 'writer' &&
        (currentTaskId ? s.id === currentTaskId : s.status === 'running'),
    );
    const taskDescription = writerTask?.description || context.goal;

    // Include file context from artifacts (pre-gathered by context-gatherer)
    const fileContext = context.artifacts.length > 0
      ? context.artifacts
          .map((a) => `--- ${a.path} ---\n${a.content}`)
          .join('\n\n')
      : '(No files pre-loaded — use list_files and read_file to discover them)';

    // Include skill guidance if available
    const skillGuidance = context.metadata.skillGuidance as
      | { name: string; description: string; steps: Array<{ agentType: string; description: string }> }
      | undefined;
    const skillSection = skillGuidance
      ? `\n\n## Skill Guidance (matched: ${skillGuidance.name})\n${skillGuidance.description}\n\nFollow this methodology:` +
        skillGuidance.steps.map((s) => `\n- [${s.agentType}] ${s.description}`).join('')
      : '';

    // Include reference docs if available
    const referenceSection = referenceDocsFor(`${taskDescription} ${context.goal}`);

    // Wire memory into writer prompt: failure lessons, patterns, facts
    const failureLessonContext = context.metadata?.failureLessonContext as string | undefined;
    const patternContext = context.metadata?.patternContext as string | undefined;
    const factContext = context.metadata?.factContext as string | undefined;
    const memoryParts: string[] = [];
    if (failureLessonContext) memoryParts.push(`\n\n## Lessons from Past Failures\nAvoid these mistakes:${failureLessonContext}`);
    if (patternContext) memoryParts.push(`\n\n## Proven Patterns\nUse these proven approaches:${patternContext}`);
    if (factContext) memoryParts.push(`\n\n## Project Facts & Preferences\n${factContext}`);
    const memorySection = memoryParts.join('');

    return `## Task\n${taskDescription}\n\n## Goal\n${context.goal}\n\n## Existing Files\n${fileContext}${skillSection}${referenceSection}${memorySection}\n\n## Instructions\nImplement the changes described in the task. Use the available tools to discover, read, and propose changes to files. Start by listing the project files, then read the relevant ones, then propose your changes.`;
  }

  protected parseResponse(response: string): ParsedResponse {
    const trimmed = response.trim();

    // Try to parse as JSON tool call in code block
    const jsonBlockMatch = trimmed.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      const parsed = this.tryParseToolCall(jsonBlockMatch[1].trim());
      if (parsed) return parsed;
    }

    // Try to find inline JSON tool call (without code blocks)
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

    // Try to find tool call with different formatting
    const altMatch = trimmed.match(/"tool":\s*"([^"]+)"/);
    if (altMatch) {
      // Try to extract args from surrounding context
      const toolName = altMatch[1];
      const argsMatch = trimmed.match(/"args":\s*(\{[\s\S]*?\})/);
      if (argsMatch) {
        try {
          const args = JSON.parse(argsMatch[1]);
          return {
            toolCalls: [{
              id: `call-${Date.now()}`,
              name: toolName,
              arguments: args,
            }],
            done: false,
          };
        } catch {
          // Fall through
        }
      }
    }

    // No tool calls found — this is the final response
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
      // Also support array of tool calls
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
