/**
 * @agent-nuvira/sdk — Agent-Nuvira Software Development Kit
 *
 * Build custom agents for the Agent-Nuvira multi-agent orchestration system.
 *
 * ## Quick Start
 *
 * ```ts
 * import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';
 *
 * export class MyAgent extends Agent {
 *   readonly name = 'MyAgent';
 *   readonly description = 'Does something useful';
 *
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     return { success: true, summary: 'Done!' };
 *   }
 * }
 * ```
 *
 * ## Sub-modules
 *
 * - `@agent-nuvira/sdk` — Base Agent class + core types
 * - `@agent-nuvira/sdk/agent` — Agent class only
 * - `@agent-nuvira/sdk/types` — Type definitions only
 * - `@agent-nuvira/sdk/testing` — Testing utilities (mock context, mock LLM, assertions)
 *
 * @module @agent-nuvira/sdk
 */
export { Agent } from './agent.js';
export type { AgentDescriptor } from './agent.js';
export type { TaskStatus, TaskStep, Artifact, FileChange, AgentMessage, LLMCallFn, InferenceOptions, RateLimitInfo, RateLimitAction, OnRateLimit, AgentContext, AgentResult, OrchestratorOptions, OrchestrationResult, } from './types.js';
//# sourceMappingURL=index.d.ts.map