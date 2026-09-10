/**
 * Shell Detection — Detect and use correct shell for platform.
 *
 * This provides shell detection and execution:
 * - Auto-detect available shells
 * - PowerShell 7+ support
 * - CMD support
 * - Bash/Zsh support
 * - Shell-specific command formatting
 * - Error stream handling
 * - Output encoding
 *
 * Better than Hermes:
 * - Automatic shell detection
 * - Shell-specific error handling
 * - Output encoding support
 * - Integration with skill system
 */
export type ShellType = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'unknown';
export interface ShellInfo {
    /** Shell type */
    type: ShellType;
    /** Shell executable path */
    path: string;
    /** Shell version */
    version?: string;
    /** Whether shell is available */
    available: boolean;
}
export interface ShellExecutionResult {
    /** Exit code */
    exitCode: number;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Shell used */
    shell: ShellType;
}
/**
 * Detect available shells on the system.
 */
export declare function detectShells(): Promise<ShellInfo[]>;
/**
 * Get the default shell for the current platform.
 */
export declare function getDefaultShell(): ShellType;
/**
 * Get the best available shell.
 */
export declare function getBestShell(): Promise<ShellInfo>;
/**
 * Execute a command in a shell.
 */
export declare function executeShellCommand(command: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    shell?: ShellType;
}): Promise<ShellExecutionResult>;
/**
 * Build shell-specific command.
 */
declare function buildShellCommand(shell: ShellType, command: string, args: string[]): {
    execCommand: string;
    execArgs: string[];
};
/**
 * Execute a PowerShell script block.
 */
export declare function executePowerShellScript(script: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    executionPolicy?: 'Restricted' | 'AllSigned' | 'RemoteSigned' | 'Unrestricted';
}): Promise<ShellExecutionResult>;
/**
 * Execute a PowerShell script file.
 */
export declare function executePowerShellFile(filePath: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}): Promise<ShellExecutionResult>;
/**
 * Execute a CMD command.
 */
export declare function executeCMDCommand(command: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}): Promise<ShellExecutionResult>;
/**
 * Execute a Bash script.
 */
export declare function executeBashScript(script: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}): Promise<ShellExecutionResult>;
/**
 * Execute a Bash script file.
 */
export declare function executeBashFile(filePath: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}): Promise<ShellExecutionResult>;
declare const _default: {
    detectShells: typeof detectShells;
    getDefaultShell: typeof getDefaultShell;
    getBestShell: typeof getBestShell;
    executeShellCommand: typeof executeShellCommand;
    buildShellCommand: typeof buildShellCommand;
    executePowerShellScript: typeof executePowerShellScript;
    executePowerShellFile: typeof executePowerShellFile;
    executeCMDCommand: typeof executeCMDCommand;
    executeBashScript: typeof executeBashScript;
    executeBashFile: typeof executeBashFile;
};
export default _default;
//# sourceMappingURL=shell-detection.d.ts.map