/**
 * Credential Files — Secure credential file handling.
 *
 * Hermes equivalent: credential_files.py
 */
export interface CredentialFile {
    /** Credential name */
    name: string;
    /** File path */
    path: string;
    /** Whether file exists */
    exists: boolean;
    /** File permissions */
    permissions?: string;
    /** File size */
    size?: number;
    /** Whether permissions are secure */
    permissionsSecure?: boolean;
}
export interface EnvProbeResult {
    /** Environment variable name */
    name: string;
    /** Whether it's set */
    set: boolean;
    /** Value (masked if sensitive) */
    value: string;
    /** Whether it's a secret */
    isSecret: boolean;
    /** Source */
    source: 'env' | 'file' | 'default';
}
export declare class CredentialFileManager {
    /**
     * Check the status of a credential file.
     */
    checkFile(filePath: string): CredentialFile;
    /**
     * Secure a credential file (set restrictive permissions).
     */
    secureFile(filePath: string): boolean;
    /**
     * Read a credential file (safe read with logging).
     */
    readFile(filePath: string): string | null;
    /**
     * Write a credential file (secure write).
     */
    writeFile(filePath: string, content: string): boolean;
    /**
     * Hash a credential file for change detection.
     */
    hashFile(filePath: string): string | null;
    /**
     * Check if a filename looks like it contains credentials.
     */
    isCredentialFilename(filename: string): boolean;
}
export declare class EnvProbe {
    private sensitiveNames;
    /**
     * Probe an environment variable.
     */
    probe(name: string): EnvProbeResult;
    /**
     * Probe multiple environment variables.
     */
    probeMultiple(names: string[]): EnvProbeResult[];
    /**
     * Probe all environment variables matching a pattern.
     */
    probePattern(pattern: string | RegExp): EnvProbeResult[];
    private isSensitive;
    private maskValue;
}
export declare function getCredentialFileManager(): CredentialFileManager;
export declare function getEnvProbe(): EnvProbe;
//# sourceMappingURL=credential-env-tools.d.ts.map