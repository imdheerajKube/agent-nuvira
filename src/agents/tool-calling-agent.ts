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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult, type FileChange, type LLMCallFn } from './agent.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum iterations before forcing completion */
const MAX_ITERATIONS = 25;

/** Maximum tool results to keep in conversation history */
const MAX_HISTORY_MESSAGES = 40;

// ─── Built-in Tools ─────────────────────────────────────────────────────────

/**
 * Read a file's contents from disk (read-only).
 */
function createReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the full file content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
      },
      required: ['path'],
    },
    async execute(args, context): Promise<ToolResult> {
      try {
        const filePath = isAbsolute(args.path)
          ? args.path
          : join(context.workingDirectory, args.path);

        if (!existsSync(filePath)) {
          return { success: false, output: '', error: `File not found: ${args.path}` };
        }

        const content = readFileSync(filePath, 'utf-8');
        // Truncate very large files to prevent token explosion
        const maxChars = 50_000;
        const truncated = content.length > maxChars
          ? content.slice(0, maxChars) + `\n\n... (${content.length - maxChars} more chars truncated)`
          : content;
        return { success: true, output: truncated };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * List files in a directory (recursive, max depth 3).
 */
function createListFilesTool(): AgentTool {
  return {
    name: 'list_files',
    description: 'List files and directories in a path. Useful for discovering project structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to working directory (default: ".")' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth (default: 2)' },
      },
      required: [],
    },
    async execute(args, context): Promise<ToolResult> {
      try {
        const dirPath = args.path
          ? (isAbsolute(args.path) ? args.path : join(context.workingDirectory, args.path))
          : context.workingDirectory;
        const maxDepth = args.maxDepth ?? 2;

        if (!existsSync(dirPath)) {
          return { success: false, output: '', error: `Directory not found: ${args.path || '.'}` };
        }

        const entries: string[] = [];
        const ignore = new Set(['node_modules', '.git', 'dist', '__pycache__', '.cache', '.nuvira']);

        function walk(dir: string, depth: number, prefix: string): void {
          if (depth > maxDepth) return;
          try {
            const items = readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (ignore.has(item.name)) continue;
              const relPath = prefix ? `${prefix}/${item.name}` : item.name;
              if (item.isDirectory()) {
                entries.push(`${relPath}/`);
                walk(join(dir, item.name), depth + 1, relPath);
              } else {
                entries.push(relPath);
              }
            }
          } catch {
            // Permission errors — skip
          }
        }

        walk(dirPath, 0, '');
        return { success: true, output: entries.join('\n') || '(empty directory)' };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * Propose a file change (create or modify). Does NOT write to disk.
 * The orchestrator applies changes after the agent returns.
 */
function createProposeChangeTool(): AgentTool {
  return {
    name: 'propose_change',
    description: 'Propose a file change (create or modify). The orchestrator will apply it to disk. For modifications, include the COMPLETE updated file content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        content: { type: 'string', description: 'The COMPLETE updated file content (not a diff)' },
        status: { type: 'string', description: '"created" for new files, "modified" for existing files (default: auto-detect)' },
      },
      required: ['path', 'content'],
    },
    async execute(args, context): Promise<ToolResult> {
      try {
        const filePath = isAbsolute(args.path)
          ? args.path
          : join(context.workingDirectory, args.path);

        const exists = existsSync(filePath);
        const status = args.status || (exists ? 'modified' : 'created');

        // Read original content for modifications (needed for rollback)
        let originalContent: string | undefined;
        if (status === 'modified' && exists) {
          originalContent = readFileSync(filePath, 'utf-8');
        }

        const change: FileChange = {
          path: args.path,
          status: status as 'created' | 'modified' | 'deleted',
          newContent: args.content,
          originalContent,
        };

        // Add to context.fileChanges (deduplicate by path)
        const existing = context.fileChanges.findIndex((c) => c.path === args.path);
        if (existing >= 0) {
          context.fileChanges[existing] = change;
        } else {
          context.fileChanges.push(change);
        }

        const icon = status === 'created' ? '📄' : '✏️';
        return { success: true, output: `${icon} Proposed ${status}: ${args.path} (${args.content.length} chars)` };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * Run a terminal command (for testing, building, etc.).
 */
function createRunCommandTool(): AgentTool {
  return {
    name: 'run_command',
    description: 'Run a shell command in the working directory. Returns stdout, stderr, and exit code. Use for testing, building, or verification.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['command'],
    },
    async execute(args, context): Promise<ToolResult> {
      try {
        const timeout = (args.timeout || 30) * 1000;
        const result = spawnSync('bash', ['-c', args.command], {
          cwd: context.workingDirectory,
          encoding: 'utf-8',
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const output = [
          result.stdout ? `STDOUT:\n${result.stdout.slice(0, 5000)}` : '',
          result.stderr ? `STDERR:\n${result.stderr.slice(0, 2000)}` : '',
          result.status !== 0 ? `EXIT CODE: ${result.status}` : '',
        ].filter(Boolean).join('\n');

        return {
          success: result.status === 0,
          output: output || '(no output)',
          error: result.status !== 0 ? `Command exited with code ${result.status}` : undefined,
        };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

// ─── Tool Calling Agent ─────────────────────────────────────────────────────

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
export abstract class ToolCallingAgent extends Agent {
  /** Get the tools available to this agent */
  protected getTools(context: AgentContext): AgentTool[] {
    return [
      createReadFileTool(),
      createListFilesTool(),
      createProposeChangeTool(),
      createRunCommandTool(),
    ];
  }

  /** Build the system prompt for the LLM */
  protected abstract buildSystemPrompt(context: AgentContext): string;

  /** Build the user prompt for the LLM */
  protected abstract buildUserPrompt(context: AgentContext): string;

  /** Parse the LLM response to extract tool calls or final text */
  protected abstract parseResponse(response: string): ParsedResponse;

  /** Build the tool definitions section of the prompt */
  protected buildToolDefinitionsPrompt(tools: AgentTool[]): string {
    const toolDefs = tools.map((tool) => {
      const params = Object.entries(tool.parameters.properties || {})
        .map(([name, schema]: [string, any]) => `    - ${name}: ${schema.description || schema.type}`)
        .join('\n');

      return `  - ${tool.name}: ${tool.description}\n    Parameters:\n${params}`;
    }).join('\n\n');

    return `## Available Tools

You have access to the following tools. To use a tool, respond with a JSON tool call.

${toolDefs}

## Tool Call Format

To call a tool, respond with EXACTLY this format (one tool call per response):

\`\`\`json
{"tool": "tool_name", "args": {"param1": "value1", "param2": "value2"}}
\`\`\`

You can make ONE tool call per response. After seeing the result, you can make another tool call or produce your final response.

## When to Use Tools

- Use \`read_file\` to examine existing code before making changes
- Use \`list_files\` to discover project structure
- Use \`propose_change\` to create new files or modify existing ones
  - For NEW files: set content to the complete file
  - For EXISTING files: set content to the COMPLETE updated file (not a diff)
- Use \`run_command\` to run tests, builds, or verification commands

## Workflow

1. First, understand the task and project structure (\`list_files\`, \`read_file\`)
2. Read relevant files to understand the codebase
3. Propose changes using \`propose_change\`
4. Verify your changes by running tests or reading the modified files
5. When done, produce a final text response summarizing what you did

## Completing the Task

When you have finished implementing all changes, produce your final response as plain text (NO tool calls). Your final response should summarize what you did and list all files you proposed changes for.`;
  }

  /** Execute the tool-calling loop */
  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const tools = this.getTools(context);
      const systemPrompt = this.buildSystemPrompt(context);
      const userPrompt = this.buildUserPrompt(context);
      const toolDefsPrompt = this.buildToolDefinitionsPrompt(tools);

      // Build initial prompt — flat string format (existing LLMCallFn interface)
      const fullPrompt = `${systemPrompt}\n\n${toolDefsPrompt}\n\n---\n\n${userPrompt}`;

      const toolCallHistory: string[] = [];
      let iterations = 0;

      this.report(context, 'starting', `Starting tool-calling loop (max ${MAX_ITERATIONS} iterations)`);

      let currentPrompt = fullPrompt;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Call LLM
        const response = await callLLM(currentPrompt, {
          temperature: 0.3,
          maxTokens: 8192,
        });

        // Parse response
        const parsed = this.parseResponse(response);

        // If done (no tool calls), return final result
        if (parsed.done || !parsed.toolCalls || parsed.toolCalls.length === 0) {
          this.report(context, 'completed', `Completed after ${iterations} iterations`);

          // Count proposed changes
          const changeCount = context.fileChanges.length;
          return {
            success: changeCount > 0 || !!parsed.text,
            summary: parsed.text || `Tool-calling agent completed (${changeCount} file changes proposed)`,
            details: toolCallHistory.join('\n'),
          };
        }

        // Execute each tool call
        for (const toolCall of parsed.toolCalls) {
          this.report(context, 'executing', `Calling tool: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 100)})`);

          const tool = tools.find((t) => t.name === toolCall.name);
          if (!tool) {
            const errorResult = `Unknown tool: ${toolCall.name}. Available tools: ${tools.map((t) => t.name).join(', ')}`;
            toolCallHistory.push(`[${toolCall.name}] ERROR: ${errorResult}`);
            currentPrompt = this.buildFollowUpPrompt(currentPrompt, response, errorResult);
            continue;
          }

          const result = await tool.execute(toolCall.arguments, context);
          const resultText = result.success
            ? `Tool ${toolCall.name} succeeded:\n${result.output}`
            : `Tool ${toolCall.name} failed:\n${result.error}`;

          toolCallHistory.push(`[${toolCall.name}] ${result.success ? 'OK' : 'FAIL'}: ${(result.output || result.error || '').slice(0, 200)}`);

          // Build follow-up prompt with tool result
          currentPrompt = this.buildFollowUpPrompt(currentPrompt, response, resultText);
        }
      }

      // Max iterations reached
      this.report(context, 'warning', `Max iterations (${MAX_ITERATIONS}) reached`);
      const changeCount = context.fileChanges.length;
      return {
        success: changeCount > 0,
        summary: `Max iterations (${MAX_ITERATIONS}) reached. ${changeCount} file change(s) proposed.`,
        details: toolCallHistory.join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Tool-calling agent failed',
        error: msg,
      };
    }
  }

  /**
   * Build the follow-up prompt after a tool execution.
   * Appends the assistant's response and tool result to the conversation,
   * keeping the prompt bounded to prevent token explosion.
   */
  private buildFollowUpPrompt(
    previousPrompt: string,
    assistantResponse: string,
    toolResult: string,
  ): string {
    // Append the exchange to the prompt
    const exchange = `\n\nAssistant:\n${assistantResponse}\n\nTool Result:\n${toolResult}\n\nContinue with the next tool call, or produce your final response if done.`;

    // Bound the total prompt size — keep system + tool defs + recent exchanges
    const combined = previousPrompt + exchange;
    const maxPromptChars = 100_000; // ~25K tokens

    if (combined.length > maxPromptChars) {
      // Keep the first 30% (system prompt + tool defs) and the last 70% (recent exchanges)
      const systemPortion = combined.slice(0, Math.floor(maxPromptChars * 0.3));
      const recentPortion = combined.slice(-Math.floor(maxPromptChars * 0.7));
      return systemPortion + '\n\n... [earlier exchanges truncated] ...\n\n' + recentPortion;
    }

    return combined;
  }
}
