/**
 * Sandbox images — Pre-defined Docker images for common programming languages.
 *
 * These are used as base images for sandbox containers. Each image definition
 * includes the Docker image name, language/runtime details, and default
 * install/test commands.
 *
 * Images are pulled on first use if not present locally.
 */
import type { SandboxImage } from './types.js';
/**
 * Pre-defined sandbox images for common runtimes.
 */
export declare const BUILTIN_SANDBOX_IMAGES: SandboxImage[];
/**
 * Find a built-in sandbox image by language/runtime name (case-insensitive).
 *
 * Examples:
 *   resolveSandboxImage('node')        → node:20-slim
 *   resolveSandboxImage('python')      → python:3.12-slim
 *   resolveSandboxImage('go')          → golang:1.22
 *   resolveSandboxImage('golang')      → golang:1.22
 *   resolveSandboxImage('rust')        → rust:1.77-slim
 */
export declare function resolveSandboxImage(runtime: string): SandboxImage | undefined;
/**
 * Get the default sandbox image based on detected project type.
 * Checks for common project files to determine runtime.
 */
export declare function detectProjectImage(projectDir: string): SandboxImage;
//# sourceMappingURL=images.d.ts.map