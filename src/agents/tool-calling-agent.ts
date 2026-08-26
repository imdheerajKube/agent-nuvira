/**
 * ToolCallingAgent — Base class for agents that use a tool-calling loop.
 *
 * Adopts the proven pattern from Freebuff and Hermes:
 *   LLM generates tool call → Agent executes tool → Result fed back → Loop
 *
 * This replaces the "one LLM call = full output" model with an iterative
 * approach where the LLM can:
 *   1. Read a file to understand its contents
 *   2. Edit the file surgically
 *   3. Read another file
 *   4. Edit that file
 *   5. Run tests to verify
 *   6. Fix any errors
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

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from './agent.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A tool that the agent can call */
export interface AgentTool {
  /** Tool name (e.g. 'read_file', 'edit_file') */
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
const MAX_ITERATIONS = 20;

/** Maximum tool results to include in context (prevent token explosion) */
const MAX_TOOL_RESULTS = 10;

// ─── Built-in Tools ─────────────────────────────────────────────────────────

/**
 * Read a file's contents.
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
        return { success: true, output: content };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * Apply a surgical edit to a file using str_replace.
 */
function createEditFileTool(): AgentTool {
  return {
    name: 'edit_file',
    description: 'Apply a surgical edit to a file. Finds oldString and replaces it with newString. The oldString must match exactly (including whitespace).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        oldString: { type: 'string', description: 'The exact string to find and replace' },
        newString: { type: 'string', description: 'The replacement string' },
      },
      required: ['path', 'oldString', 'newString'],
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

        if (!content.includes(args.oldString)) {
          return {
            success: false,
            output: '',
            error: `oldString not found in ${args.path}. The string must match exactly.`,
          };
        }

        const newContent = content.replace(args.oldString, args.newString);
        writeFileSync(filePath, newContent, 'utf-8');

        return { success: true, output: `Edited ${args.path} successfully` };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * Create or overwrite a file.
 */
function createWriteFileTool(): AgentTool {
  return {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        content: { type: 'string', description: 'The full file content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(args, context): Promise<ToolResult> {
      try {
        const filePath = isAbsolute(args.path)
          ? args.path
          : join(context.workingDirectory, args.path);

        // Ensure directory exists
        const dir = dirname(filePath);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });

        writeFileSync(filePath, args.content, 'utf-8');

        return { success: true, output: `Created ${args.path} successfully` };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  };
}

/**
 * Run a terminal command.
 */
function createRunTerminalTool(): AgentTool {
  return {
    name: 'run_terminal',
    description: 'Run a shell command in the working directory. Returns stdout and stderr.',
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
          result.stdout ? `STDOUT:\n${result.stdout}` : '',
          result.stderr ? `STDERR:\n${result.stderr}` : '',
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
      createEditFileTool(),
      createWriteFileTool(),
      createRunTerminalTool(),
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

- Use \`read_file\` to examine existing code before editing
- Use \`edit_file\` to make surgical changes to existing files
- Use \`write_file\` to create new files
- Use \`run_terminal\` to run tests, builds, or other commands

## Completing the Task

When you have finished implementing all changes, produce your final response as plain text (NO tool calls). Your final response should summarize what you did.`;
  }

  /** Execute the tool-calling loop */
  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const tools = this.getTools(context);
      const systemPrompt = this.buildSystemPrompt(context);
      const userPrompt = this.buildUserPrompt(context);
      const toolDefsPrompt = this.buildToolDefinitionsPrompt(tools);

      // Build initial prompt
      const fullSystemPrompt = `${systemPrompt}\n\n${toolDefsPrompt}`;
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const toolResults: string[] = [];
      let iterations = 0;

      this.report(context, 'starting', `Starting tool-calling loop (max ${MAX_ITERATIONS} iterations)`);

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Build the prompt from messages
        const prompt = messages.map((m) => {
          if (m.role === 'system') return m.content;
          if (m.role === 'user') return `User: ${m.content}`;
          if (m.role === 'assistant') return `Assistant: ${m.content}`;
          return m.content;
        }).join('\n\n');

        // Call LLM
        const response = await callLLM(prompt, {
          temperature: 0.3,
          maxTokens: 4096,
        });

        // Parse response
        const parsed = this.parseResponse(response);

        // If done (no tool calls), return final result
        if (parsed.done || !parsed.toolCalls || parsed.toolCalls.length === 0) {
          this.report(context, 'completed', `Completed after ${iterations} iterations`);
          return {
            success: true,
            summary: parsed.text || 'Task completed',
            details: toolResults.join('\n'),
          };
        }

        // Execute each tool call
        for (const toolCall of parsed.toolCalls) {
          this.report(context, 'executing', `Calling tool: ${toolCall.name}`);

          const tool = tools.find((t) => t.name === toolCall.name);
          if (!tool) {
            const errorResult = `Unknown tool: ${toolCall.name}`;
            toolResults.push(errorResult);
            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'user', content: `Error: ${errorResult}` });
            continue;
          }

          const result = await tool.execute(toolCall.arguments, context);
          const resultText = result.success
            ? `Tool ${toolCall.name} succeeded:\n${result.output}`
            : `Tool ${toolCall.name} failed:\n${result.error}`;

          toolResults.push(resultText);

          // Keep tool results bounded
          if (toolResults.length > MAX_TOOL_RESULTS) {
            toolResults.shift();
          }

          // Add to conversation
          messages.push({ role: 'assistant', content: response });
          messages.push({ role: 'user', content: resultText });
        }
      }

      // Max iterations reached
      this.report(context, 'warning', `Max iterations (${MAX_ITERATIONS}) reached`);
      return {
        success: false,
        summary: `Max iterations (${MAX_ITERATIONS}) reached without completing`,
        details: toolResults.join('\n'),
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
}
