/**
 * Agent interfaces and abstract base class for the multi-agent orchestration system.
 *
 * Each agent is a specialized unit that performs a specific role in the pipeline
 * (planning, context gathering, writing, reviewing, etc.). Agents communicate
 * through a shared {@link AgentContext} bus managed by the Orchestrator.
 */

import type { InferenceOptions } from '../config/types.js';

// ─── Shared Types ───────────────────────────────────────────────────────────

/** Status of a single task step within the execution plan */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A single step in the ordered execution plan produced by the PlannerAgent */
export interface TaskStep {
  id: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  status: TaskStatus;
  /**
   * Complexity label for THIS subtask (assessment item #1: "decompose tasks
   * into subtasks labeled by complexity"). Emitted by the planner and used as
   * a complexityHint by Auto routing so routing is subtask-local instead of
   * goal-global. Values mirror ComplexityLevel.
   */
  complexity?: 'trivial' | 'simple' | 'moderate' | 'complex' | 'critical';
  result?: string;
  routingHints?: {
    effectiveAgentType?: string;
    followUpAgentType?: string;
    runSerially?: boolean;
    useRepair?: boolean;
    maxRepairs?: number;
    verificationPass?: boolean;
  };
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

/**
 * A user-readable "thinking" update emitted by an agent while it works.
 *
 * This is the transparency channel that turns the pipeline from a black box
 * into something the user can follow: agents report what they are doing,
 * what they found, and which decision they are making at each stage.
 *
 * @example
 * ```ts
 * context.onAgentUpdate?.({
 *   agentType: 'Writer',
 *   stage: 'drafting',
 *   message: 'Implementing JWT middleware in src/middleware/auth.ts',
 * });
 * ```
 */
export interface AgentUpdate {
  /** Human-readable agent name (e.g. 'Planner', 'Writer', 'Tester') */
  agentType: string;
  /** Short stage label (e.g. 'analyzing', 'drafting', 'reviewing') */
  stage: string;
  /** User-readable description of what the agent is doing / thinking */
  message: string;
  /** Optional id of the task step this update belongs to */
  taskId?: string;
}

/** A file change proposed or applied by an agent */
export interface FileChange {
  path: string;
  originalContent?: string;
  newContent?: string;
  status: 'created' | 'modified' | 'deleted';
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

  /** Ordered task plan produced by PlannerAgent */
  taskPlan: TaskStep[];

  /** File artifacts discovered (context) or produced (output) */
  artifacts: Artifact[];

  /** Agent-to-agent conversation log */
  conversations: AgentMessage[];

  /** File changes proposed by WriterAgent */
  fileChanges: FileChange[];

  /** Arbitrary metadata for extensibility */
  metadata: Record<string, unknown>;

  /**
   * Optional callback invoked when a rate-limit (429) error is detected.
   * If provided, the agent will call this instead of auto-retrying.
   * The orchestrator sets this to prompt the user for their preferred action.
   */
  onRateLimit?: OnRateLimit;

  /**
   * Optional transparency callback. Agents call this (via Agent.report())
   * to stream user-readable progress — what they are doing, what they found,
   * and how they are making decisions. The orchestrator forwards these to
   * the event bus so the CLI board / web dashboard can display them live.
   */
  onAgentUpdate?: (update: AgentUpdate) => void;
}

/** The result returned by an agent after execution */
export interface AgentResult {
  success: boolean;
  summary: string;
  details?: string;
  error?: string;
}

/**
 * Information about a rate-limit error, passed to onRateLimit callback.
 */
export interface RateLimitInfo {
  retryAfterMs: number;
  modelName?: string;
  provider?: string;
  agentName: string;
  errorMessage: string;
}

/**
 * Actions the orchestrator/user can take when a rate limit is hit.
 * - 'retry': wait the suggested time and retry with the current model
 * - 'skip': gracefully skip this step (return soft success)
 * - 'abort': fail immediately and stop the pipeline
 * - 'switch-model': retry with a different model (callback provides new callLLM)
 */
export type RateLimitAction =
  | { action: 'retry' }
  | { action: 'skip' }
  | { action: 'abort' }
  | { action: 'switch-model'; callLLM: LLMCallFn };

/**
 * Callback used by agents to ask the orchestrator/user what to do on rate limit.
 * If not set, the agent uses its built-in retry logic (auto-wait + retry).
 */
export type OnRateLimit = (info: RateLimitInfo) => Promise<RateLimitAction>;

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
 * To create a new agent:
 * 1. Extend this class
 * 2. Set `name` and `description`
 * 3. Implement `execute(context, callLLM)`
 */
export abstract class Agent {
  /** Human-readable agent name (e.g. "Planner", "Writer") */
  abstract readonly name: string;

  /** Short description of what this agent does */
  abstract readonly description: string;

  /**
   * Id of the task step this agent instance is currently working on.
   * Set by the orchestrator right before execute(); used to attach agent
   * "thinking" updates to the correct task line (safe under parallelism
   * because a fresh agent instance is created per task).
   */
  currentTaskId?: string;

  /**
   * Stream a user-readable "thinking" update to the pipeline UI.
   *
   * Best-effort: never throws. If no listener is attached (e.g. tests or
   * non-UI callers), the call is a no-op.
   *
   * @param context  The shared context bus (provides the onAgentUpdate sink)
   * @param stage    Short stage label (e.g. 'analyzing', 'drafting')
   * @param message  User-readable description of what the agent is doing
   */
  protected report(context: AgentContext, stage: string, message: string): void {
    try {
      context.onAgentUpdate?.({
        agentType: this.name,
        stage,
        message,
        taskId: this.currentTaskId,
      });
    } catch {
      // Transparency is best-effort — never let a reporting failure break the agent.
    }
  }

  /**
   * Execute the agent's specialized task.
   *
   * @param context  Shared context bus — read inputs, write outputs
   * @param callLLM  Function to call the LLM with a prompt
   * @returns        Result indicating success/failure + summary
   */
  abstract execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
