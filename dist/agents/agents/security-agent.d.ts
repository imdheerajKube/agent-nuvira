/**
 * SecurityAgent — Detects security issues in agent prompts and generated code.
 *
 * Capabilities:
 * - Scan LLM prompts for injection/jailbreak attempts before sending
 * - Scan generated code changes for PII, dangerous patterns, vulnerabilities
 * - Validate file paths for directory traversal attempts
 * - Integrated with the orchestrator pipeline to block unsafe content
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-security", "description": "Scan code for security issues", "agentType": "security", "dependsOn": ["step-write"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * SecurityAgent — Scans prompts and generated content for security issues.
 */
export declare class SecurityAgent extends Agent {
    readonly name = "Security";
    readonly description = "Scans for PII, prompt injection, and dangerous code patterns";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Parse which scan types to run based on the task description.
     */
    private parseScanTypes;
    /**
     * Check if a file path is safe (no directory traversal, no protected paths).
     */
    private checkPathSafety;
}
//# sourceMappingURL=security-agent.d.ts.map