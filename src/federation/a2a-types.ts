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

// ─── Constants ──────────────────────────────────────────────────────────────

/** A2A protocol version supported */
export const A2A_PROTOCOL_VERSION = '1.0';

/** Default port for the A2A server */
export const A2A_DEFAULT_PORT = 8375;

/** Default host for the A2A server */
export const A2A_DEFAULT_HOST = '0.0.0.0';

/** Heartbeat interval for long-running task connections (ms) */
export const A2A_HEARTBEAT_MS = 15_000;

/** Task timeout default (30 min) */
export const A2A_TASK_TIMEOUT_MS = 30 * 60 * 1000;

// ─── AgentCard ──────────────────────────────────────────────────────────────

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

// ─── Task Types ─────────────────────────────────────────────────────────────

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
  output?: Array<{ path: string; content: string }>;
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

// ─── Discovery Types ────────────────────────────────────────────────────────

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

// ─── Default AgentCard ──────────────────────────────────────────────────────

/**
 * Generate a default AgentCard for this Agent-Nuvira instance.
 * Used when no custom card is configured.
 */
export function createDefaultAgentCard(baseUrl: string, nodeName: string): AgentCard {
  return {
    version: A2A_PROTOCOL_VERSION,
    name: nodeName,
    description: 'Agent-Nuvira multi-agent coding platform',
    url: baseUrl,
    identity: {
      organization: 'Agent-Nuvira',
      documentationUrl: 'https://github.com/imdheerajKube/agent-nuvira',
    },
    capabilities: [
      { id: 'code-generation', name: 'Code Generation', description: 'Generate new source code files and projects' },
      { id: 'code-review', name: 'Code Review', description: 'Review existing code for bugs, style, and security issues' },
      { id: 'testing', name: 'Automated Testing', description: 'Generate and run tests for code verification' },
      { id: 'debugging', name: 'Debugging', description: 'Diagnose and fix test failures and runtime errors' },
      { id: 'refactoring', name: 'Refactoring', description: 'Restructure existing code without changing behavior' },
      { id: 'planning', name: 'Task Planning', description: 'Break down goals into executable task plans' },
    ],
    skills: [
      {
        id: 'execute-goal',
        name: 'Execute Goal',
        description: 'Run a full multi-agent pipeline to accomplish a goal',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'The goal to accomplish' },
            provider: { type: 'string', description: 'Optional provider override' },
            model: { type: 'string', description: 'Optional model override' },
          },
          required: ['goal'],
        },
        complexity: 'complex',
        estimatedDurationMs: 120_000,
      },
      {
        id: 'quick-fix',
        name: 'Quick Fix',
        description: 'Fix a bug or issue in a specific file',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Path to the file to fix' },
            issue: { type: 'string', description: 'Description of the issue' },
          },
          required: ['file', 'issue'],
        },
        complexity: 'medium',
        estimatedDurationMs: 30_000,
      },
      {
        id: 'review-code',
        name: 'Review Code',
        description: 'Review a file or code snippet for issues',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Path to the file to review' },
            context: { type: 'string', description: 'Additional context' },
          },
          required: ['file'],
        },
        complexity: 'medium',
        estimatedDurationMs: 20_000,
      },
      {
        id: 'generate-test',
        name: 'Generate Tests',
        description: 'Generate unit tests for a file',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Path to the file to test' },
            framework: { type: 'string', description: 'Test framework (e.g., vitest, jest)' },
          },
          required: ['file'],
        },
        complexity: 'medium',
        estimatedDurationMs: 45_000,
      },
    ],
    endpoints: {
      agentCard: '/.well-known/agent-card',
      task: '/a2a/task',
      taskStatus: '/a2a/task',
      health: '/a2a/health',
    },
    authentication: {
      schemes: ['none'],
    },
  };
}
