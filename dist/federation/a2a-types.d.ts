/**
 * A2A (Agent-to-Agent) Protocol Types — Google A2A-compatible types for
 * cross-ecosystem agent discovery, capability advertisement, and task delegation.
 *
 * ## Overview
 *
 * A2A enables agents from different systems to discover each other's capabilities
 * and delegate tasks to one another. It runs alongside the existing custom
 * federation protocol (in src/federation/) — the federation protocol is used
 * for internal Agent-Nuvira cluster communication, while A2A is for interop
 * with external A2A-compliant agents (e.g., Google ADK agents, LangChain agents).
 *
 * ## Key Concepts
 *
 * - **AgentCard**: A JSON document describing an agent's identity, capabilities,
 *   skills, and endpoints. Served at GET /.well-known/agent-card or GET /a2a/agent-card.
 * - **Skill**: A discrete capability an agent can perform with defined input/output schemas.
 * - **Task**: A unit of work delegated between agents, with status tracking.
 * - **Discovery**: Agents find each other by fetching AgentCards from known URLs
 *   or via a directory service.
 *
 * ## A2A Endpoints
 *
 * | Endpoint | Method | Description |
 * |---|---|---|
 * | `/.well-known/agent-card` | GET | Standard discovery endpoint |
 * | `/a2a/agent-card` | GET | Alternative discovery endpoint |
 * | `/a2a/task` | POST | Delegate a task to this agent |
 * | `/a2a/task/:id` | GET | Get task status/result |
 * | `/a2a/health` | GET | Health check |
 *
 * ## References
 *
 * - Google A2A Spec: https://github.com/google/A2A
 * - AgentCard schema: https://github.com/google/A2A/blob/main/spec/agent-card.md
 */
/** A2A protocol version supported */
export declare const A2A_PROTOCOL_VERSION = "1.0";
/** Default port for the A2A server */
export declare const A2A_DEFAULT_PORT = 8375;
/** Default host for the A2A server */
export declare const A2A_DEFAULT_HOST = "0.0.0.0";
/** Heartbeat interval for long-running task connections (ms) */
export declare const A2A_HEARTBEAT_MS = 15000;
/** Task timeout default (30 min) */
export declare const A2A_TASK_TIMEOUT_MS: number;
/**
 * A2A AgentCard — Describes an agent's identity, capabilities, and endpoints.
 * Follows the Google A2A AgentCard specification.
 */
export interface AgentCard {
    /** Protocol version */
    version: string;
    /** Human-readable agent name */
    name: string;
    /** Agent description */
    description: string;
    /** Agent URL (base URL for A2A endpoints) */
    url: string;
    /** Agent identity */
    identity?: {
        /** Organization/institution name */
        organization?: string;
        /** Contact email */
        contactEmail?: string;
        /** Icon/avatar URL */
        iconUrl?: string;
        /** Documentation URL */
        documentationUrl?: string;
    };
    /** Capabilities this agent supports */
    capabilities: AgentCapability[];
    /** Skills this agent can perform */
    skills: AgentSkill[];
    /** Endpoint paths relative to the base URL */
    endpoints: {
        /** AgentCard endpoint (default: /.well-known/agent-card) */
        agentCard?: string;
        /** Task delegation endpoint (default: /a2a/task) */
        task?: string;
        /** Task status endpoint (default: /a2a/task/:id) */
        taskStatus?: string;
        /** Health endpoint (default: /a2a/health) */
        health?: string;
    };
    /** Authentication requirements (optional) */
    authentication?: {
        /** Supported auth schemes: 'none' | 'bearer-token' | 'api-key' */
        schemes: Array<'none' | 'bearer-token' | 'api-key'>;
        /** Credentials location hint */
        credentialsLocation?: string;
    };
}
/** Agent capability — what the agent can do at a high level */
export interface AgentCapability {
    /** Capability ID (e.g., 'code-generation', 'code-review') */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of the capability */
    description: string;
}
/** Agent skill — a specific, well-defined operation the agent can perform */
export interface AgentSkill {
    /** Skill ID (e.g., 'refactor-module', 'generate-test') */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what this skill does */
    description: string;
    /** JSON Schema for input parameters */
    inputSchema?: Record<string, unknown>;
    /** JSON Schema for output */
    outputSchema?: Record<string, unknown>;
    /** Estimated complexity (trivial/simple/medium/complex/critical) */
    complexity?: string;
    /** Estimated time to complete (ms) */
    estimatedDurationMs?: number;
}
/** A2A task status */
export type A2ATaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
/** A2A task — a unit of work delegated between agents */
export interface A2ATask {
    /** Task ID */
    id: string;
    /** Current status */
    status: A2ATaskStatus;
    /** Task goal / instruction */
    goal: string;
    /** Which skill to use */
    skillId?: string;
    /** Agent type to invoke (e.g., 'writer', 'planner') */
    agentType?: string;
    /** Skill-specific parameters */
    parameters?: Record<string, unknown>;
    /** Provider/model overrides */
    provider?: string;
    model?: string;
    /** When the task was created */
    createdAt: number;
    /** When the task started running */
    startedAt?: number;
    /** When the task completed/failed */
    completedAt?: number;
    /** Progress message */
    message?: string;
    /** Progress percentage (0–100) */
    progress?: number;
}
/** A2A task result — returned when a task completes */
export interface A2ATaskResult {
    /** Task ID */
    taskId: string;
    /** Whether the task succeeded */
    success: boolean;
    /** Summary of what happened */
    summary: string;
    /** Detailed output */
    details?: string;
    /** Error message if failed */
    error?: string;
    /** Duration in ms */
    durationMs: number;
    /** Output files/content */
    output?: Array<{
        path: string;
        content: string;
    }>;
}
/** A2A task creation request */
export interface A2ATaskRequest {
    /** Task goal / instruction */
    goal: string;
    /** Which skill to use (mutually exclusive with agentType) */
    skillId?: string;
    /** Agent type to invoke (mutually exclusive with skillId) */
    agentType?: string;
    /** Skill-specific parameters */
    parameters?: Record<string, unknown>;
    /** Provider/model overrides */
    provider?: string;
    model?: string;
}
/** A2A task creation response */
export interface A2ATaskResponse {
    /** Task ID */
    taskId: string;
    /** Initial status */
    status: A2ATaskStatus;
    /** Message */
    message?: string;
    /** Endpoint to poll for status */
    statusEndpoint: string;
}
/** A2A directory entry for agent discovery */
export interface A2ADirectoryEntry {
    /** Agent name */
    name: string;
    /** Agent description */
    description: string;
    /** Base URL for A2A endpoints */
    url: string;
    /** When this entry was discovered/last verified */
    lastVerified: number;
    /** Agent capabilities summary */
    capabilities: string[];
}
/** Result of discovering an A2A agent */
export interface A2ADiscoveryResult {
    /** Whether discovery succeeded */
    success: boolean;
    /** The discovered AgentCard */
    card?: AgentCard;
    /** Error message if failed */
    error?: string;
    /** Response time in ms */
    responseTimeMs: number;
}
/** A2A server health */
export interface A2AHealth {
    status: 'ok' | 'degraded' | 'offline';
    version: string;
    uptime: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
}
/**
 * Generate a default AgentCard for this Agent-Nuvira instance.
 * Used when no custom card is configured.
 */
export declare function createDefaultAgentCard(baseUrl: string, nodeName: string): AgentCard;
//# sourceMappingURL=a2a-types.d.ts.map