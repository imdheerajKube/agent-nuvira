/**
 * Windows Path Handling — Cross-platform path conversion and validation.
 *
 * This provides Windows-specific path handling:
 * - MSYS/Git Bash path conversion
 * - Cygwin path conversion
 * - WSL path conversion
 * - UNC path support
 * - Long path support (>260 chars)
 * - Drive letter detection
 * - Path normalization
 * - Path validation
 * - Permission checking
 * - Symbolic link resolution
 *
 * Better than Hermes:
 * - Support for all Windows path formats
 * - Automatic platform detection
 * - Path validation with detailed errors
 * - Permission checking
 * - Integration with file operations
 */
export interface PathConversionResult {
    /** Converted path */
    path: string;
    /** Original path */
    original: string;
    /** Conversion type */
    type: 'msys' | 'cygwin' | 'wsl' | 'unc' | 'native' | 'none';
    /** Whether conversion was successful */
    success: boolean;
    /** Error message if conversion failed */
    error?: string;
}
export interface PathValidationResult {
    /** Whether path is valid */
    valid: boolean;
    /** Path exists */
    exists: boolean;
    /** Is directory */
    isDirectory: boolean;
    /** Is file */
    isFile: boolean;
    /** Is symbolic link */
    isSymlink: boolean;
    /** Is readable */
    isReadable: boolean;
    /** Is writable */
    isWritable: boolean;
    /** Is executable */
    isExecutable: boolean;
    /** Error message if validation failed */
    error?: string;
}
/**
 * Detect the current platform.
 */
export declare function detectPlatform(): 'windows' | 'macos' | 'linux';
/**
 * Check if running on Windows.
 */
export declare function isWindows(): boolean;
/**
 * Check if running on macOS.
 */
export declare function isMacOS(): boolean;
/**
 * Check if running on Linux.
 */
export declare function isLinux(): boolean;
/**
 * Convert MSYS/Git Bash path to Windows path.
 * Example: /c/Users/ → C:\Users\
 */
export declare function msysToWindows(path: string): PathConversionResult;
/**
 * Convert Cygwin path to Windows path.
 * Example: /cygdrive/c/Users/ → C:\Users\
 */
export declare function cygwinToWindows(path: string): PathConversionResult;
/**
 * Convert WSL path to Windows path.
 * Example: /mnt/c/Users/ → C:\Users\
 */
export declare function wslToWindows(path: string): PathConversionResult;
/**
 * Convert Windows path to MSYS path.
 * Example: C:\Users\ → /c/Users/
 */
export declare function windowsToMsys(path: string): PathConversionResult;
/**
 * Convert Windows path to Cygwin path.
 * Example: C:\Users\ → /cygdrive/c/Users/
 */
export declare function windowsToCygwin(path: string): PathConversionResult;
/**
 * Convert Windows path to WSL path.
 * Example: C:\Users\ → /mnt/c/Users/
 */
export declare function windowsToWsl(path: string): PathConversionResult;
/**
 * Detect path type and convert to Windows path.
 */
export declare function detectAndConvert(path: string): PathConversionResult;
/**
 * Validate a path with detailed results.
 */
export declare function validatePath(path: string): Promise<PathValidationResult>;
/**
 * Check if path is a long path (>260 chars).
 */
export declare function isLongPath(path: string): boolean;
/**
 * Convert to long path format (Windows).
 */
export declare function toLongPath(path: string): string;
/**
 * Convert from long path format (Windows).
 */
export declare function fromLongPath(path: string): string;
/**
 * Normalize path for current platform.
 */
export declare function normalizePath(path: string): string;
/**
 * Resolve path relative to base.
 */
export declare function resolvePath(base: string, relative: string): string;
/**
 * Get relative path from base to target.
 */
export declare function relativePath(base: string, target: string): string;
/**
 * Get path components.
 */
export declare function getPathComponents(path: string): {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
};
/**
 * Check if path is absolute.
 */
export declare function isPathAbsolute(path: string): boolean;
/**
 * Join paths safely.
 */
export declare function joinPaths(...paths: string[]): string;
/**
 * Resolve symbolic links in path.
 */
export declare function resolveSymlinks(path: string): Promise<string>;
/**
 * Check if path contains symbolic links.
 */
export declare function hasSymlinks(path: string): Promise<boolean>;
declare const _default: {
    detectPlatform: typeof detectPlatform;
    isWindows: typeof isWindows;
    isMacOS: typeof isMacOS;
    isLinux: typeof isLinux;
    msysToWindows: typeof msysToWindows;
    cygwinToWindows: typeof cygwinToWindows;
    wslToWindows: typeof wslToWindows;
    windowsToMsys: typeof windowsToMsys;
    windowsToCygwin: typeof windowsToCygwin;
    windowsToWsl: typeof windowsToWsl;
    detectAndConvert: typeof detectAndConvert;
    validatePath: typeof validatePath;
    isLongPath: typeof isLongPath;
    toLongPath: typeof toLongPath;
    fromLongPath: typeof fromLongPath;
    normalizePath: typeof normalizePath;
    resolvePath: typeof resolvePath;
    relativePath: typeof relativePath;
    getPathComponents: typeof getPathComponents;
    isPathAbsolute: typeof isPathAbsolute;
    joinPaths: typeof joinPaths;
    resolveSymlinks: typeof resolveSymlinks;
    hasSymlinks: typeof hasSymlinks;
};
export default _default;
//# sourceMappingURL=windows-paths.d.ts.map