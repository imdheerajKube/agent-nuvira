/**
 * GitHubReleaseAgent — Creates GitHub releases with auto-generated changelogs.
 *
 * Capabilities:
 * - Create git tags (with optional signing)
 * - Generate release notes from git log between tags (via LLM)
 * - Create GitHub releases via `gh` CLI
 * - List existing releases and tags
 * - Detect version from package.json
 *
 * Requires: `gh` CLI installed and authenticated, or uses `github_api_key` env var.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-release", "description": "Create GitHub release for v1.2.0", "agentType": "github-release", "dependsOn": ["step-test"] }
 * ```
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * GitHubReleaseAgent — Creates GitHub releases with changelogs.
 */
export declare class GitHubReleaseAgent extends Agent {
    readonly name = "GitHub Release";
    readonly description = "Creates GitHub releases with auto-generated changelogs";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    private detectOperation;
    /**
     * Detect the version to use for the release.
     * Checks: task description → package.json → latest tag + 1
     */
    private detectVersion;
    /**
     * Create a git tag for the release.
     */
    private createTag;
    /**
     * Create a full GitHub release (tag + release notes + publish).
     */
    private createRelease;
    /**
     * Generate release notes from git log using the LLM.
     */
    private generateReleaseNotes;
    /**
     * List existing releases.
     */
    private listReleases;
    private generateNotesFromLog;
    private generateNotesFallback;
    /**
     * Create a GitHub release via the `gh` CLI.
     */
    private createViaCLI;
    /**
     * Create a GitHub release via the API (fallback when gh CLI is not available).
     */
    private createViaAPI;
    /**
     * Detect the current git branch name.
     */
    private detectCurrentBranch;
    private exec;
}
//# sourceMappingURL=github-release-agent.d.ts.map