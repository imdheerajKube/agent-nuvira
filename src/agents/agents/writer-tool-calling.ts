/**
 * WriterAgentToolCalling — Tool-calling version of the writer agent.
 *
 * Instead of producing complete file content in one LLM call, this agent:
 * 1. Reads existing files to understand their structure
 * 2. Makes surgical edits using str_replace
 * 3. Reads other files as needed
 * 4. Creates new files when necessary
 * 5. Runs tests to verify changes
 *
 * This adopts the Freebuff/Hermes pattern of iterative tool calling.
 *
 * Reference:
 * - Freebuff: packages/agent-runtime/src/run-agent-step.ts
 * - Hermes: run_agent.py AIAgent tool dispatch loop
 */

import { ToolCallingAgent, type AgentTool, type ParsedResponse } from '../tool-calling-agent.js';
import type { AgentContext } from '../agent.js';
import { assessProject, type ProjectAssessment } from '../prompt-assembly.js';
import { referenceDocsFor } from '../reference-docs.js';

export class WriterToolCallingAgent extends ToolCallingAgent {
  readonly name = 'Writer';
  readonly description = 'Implements code changes using iterative tool calls';

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

1. **Read first**: Always read the relevant files before making changes. Understand the existing code structure.
2. **Edit surgically**: Use \`edit_file\` with precise str_replace operations. Only change what needs to change.
3. **Create when needed**: Use \`write_file\` only for new files that don't exist yet.
4. **Verify**: After making changes, read the modified files to confirm the edits applied correctly.
5. **Test**: Run relevant tests to verify your changes work.

## Rules

- Always read a file before editing it
- Make small, focused edits (one logical change at a time)
- Preserve existing code style and conventions
- Add appropriate error handling
- Write clean, well-documented code
- If you encounter errors, read the error message and fix the issue`;

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
      conventions.push('This is a greenfield project — create files from scratch.');
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

    // Include file context from artifacts
    const fileContext = context.artifacts.length > 0
      ? context.artifacts
          .map((a) => `--- ${a.path} ---\n${a.content}`)
          .join('\n\n')
      : '(No files in context — you may need to create new files)';

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

    // Wire memory into tool-calling writer prompt: failure lessons, patterns, facts
    const failureLessonContext = context.metadata?.failureLessonContext as string | undefined;
    const patternContext = context.metadata?.patternContext as string | undefined;
    const factContext = context.metadata?.factContext as string | undefined;
    const memoryParts: string[] = [];
    if (failureLessonContext) memoryParts.push(`\n\n## Lessons from Past Failures\nAvoid these mistakes:${failureLessonContext}`);
    if (patternContext) memoryParts.push(`\n\n## Proven Patterns\nUse these proven approaches:${patternContext}`);
    if (factContext) memoryParts.push(`\n\n## Project Facts & Preferences\n${factContext}`);
    const memorySection = memoryParts.join('');

    return `## Task\n${taskDescription}\n\n## Goal\n${context.goal}\n\n## Existing Files\n${fileContext}${skillSection}${referenceSection}${memorySection}\n\n## Instructions\nImplement the changes described in the task. Use the available tools to read, edit, and create files. Start by reading the relevant files, then make the necessary changes.`;
  }

  protected parseResponse(response: string): ParsedResponse {
    const trimmed = response.trim();

    // Try to parse as JSON tool call
    const jsonMatch = trimmed.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
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
      } catch {
        // Not valid JSON tool call
      }
    }

    // Try to find inline JSON tool call (without code blocks)
    const inlineMatch = trimmed.match(/\{"tool":\s*"([^"]+)",\s*"args":\s*(\{[^}]+\})\}/);
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

    // No tool calls found — this is the final response
    return {
      text: trimmed,
      done: true,
    };
  }
}
