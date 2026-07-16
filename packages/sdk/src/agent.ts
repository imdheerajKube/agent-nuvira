/**
 * @agent-nuvira/sdk — Base Agent class and shared types for building custom agents.
 *
 * This module mirrors the core Agent interfaces from agent-nuvira's agent system
 * so that third-party developers can build, test, and publish custom agents
 * without depending on the full agent-nuvira internals.
 *
 * ## Usage
 *
 * ```ts
 * import { Agent, type AgentContext, type AgentResult } from '@agent-baba-d/sdk';
 *
 * export class MyCustomAgent extends Agent {
 *   readonly name = 'MyCustomAgent';
 *   readonly description = 'Does something awesome';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     const response = await callLLM('Write a poem about agents', { temperature: 0.7 });
 *     return { success: true, summary: 'Created a poem', details: response };
 *   }
 * }
 * ```
 */

// ─── Shared Types ───────────────────────────────────────────────────────────

/** Status of a single task step within the execution plan */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A single step in the ordered execution plan */
export interface TaskStep {
  id: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: string;
}

/** A file artifact discovered or produced during agent execution */
export interface Artifact {
  path: string;
  content: string;
  description: string;
}

/** A message exchanged between agents via the context bus */
export interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

/** A file change proposed or applied by an agent */
export interface FileChange {
  path: string;
  originalContent?: string;
  newContent?: string;
  status: 'created' | 'modified' | 'deleted';
}

/** Options passed to the LLM call function */
export interface InferenceOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * The shared context bus that all agents read from and write to.
 * This is the single source of truth for inter-agent communication.
 */
export interface AgentContext {
  /** The original user goal / task description */
  goal: string;

  /** Absolute path to the working directory (project root) */
  workingDirectory: string;

  /** Ordered task plan produced by the PlannerAgent */
  taskPlan: TaskStep[];

  /** File artifacts discovered (context) or produced (output) */
  artifacts: Artifact[];

  /** Agent-to-agent conversation log */
  conversations: AgentMessage[];

  /** File changes proposed by the WriterAgent */
  fileChanges: FileChange[];

  /** Arbitrary metadata for extensibility */
  metadata: Record<string, unknown>;
}

/** The result returned by an agent after execution */
export interface AgentResult {
  success: boolean;
  summary: string;
  details?: string;
  error?: string;
}

/**
 * Callback type that agents use to invoke the LLM.
 * The orchestrator injects this so it can control provider/model per agent.
 */
export type LLMCallFn = (
  prompt: string,
  options?: InferenceOptions,
) => Promise<string>;

// ─── Abstract Agent ─────────────────────────────────────────────────────────

/**
 * Base class for all specialized agents.
 *
 * To create a custom agent:
 * 1. Extend this class
 * 2. Set `name` and `description`
 * 3. Implement `execute(context, callLLM)`
 *
 * @example
 * ```ts
 * import { Agent, type AgentContext, type AgentResult } from '@agent-baba-d/sdk';
 *
 * export class MyAgent extends Agent {
 *   readonly name = 'MyAgent';
 *   readonly description = 'My custom agent';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     const result = await callLLM(`Context: ${JSON.stringify(context)}`);
 *     return { success: true, summary: 'Done', details: result };
 *   }
 * }
 * ```
 */
export abstract class Agent {
  /** Human-readable agent name (e.g. "Planner", "Writer", "MyCustomAgent") */
  abstract readonly name: string;

  /** Short description of what this agent does */
  abstract readonly description: string;

  /**
   * Execute the agent's specialized task.
   *
   * @param context — Shared context bus — read inputs, write outputs
   * @param callLLM — Function to call the LLM with a prompt
   * @returns       Result indicating success/failure + summary
   */
  abstract execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}

// ─── Agent Metadata ─────────────────────────────────────────────────────────

/**
 * Metadata for a custom agent plugin.
 * This is used by the auto-discovery system in ~/.buff/agents/.
 *
 * @example
 * ```ts
 * import { Agent, type AgentPluginMetadata } from '@agent-nuvira/sdk';
 *
 * const metadata: AgentPluginMetadata = {
 *   name: 'My Custom Agent',
 *   version: '1.0.0',
 *   description: 'Does something awesome',
 *   author: 'your-github-handle',
 *   agentTypes: ['writer', 'reviewer'], // Which agent roles this plugin can fulfill
 * };
 * ```
 */
export interface AgentPluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Which agent types this plugin can act as (e.g., ['writer', 'reviewer']) */
  agentTypes: string[];
}

/**
 * The full AgentPlugin interface for auto-discovery.
 * Export a default object matching this from your plugin file in ~/.buff/agents/.
 *
 * @example
 * ```ts
 * // ~/.buff/agents/my-custom-agent.js
 * import { MyAgent } from './my-agent.js';
 *
 * export default {
 *   metadata: {
 *     name: 'My Custom Agent',
 *     version: '1.0.0',
 *     description: 'Does something awesome',
 *     author: 'your-github-handle',
 *     agentTypes: ['writer'],
 *   },
 *   execute: (context, callLLM) => new MyAgent().execute(context, callLLM),
 * };
 * ```
 */
export interface AgentPlugin {
  metadata: AgentPluginMetadata;
  execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
