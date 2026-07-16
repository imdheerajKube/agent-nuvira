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

import type { AgentContext, AgentResult, LLMCallFn } from './types.js';

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
export abstract class Agent {
  /** Human-readable agent name (e.g. "Planner", "Writer", "CodeFormatter") */
  abstract readonly name: string;

  /** Short description of what this agent does (used in planning and logging) */
  abstract readonly description: string;

  /**
   * Execute the agent's specialized task.
   *
   * This is the main entry point. The agent should:
   * 1. Read inputs from the shared context (`context.artifacts`, `context.goal`, etc.)
   * 2. Call the LLM via `callLLM(prompt)` as needed
   * 3. Write outputs to the shared context (`context.fileChanges`, `context.artifacts`)
   * 4. Return an {@link AgentResult} indicating success/failure
   *
   * @param context  Shared context bus — read inputs, write outputs
   * @param callLLM  Function to call the configured LLM with a prompt
   * @returns        Result indicating success/failure + summary
   */
  abstract execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;

  /**
   * Validate that the agent can run with the given context.
   * Override this to check prerequisites before execution.
   *
   * Default implementation returns `true` (no validation).
   *
   * @param context  The shared context bus
   * @returns        `true` if the agent is ready to execute, or a string error message
   */
  validate(_context: AgentContext): true | string {
    return true;
  }

  /**
   * Cleanup hook called after execution, regardless of success or failure.
   * Override this to release resources, close connections, etc.
   *
   * Default implementation does nothing.
   */
  cleanup(): void {
    // Override to add cleanup logic
  }
}

// ─── Agent Metadata ─────────────────────────────────────────────────────────

/**
 * Metadata descriptor for registering an agent in the system.
 * Used by {@link AgentRegistry} and the scaffolding tool.
 */
export interface AgentDescriptor {
  /** Agent class constructor */
  AgentClass: new () => Agent;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Comma-separated tags for categorization (e.g. "code, analysis, format") */
  tags?: string;
  /** Agent type identifier used in task plans (defaults to kebab-case of name) */
  agentType?: string;
}
