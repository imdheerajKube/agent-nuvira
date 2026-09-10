/**
 * credential_files — Credential file management for remote terminal backends.
 *
 * Manages credential files for Docker, SSH, Modal sandbox execution:
 * - Tracks which credential files exist
 * - Provides secure access to credentials
 * - Redacts credentials in logs
 * - Supports multiple credential types
 */
type CredentialType = 'ssh-key' | 'api-key' | 'token' | 'certificate' | 'env-file' | 'generic';
interface CredentialFile {
    id: string;
    name: string;
    type: CredentialType;
    path: string;
    exists: boolean;
    createdAt: number;
    lastAccessed?: number;
    metadata?: Record<string, any>;
}
declare class CredentialFilesManager {
    private credentials;
    private manifestPath;
    private manifest;
    constructor(configDir?: string);
    /**
     * Register a credential file.
     */
    register(params: {
        name: string;
        type: CredentialType;
        path: string;
        metadata?: Record<string, any>;
    }): string;
    /**
     * Get a credential file.
     */
    get(id: string): CredentialFile | null;
    /**
     * Read credential content.
     */
    read(id: string): string | null;
    /**
     * List all credentials.
     */
    list(type?: CredentialType): CredentialFile[];
    /**
     * Remove a credential.
     */
    remove(id: string): boolean;
    /**
     * Redact credentials in text.
     */
    redact(text: string): string;
    /**
     * Get credential paths for mounting in containers.
     */
    getMountPaths(): string[];
    /**
     * Validate all credentials exist.
     */
    validate(): {
        valid: number;
        invalid: number;
        missing: string[];
    };
    /**
     * Load manifest from disk.
     */
    private loadManifest;
    /**
     * Save manifest to disk.
     */
    private saveManifest;
}
export declare function getCredentialFilesManager(): CredentialFilesManager;
export { CredentialFilesManager };
//# sourceMappingURL=credential-files.d.ts.map