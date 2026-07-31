/**
 * PackageAgent — Manages npm package operations for the publishing pipeline.
 *
 * Capabilities:
 * - Bump version (patch, minor, major)
 * - Build project
 * - Generate changelog from git log
 * - Publish to npm
 * - Auto-setup npm auth from env vars or CredentialStore
 * - Pre-publish checks (auth, build success, version consistency)
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
    /**
     * Check if npm auth is configured before publishing.
     * Uses NPM_TOKEN env var, .npmrc, or sets up via CredentialStore.
     */
    private checkNpmAuth;
    /**
     * Full publish pipeline: version bump -> build -> publish.
     * Optionally sets up npm auth via CredentialStore if available.
     */
    private fullPublish;
    private publish;
    private generateChangelog;
    private parseNpmError;
    private exec;
}
//# sourceMappingURL=package-agent.d.ts.map