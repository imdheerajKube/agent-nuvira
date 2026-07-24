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
// ─── Default AgentCard ──────────────────────────────────────────────────────
/**
 * Generate a default AgentCard for this Agent-Nuvira instance.
 * Used when no custom card is configured.
 */
export function createDefaultAgentCard(baseUrl, nodeName) {
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
//# sourceMappingURL=a2a-types.js.map