/**
 * @agent-nuvira/sdk/define — Ergonomic agent descriptor helper.
 *
 * Hand-writing an `agentDescriptor` object is where custom agents most often go
 * subtly wrong: the `agentType` drifts from the class name, a kebab-case typo
 * silently never matches a plan step, or the name/description disagree with the
 * class they describe. `defineAgent()` removes the duplication — it reads the
 * agent's own `name`/`description`, derives a kebab-case `agentType` when one is
 * not supplied, and validates the result at definition time so a broken
 * descriptor fails where it is written rather than at plan time.
 *
 * ## Usage
 *
 * ```ts
 * import { Agent, defineAgent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';
 *
 * class CodeFormatter extends Agent {
 *   readonly name = 'CodeFormatter';
 *   readonly description = 'Formats source code according to project conventions';
 *   async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
 *     return { success: true, summary: 'Formatted' };
 *   }
 * }
 *
 * export const agentDescriptor = defineAgent({ AgentClass: CodeFormatter, tags: 'code, format' });
 * ```
 *
 * @module @agent-nuvira/sdk/define
 */

import type { Agent, AgentDescriptor } from './agent.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input to {@link defineAgent}. Only `AgentClass` is required. */
export interface DefineAgentInput<T extends Agent> {
  /** The agent class (its no-arg constructor is called once to read metadata). */
  AgentClass: new () => T;
  /** Agent type used in task plans. Defaults to kebab-case of the agent name. */
  agentType?: string;
  /** Comma-separated tags for categorization. */
  tags?: string;
  /** Emoji/icon for the agent, used by the CLI and progress UI. */
  icon?: string;
  /** Override the name (defaults to the instance's `name`). */
  name?: string;
  /** Override the description (defaults to the instance's `description`). */
  description?: string;
}

/**
 * A descriptor with every field resolved. Unlike {@link AgentDescriptor},
 * `name`, `description` and `agentType` are guaranteed present.
 */
export interface DefinedAgent extends AgentDescriptor {
  name: string;
  description: string;
  agentType: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** "CodeFormatter" → "code-formatter"; "HTTPClient" → "http-client". */
export function toKebabCase(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// ─── defineAgent ────────────────────────────────────────────────────────────

/**
 * Build a validated agent descriptor from an agent class.
 *
 * @throws If the agent declares no name/description, if an explicit `agentType`
 *   is not kebab-case, or if the class cannot be instantiated.
 */
export function defineAgent<T extends Agent>(input: DefineAgentInput<T>): DefinedAgent {
  if (!input || typeof input.AgentClass !== 'function') {
    throw new Error('defineAgent: `AgentClass` is required and must be a class constructor.');
  }

  let instance: T;
  try {
    instance = new input.AgentClass();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`defineAgent: could not instantiate ${input.AgentClass.name || 'agent'} — ${msg}`);
  }

  const name = (input.name ?? instance.name ?? '').trim();
  const description = (input.description ?? instance.description ?? '').trim();
  if (!name) throw new Error('defineAgent: agent must declare a non-empty `name`.');
  if (!description) throw new Error(`defineAgent: agent '${name}' must declare a non-empty \`description\`.`);

  const agentType = input.agentType ?? toKebabCase(name);
  if (!/^[a-z][a-z0-9-]*$/.test(agentType)) {
    throw new Error(
      `defineAgent: agentType "${agentType}" must be kebab-case (lowercase letters, digits, hyphens).`,
    );
  }

  return {
    AgentClass: input.AgentClass,
    name,
    description,
    agentType,
    tags: input.tags,
    icon: input.icon,
  };
}
