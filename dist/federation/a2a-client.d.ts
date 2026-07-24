/**
 * A2A Client — Discovers remote A2A-compliant agents and delegates tasks to them.
 *
 * Provides:
 * - fetchAgentCard(url) — Discover an agent's capabilities via AgentCard
 * - discoverAgent(url) — Wrapper that fetches and validates AgentCard
 * - delegateTask(url, request) — Delegate a task to a remote A2A agent
 * - pollTaskStatus(url, taskId) — Poll for task completion
 * - checkHealth(url) — Remote A2A health check
 *
 * Uses only Node.js built-in modules (http) — no external dependencies.
 */
import { type A2ATaskRequest, type A2ATaskResponse, type A2ATaskResult, type A2AHealth, type A2ADiscoveryResult } from './a2a-types.js';
/**
 * Fetch an AgentCard from a remote A2A-compliant server.
 * Tries /.well-known/agent-card first, then /a2a/agent-card as fallback.
 */
export declare function fetchAgentCard(baseUrl: string): Promise<A2ADiscoveryResult>;
/**
 * Discover an A2A agent by fetching and validating its AgentCard.
 */
export declare function discoverAgent(baseUrl: string): Promise<A2ADiscoveryResult>;
/**
 * Delegate a task to a remote A2A-compliant agent.
 *
 * Returns the initial task response with taskId and status endpoint.
 * Use pollTaskStatus() to wait for completion.
 */
export declare function delegateTask(baseUrl: string, request: A2ATaskRequest, timeoutMs?: number): Promise<A2ATaskResponse>;
/**
 * Poll for task status/result until completion or timeout.
 */
export declare function pollTaskStatus(baseUrl: string, taskId: string, pollIntervalMs?: number, timeoutMs?: number): Promise<A2ATaskResult>;
/**
 * Delegate a task to an A2A agent and wait for the result.
 * Combines delegateTask + pollTaskStatus into a single call.
 */
export declare function delegateAndWait(baseUrl: string, request: A2ATaskRequest, options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (progress: number, message: string) => void;
}): Promise<A2ATaskResult>;
/**
 * Check the health of a remote A2A server.
 */
export declare function checkA2AHealth(baseUrl: string): Promise<A2AHealth>;
//# sourceMappingURL=a2a-client.d.ts.map