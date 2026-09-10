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
import { platform } from 'node:os';
import { resolve, normalize, isAbsolute, sep, join, basename, dirname, extname } from 'node:path';
import { lstat, access, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
// ─── Platform Detection ──────────────────────────────────────────────────
/**
 * Detect the current platform.
 */
export function detectPlatform() {
    const p = platform();
    switch (p) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        default:
            return 'linux';
    }
}
/**
 * Check if running on Windows.
 */
export function isWindows() {
    return detectPlatform() === 'windows';
}
/**
 * Check if running on macOS.
 */
export function isMacOS() {
    return detectPlatform() === 'macos';
}
/**
 * Check if running on Linux.
 */
export function isLinux() {
    return detectPlatform() === 'linux';
}
// ─── Path Conversion ─────────────────────────────────────────────────────
/**
 * Convert MSYS/Git Bash path to Windows path.
 * Example: /c/Users/ → C:\Users\
 */
export function msysToWindows(path) {
    // Match MSYS pattern: /<drive>/<path>
    const msysMatch = path.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (!msysMatch) {
        return {
            path,
            original: path,
            type: 'msys',
            success: false,
            error: 'Not an MSYS path',
        };
    }
    const drive = msysMatch[1].toUpperCase();
    const rest = msysMatch[2] ?? '';
    const windowsPath = `${drive}:${rest.replace(/\//g, '\\')}`;
    return {
        path: windowsPath,
        original: path,
        type: 'msys',
        success: true,
    };
}
/**
 * Convert Cygwin path to Windows path.
 * Example: /cygdrive/c/Users/ → C:\Users\
 */
export function cygwinToWindows(path) {
    // Match Cygwin pattern: /cygdrive/<drive>/<path>
    const cygwinMatch = path.match(/^\/cygdrive\/([a-zA-Z])(\/.*)?$/);
    if (!cygwinMatch) {
        return {
            path,
            original: path,
            type: 'cygwin',
            success: false,
            error: 'Not a Cygwin path',
        };
    }
    const drive = cygwinMatch[1].toUpperCase();
    const rest = cygwinMatch[2] ?? '';
    const windowsPath = `${drive}:${rest.replace(/\//g, '\\')}`;
    return {
        path: windowsPath,
        original: path,
        type: 'cygwin',
        success: true,
    };
}
/**
 * Convert WSL path to Windows path.
 * Example: /mnt/c/Users/ → C:\Users\
 */
export function wslToWindows(path) {
    // Match WSL pattern: /mnt/<drive>/<path>
    const wslMatch = path.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
    if (!wslMatch) {
        return {
            path,
            original: path,
            type: 'wsl',
            success: false,
            error: 'Not a WSL path',
        };
    }
    const drive = wslMatch[1].toUpperCase();
    const rest = wslMatch[2] ?? '';
    const windowsPath = `${drive}:${rest.replace(/\//g, '\\')}`;
    return {
        path: windowsPath,
        original: path,
        type: 'wsl',
        success: true,
    };
}
/**
 * Convert Windows path to MSYS path.
 * Example: C:\Users\ → /c/Users/
 */
export function windowsToMsys(path) {
    // Match Windows pattern: <drive>:\<path>
    const windowsMatch = path.match(/^([a-zA-Z]):(\\.*)?$/);
    if (!windowsMatch) {
        return {
            path,
            original: path,
            type: 'msys',
            success: false,
            error: 'Not a Windows path',
        };
    }
    const drive = windowsMatch[1].toLowerCase();
    const rest = windowsMatch[2] ?? '';
    const msysPath = `/${drive}${rest.replace(/\\/g, '/')}`;
    return {
        path: msysPath,
        original: path,
        type: 'msys',
        success: true,
    };
}
/**
 * Convert Windows path to Cygwin path.
 * Example: C:\Users\ → /cygdrive/c/Users/
 */
export function windowsToCygwin(path) {
    // Match Windows pattern: <drive>:\<path>
    const windowsMatch = path.match(/^([a-zA-Z]):(\\.*)?$/);
    if (!windowsMatch) {
        return {
            path,
            original: path,
            type: 'cygwin',
            success: false,
            error: 'Not a Windows path',
        };
    }
    const drive = windowsMatch[1].toLowerCase();
    const rest = windowsMatch[2] ?? '';
    const cygwinPath = `/cygdrive/${drive}${rest.replace(/\\/g, '/')}`;
    return {
        path: cygwinPath,
        original: path,
        type: 'cygwin',
        success: true,
    };
}
/**
 * Convert Windows path to WSL path.
 * Example: C:\Users\ → /mnt/c/Users/
 */
export function windowsToWsl(path) {
    // Match Windows pattern: <drive>:\<path>
    const windowsMatch = path.match(/^([a-zA-Z]):(\\.*)?$/);
    if (!windowsMatch) {
        return {
            path,
            original: path,
            type: 'wsl',
            success: false,
            error: 'Not a Windows path',
        };
    }
    const drive = windowsMatch[1].toLowerCase();
    const rest = windowsMatch[2] ?? '';
    const wslPath = `/mnt/${drive}${rest.replace(/\\/g, '/')}`;
    return {
        path: wslPath,
        original: path,
        type: 'wsl',
        success: true,
    };
}
/**
 * Detect path type and convert to Windows path.
 */
export function detectAndConvert(path) {
    // Check for MSYS
    if (path.match(/^\/[a-zA-Z]\//)) {
        return msysToWindows(path);
    }
    // Check for Cygwin
    if (path.startsWith('/cygdrive/')) {
        return cygwinToWindows(path);
    }
    // Check for WSL
    if (path.startsWith('/mnt/') && path.match(/^\/mnt\/[a-zA-Z]\//)) {
        return wslToWindows(path);
    }
    // Check for Windows
    if (path.match(/^[a-zA-Z]:\\/)) {
        return {
            path,
            original: path,
            type: 'native',
            success: true,
        };
    }
    // Check for UNC
    if (path.startsWith('\\\\')) {
        return {
            path,
            original: path,
            type: 'unc',
            success: true,
        };
    }
    // Not a recognized format
    return {
        path,
        original: path,
        type: 'none',
        success: false,
        error: 'Unrecognized path format',
    };
}
// ─── Path Validation ─────────────────────────────────────────────────────
/**
 * Validate a path with detailed results.
 */
export async function validatePath(path) {
    const result = {
        valid: false,
        exists: false,
        isDirectory: false,
        isFile: false,
        isSymlink: false,
        isReadable: false,
        isWritable: false,
        isExecutable: false,
    };
    try {
        // Check if path exists
        const stats = await lstat(path);
        result.exists = true;
        result.isDirectory = stats.isDirectory();
        result.isFile = stats.isFile();
        result.isSymlink = stats.isSymbolicLink();
        // Check permissions
        try {
            await access(path, constants.R_OK);
            result.isReadable = true;
        }
        catch {
            // Not readable
        }
        try {
            await access(path, constants.W_OK);
            result.isWritable = true;
        }
        catch {
            // Not writable
        }
        try {
            await access(path, constants.X_OK);
            result.isExecutable = true;
        }
        catch {
            // Not executable
        }
        result.valid = true;
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
}
/**
 * Check if path is a long path (>260 chars).
 */
export function isLongPath(path) {
    return path.length > 260;
}
/**
 * Convert to long path format (Windows).
 */
export function toLongPath(path) {
    if (isWindows() && !path.startsWith('\\\\?\\')) {
        return `\\\\?\\${path}`;
    }
    return path;
}
/**
 * Convert from long path format (Windows).
 */
export function fromLongPath(path) {
    if (path.startsWith('\\\\?\\')) {
        return path.slice(4);
    }
    return path;
}
// ─── Path Normalization ──────────────────────────────────────────────────
/**
 * Normalize path for current platform.
 */
export function normalizePath(path) {
    // Convert to native separators
    if (isWindows()) {
        return path.replace(/\//g, '\\');
    }
    return path.replace(/\\/g, '/');
}
/**
 * Resolve path relative to base.
 */
export function resolvePath(base, relative) {
    if (isAbsolute(relative)) {
        return normalize(relative);
    }
    return resolve(base, relative);
}
/**
 * Get relative path from base to target.
 */
export function relativePath(base, target) {
    const baseParts = normalize(base).split(sep);
    const targetParts = normalize(target).split(sep);
    // Find common prefix
    let commonLength = 0;
    while (commonLength < baseParts.length &&
        commonLength < targetParts.length &&
        baseParts[commonLength] === targetParts[commonLength]) {
        commonLength++;
    }
    // Build relative path
    const relativeParts = [];
    // Add .. for remaining base parts
    for (let i = commonLength; i < baseParts.length; i++) {
        relativeParts.push('..');
    }
    // Add remaining target parts
    for (let i = commonLength; i < targetParts.length; i++) {
        relativeParts.push(targetParts[i]);
    }
    return relativeParts.join(sep);
}
// ─── Path Information ────────────────────────────────────────────────────
/**
 * Get path components.
 */
export function getPathComponents(path) {
    const normalized = normalize(path);
    return {
        root: sep === '\\' ? (normalized.match(/^[a-zA-Z]:\\/)?.[0] ?? sep) : sep,
        dir: dirname(normalized),
        base: basename(normalized),
        ext: extname(normalized),
        name: basename(normalized, extname(normalized)),
    };
}
/**
 * Check if path is absolute.
 */
export function isPathAbsolute(path) {
    if (isWindows()) {
        return /^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\');
    }
    return path.startsWith('/');
}
/**
 * Join paths safely.
 */
export function joinPaths(...paths) {
    return join(...paths);
}
// ─── Symbolic Link Resolution ────────────────────────────────────────────
/**
 * Resolve symbolic links in path.
 */
export async function resolveSymlinks(path) {
    try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
            const target = await readlink(path);
            return resolveSymlinks(resolve(dirname(path), target));
        }
        return path;
    }
    catch {
        return path;
    }
}
/**
 * Check if path contains symbolic links.
 */
export async function hasSymlinks(path) {
    try {
        const stats = await lstat(path);
        return stats.isSymbolicLink();
    }
    catch {
        return false;
    }
}
// ─── Export All ──────────────────────────────────────────────────────────
export default {
    // Platform detection
    detectPlatform,
    isWindows,
    isMacOS,
    isLinux,
    // Path conversion
    msysToWindows,
    cygwinToWindows,
    wslToWindows,
    windowsToMsys,
    windowsToCygwin,
    windowsToWsl,
    detectAndConvert,
    // Path validation
    validatePath,
    isLongPath,
    toLongPath,
    fromLongPath,
    // Path normalization
    normalizePath,
    resolvePath,
    relativePath,
    // Path information
    getPathComponents,
    isPathAbsolute,
    joinPaths,
    // Symbolic links
    resolveSymlinks,
    hasSymlinks,
};
//# sourceMappingURL=windows-paths.js.map