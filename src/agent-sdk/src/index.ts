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
 * - `@agent-nuvira/sdk/register` — Register/unregister a custom agent with the orchestrator
 * - `@agent-nuvira/sdk/scaffold` — Scaffold a new custom agent project
 * - `@agent-nuvira/sdk/define` — `defineAgent()` descriptor helper
 *
 * @module @agent-nuvira/sdk
 */

// ─── Agent Base Class ───────────────────────────────────────────────────────

export { Agent } from './agent.js';
export type { AgentDescriptor } from './agent.js';

// ─── Registration ───────────────────────────────────────────────────────────

export { registerAgent, unregisterAgent } from './register.js';
export type { RegisterOptions, RegisterResult } from './register.js';

// ─── Scaffolding ────────────────────────────────────────────────────────────

export { scaffold, listTemplates } from './scaffold.js';
export type { ScaffoldOptions, ScaffoldTemplate } from './scaffold.js';

// ─── Descriptor Helper ──────────────────────────────────────────────────────

export { defineAgent, toKebabCase } from './define.js';
export type { DefineAgentInput, DefinedAgent } from './define.js';

// ─── Core Types ─────────────────────────────────────────────────────────────

export type {
  // Task & Plan
  TaskStatus,
  TaskStep,
  // File & Artifact
  Artifact,
  FileChange,
  // Communication
  AgentMessage,
  // LLM
  LLMCallFn,
  InferenceOptions,
  // Rate Limit
  RateLimitInfo,
  RateLimitAction,
  OnRateLimit,
  // Execution
  AgentContext,
  AgentResult,
  // Orchestrator
  OrchestratorOptions,
  OrchestrationResult,
} from './types.js';
