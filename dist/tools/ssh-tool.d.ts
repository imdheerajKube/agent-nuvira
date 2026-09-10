/**
 * SSH Tool — Remote server execution via SSH.
 *
 * This provides SSH capabilities:
 * - Connect to remote servers
 * - Execute commands remotely
 * - File transfer (SCP/SFTP)
 * - Port forwarding (tunnels)
 * - Key management
 * - Agent forwarding
 * - Jump hosts (multi-hop)
 * - Persistent sessions
 *
 * Better than Hermes:
 * - Built-in SSH key management
 * - Port forwarding support
 * - Jump host support
 * - Persistent sessions
 * - Integration with skill system
 */
import { ChildProcess } from 'node:child_process';
export interface SSHConfig {
    /** Hostname or IP */
    host: string;
    /** SSH port (default: 22) */
    port?: number;
    /** Username */
    username: string;
    /** Password (optional, prefer key-based auth) */
    password?: string;
    /** Path to private key file */
    privateKey?: string;
    /** Path to public key file */
    publicKey?: string;
    /** Passphrase for encrypted key */
    passphrase?: string;
    /** SSH config file path */
    configPath?: string;
    /** Connection timeout (ms) */
    timeout?: number;
    /** Keep-alive interval (ms) */
    keepAlive?: number;
}
export interface SSHCommandOptions {
    /** Command to execute */
    command: string;
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Timeout (ms) */
    timeout?: number;
    /** Capture stdout */
    captureStdout?: boolean;
    /** Capture stderr */
    captureStderr?: boolean;
}
export interface SSHTunnelConfig {
    /** Local port to bind */
    localPort: number;
    /** Remote host (default: localhost) */
    remoteHost?: string;
    /** Remote port to forward to */
    remotePort: number;
    /** Tunnel type */
    type?: 'local' | 'remote' | 'dynamic';
}
export interface SSHExecutionResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}
/**
 * Execute a command on a remote server.
 */
export declare function executeCommand(config: SSHConfig, options: SSHCommandOptions): Promise<SSHExecutionResult>;
/**
 * Copy file to remote server (SCP).
 */
export declare function copyToRemote(config: SSHConfig, localPath: string, remotePath: string): Promise<SSHExecutionResult>;
/**
 * Copy file from remote server (SCP).
 */
export declare function copyFromRemote(config: SSHConfig, remotePath: string, localPath: string): Promise<SSHExecutionResult>;
/**
 * Create SSH tunnel (port forwarding).
 */
export declare function createTunnel(config: SSHConfig, tunnel: SSHTunnelConfig): Promise<ChildProcess>;
/**
 * Generate SSH key pair.
 */
export declare function generateKeyPair(keyPath: string, options?: {
    type?: 'rsa' | 'ed25519' | 'ecdsa';
    bits?: number;
    comment?: string;
    passphrase?: string;
}): Promise<{
    publicKey: string;
    privateKey: string;
}>;
/**
 * Add public key to remote authorized_keys.
 */
export declare function addAuthorizedKey(config: SSHConfig, publicKey: string): Promise<SSHExecutionResult>;
/**
 * Close all SSH connections.
 */
export declare function closeAllConnections(): void;
/**
 * Get connection status.
 */
export declare function getConnectionStatus(): Array<{
    key: string;
    connected: boolean;
    pid?: number;
}>;
declare const _default: {
    executeCommand: typeof executeCommand;
    copyToRemote: typeof copyToRemote;
    copyFromRemote: typeof copyFromRemote;
    createTunnel: typeof createTunnel;
    generateKeyPair: typeof generateKeyPair;
    addAuthorizedKey: typeof addAuthorizedKey;
    closeAllConnections: typeof closeAllConnections;
    getConnectionStatus: typeof getConnectionStatus;
};
export default _default;
//# sourceMappingURL=ssh-tool.d.ts.map