/**
 * @agent-nuvira/sdk/types — Core type definitions for building custom agents.
 *
 * These types mirror the types used in the Agent-Nuvira orchestration system.
 * Agents communicate through a shared {@link AgentContext} bus managed by the
 * {@link Orchestrator}.
 *
 * @module @agent-nuvira/sdk/types
 */
/** Status of a single task step within the execution plan */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
/** A single step in the ordered execution plan produced by the PlannerAgent */
export interface TaskStep {
    /** Unique identifier for this step (e.g. 'step-1', 'step-2') */
    id: string;
    /** Human-readable description of what this step does */
    description: string;
    /** The type of agent that should execute this step (e.g. 'writer', 'runner') */
    agentType: string;
    /** IDs of steps that must complete before this one can start */
    dependsOn: string[];
    /** Current execution status */
    status: TaskStatus;
    /** Optional result/summary text after execution */
    result?: string;
}
/** A file artifact discovered or produced during agent execution */
export interface Artifact {
    /** Relative or absolute path to the file */
    path: string;
    /** Full file content */
    content: string;
    /** Human-readable description of why this file is relevant */
    description: string;
}
/** A file change proposed or applied by an agent */
export interface FileChange {
    /** Relative or absolute path to the file */
    path: string;
    /** The original file content (undefined if file doesn't exist yet) */
    originalContent?: string;
    /** The new file content (undefined if file is being deleted) */
    newContent?: string;
    /** Whether the file is being created, modified, or deleted */
    status: 'created' | 'modified' | 'deleted';
}
/** A message exchanged between agents via the shared context bus */
export interface AgentMessage {
    /** Name of the sending agent */
    from: string;
    /** Name of the receiving agent */
    to: string;
    /** Message content */
    content: string;
    /** Unix timestamp when the message was sent */
    timestamp: number;
}
/**
 * Options passed to the LLM generation call.
 * Mirrors {@link InferenceOptions} from the main package.
 */
export interface InferenceOptions {
    /** Temperature for response randomness (0.0–2.0) */
    temperature?: number;
    /** Maximum tokens in the generated response */
    maxTokens?: number;
    /** Model identifier override */
    model?: string;
    /** Stop sequences */
    stop?: string[];
    /** Top-p nucleus sampling */
    topP?: number;
}
/**
 * Function signature that agents use to invoke the LLM.
 * The orchestrator injects this so it can control which provider/model
 * each agent uses.
 */
export type LLMCallFn = (prompt: string, options?: InferenceOptions) => Promise<string>;
/** Information about a rate-limit error, passed to the onRateLimit callback */
export interface RateLimitInfo {
    /** How long to wait before retrying, in milliseconds */
    retryAfterMs: number;
    /** Name of the model that was being used */
    modelName?: string;
    /** Provider identifier */
    provider?: string;
    /** Name of the agent that hit the limit */
    agentName: string;
    /** The original error message */
    errorMessage: string;
}
/** Actions the orchestrator/user can take when a rate limit is hit */
export type RateLimitAction = 
/** Wait the suggested time and retry with the current model */
{
    action: 'retry';
}
/** Gracefully skip this step (return soft success) */
 | {
    action: 'skip';
}
/** Fail immediately and stop the pipeline */
 | {
    action: 'abort';
}
/** Retry with a different model */
 | {
    action: 'switch-model';
    callLLM: LLMCallFn;
};
/** Callback used by agents to ask the orchestrator/user what to do on rate limit */
export type OnRateLimit = (info: RateLimitInfo) => Promise<RateLimitAction>;
/**
 * The shared context bus that all agents read from and write to.
 * This is the single source of truth for inter-agent communication.
 * Each agent receives this context and can read inputs, write outputs,
 * and exchange messages with other agents.
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
    /** Arbitrary metadata for extensibility (key-value store) */
    metadata: Record<string, unknown>;
    /**
     * Optional callback invoked when a rate-limit (429) error is detected.
     * If provided, the agent should call this instead of auto-retrying.
     * The orchestrator sets this to prompt the user for their preferred action.
     */
    onRateLimit?: OnRateLimit;
}
/** The result returned by an agent after execution */
export interface AgentResult {
    /** Whether the agent completed its task successfully */
    success: boolean;
    /** One-line summary of what happened */
    summary: string;
    /** Optional detailed output (runner stdout, file lists, etc.) */
    details?: string;
    /** Error message if the agent failed */
    error?: string;
}
/** Configuration options for an orchestration session */
export interface OrchestratorOptions {
    /** Inference provider type (e.g. 'groq', 'gemini', 'local') */
    provider?: string;
    /** Model override */
    model?: string;
    /** Whether to write files to disk (false = dry-run) */
    dryRun?: boolean;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Agent-specific model overrides */
    agentModels?: Partial<Record<string, string>>;
    /** Enable persistent memory (trajectory storage and retrieval) */
    useMemory?: boolean;
    /** Auto-create a review bundle instead of applying changes directly */
    reviewMode?: boolean;
    /** Auto-route each agent to its recommended model */
    autoRouteModels?: boolean;
    /** Pre-built task plan to use instead of calling the PlannerAgent */
    prefillPlan?: TaskStep[];
}
/** The final result of an orchestration session */
export interface OrchestrationResult {
    /** Overall success */
    success: boolean;
    /** The original user goal */
    goal: string;
    /** Summary of what was accomplished */
    summary: string;
    /** Number of tasks completed vs total */
    tasksCompleted: number;
    tasksTotal: number;
    /** Detailed results from each agent */
    agentResults: Array<{
        agent: string;
        success: boolean;
        summary: string;
    }>;
    /** File change summary */
    fileChanges: string;
    /** Runner output (from executed commands) */
    runOutput?: string;
    /** Error message if failed */
    error?: string;
    /** Memory trajectory ID if stored */
    trajectoryId?: string;
    /** Review bundle ID if review mode was enabled */
    reviewId?: string;
}
//# sourceMappingURL=types.d.ts.map