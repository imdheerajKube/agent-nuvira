/**
 * PackageAgent — Manages npm package operations for the publishing pipeline.
 *
 * Capabilities:
 * - Bump version (patch, minor, major)
 * - Build project
 * - Generate changelog from git log
 * - Publish to npm
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-publish", "description": "Bump version and publish to npm", "agentType": "package", "dependsOn": ["step-test"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * PackageAgent — Manages npm package versioning, building, and publishing.
 */
export declare class PackageAgent extends Agent {
    readonly name = "Package";
    readonly description = "Manages package version, build, and npm publish";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    private detectBumpType;
    private bumpVersion;
    private build;
    private publish;
    private generateChangelog;
    private parseNpmError;
    private exec;
}
//# sourceMappingURL=package-agent.d.ts.map