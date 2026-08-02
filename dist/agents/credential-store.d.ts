/**
 * CredentialStore — Collects, validates, and manages credentials for publishing.
 *
 * Capabilities:
 * - Collect Git credentials (HTTPS token, SSH key path) from env vars or interactive prompts
 * - Collect npm credentials (token, registry) from env vars or interactive prompts
 * - Validate credentials before use
 * - Write temporary .npmrc and git credential files
 * - Zero-config detection from environment variables
 *
 * Usage:
 * ```ts
 * const creds = new CredentialStore();
 * await creds.collectAll();  // Interactive: prompts for what's missing
 * creds.setupNpmAuth();      // Writes .npmrc with token
 * creds.setupGitCredentials(); // Sets GIT_ASKPASS for HTTPS auth
 * ```
 */
export interface GitCredentials {
    /** Remote URL (e.g., https://github.com/user/repo.git) */
    remoteUrl?: string;
    /** GitHub username or token-based auth */
    username?: string;
    /** Personal Access Token (preferred over password) */
    token?: string;
    /** Path to SSH private key */
    sshKeyPath?: string;
    /** Whether to use SSH instead of HTTPS */
    useSsh?: boolean;
    /** Parsed owner/repo from remote URL */
    repoSlug?: string;
}
export interface NpmCredentials {
    /** npm token (from env NPM_TOKEN or .npmrc) */
    token?: string;
    /** npm registry URL (default: https://registry.npmjs.org/) */
    registry?: string;
    /** Whether credentials were already configured */
    configured: boolean;
}
export interface PublishCredentials {
    git: GitCredentials;
    npm: NpmCredentials;
}
export declare class CredentialStore {
    private _git;
    private _npm;
    private _collected;
    /** The current git credentials */
    get git(): GitCredentials;
    /** The current npm credentials */
    get npm(): NpmCredentials;
    /** Whether credentials have been collected */
    get collected(): boolean;
    /** Whether we have enough credentials to push to git */
    get canPush(): boolean;
    /** Whether we have enough credentials to publish to npm */
    get canPublish(): boolean;
    /**
     * Auto-detect credentials from environment and existing config.
     * Does NOT prompt — call collectAll() for interactive collection.
     */
    constructor();
    /**
     * Collect missing credentials interactively.
     * Skips prompts for already-detected values.
     */
    collectAll(): Promise<PublishCredentials>;
    /**
     * Set up git credential helpers for the current session.
     * For HTTPS: writes a GIT_ASKPASS script that echoes the token.
     * For SSH: sets up SSH agent with key, optionally with passphrase.
     *
     * Call this AFTER collectAll().
     */
    setupGitCredentials(): void;
    /**
     * Set up npm authentication for the current session.
     * Writes a temporary .npmrc in the project directory.
     *
     * Call this AFTER collectAll().
     */
    setupNpmAuth(): void;
    /**
     * Remove any temporary credential files created during setup.
     * Call this after publishing is complete.
     */
    cleanup(): void;
}
/**
 * Check if git credentials are available (env vars or pre-configured).
 */
export declare function checkGitCredentials(): boolean;
/**
 * Check if npm credentials are available (env vars or pre-configured).
 */
export declare function checkNpmCredentials(): boolean;
/**
 * Get a human-readable summary of the current credential status.
 */
export declare function getCredentialStatus(): string;
//# sourceMappingURL=credential-store.d.ts.map