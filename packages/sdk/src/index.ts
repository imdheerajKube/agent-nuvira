/**
 * @agent-nuvira/sdk — Build custom agents for the agent-nuvira platform.
 *
 * ## Quick Start
 *
 * ```bash
 * npm install @agent-nuvira/sdk
 * ```
 *
 * ```ts
 * import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';
 *
 * export class PoetryAgent extends Agent {
 *   readonly name = 'PoetryAgent';
 *   readonly description = 'Writes poems about code';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     const poem = await callLLM(
 *       `Write a short poem about: ${context.goal}`,
 *       { temperature: 0.8 }
 *     );
 *     return { success: true, summary: 'Poem written', details: poem };
 *   }
 * }
 * ```
 *
 * ## Installing custom agents
 *
 * Place compiled .js files in ~/.buff/agents/ for auto-discovery.
 *
 * ## Testing custom agents
 *
 * ```ts
 * import { createTestContext, createMockCallLLM, assertAgentResult } from '@agent-nuvira/sdk/testing';
 * ```
 */

export { Agent } from './agent.js';
export type {
  AgentContext,
  AgentResult,
  AgentMessage,
  Artifact,
  FileChange,
  InferenceOptions,
  LLMCallFn,
  TaskStep,
  TaskStatus,
  AgentPluginMetadata,
  AgentPlugin,
} from './agent.js';
