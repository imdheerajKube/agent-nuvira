/**
 * Sandbox types — Configuration types for Docker-based sandbox isolation.
 *
 * The sandbox system provides process-level isolation for running generated
 * code and tests inside Docker containers with configurable resource limits.
 *
 * Basic usage:
 * ```ts
 * const manager = new SandboxManager({ memoryLimit: '512m', cpuLimit: 1 });
 * const id = await manager.createContainer();
 * await manager.copyProject(id, '/path/to/project');
 * const result = await manager.runCommand(id, 'npm test');
 * await manager.destroyContainer(id);
 * ```
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ─── Resource Limits ────────────────────────────────────────────────────────

/** Resource limit constraints for a sandbox container */
export interface ResourceLimits {
  /** Max memory (e.g., '512m', '2g'). Default: '1g' */
  memoryLimit?: string;
  /** Max CPU cores (e.g., 0.5, 1, 2). Default: 1 */
  cpuLimit?: number;
  /** Max disk space (e.g., '1g', '10g'). Default: '2g' */
  diskLimit?: string;
  /** Max PIDs inside container. Default: 100 */
  pidsLimit?: number;
  /** Whether to enable network access. Default: false */
  networkAccess?: boolean;
  /** Max duration in ms before container is killed. Default: 600000 (10 min) */
  timeoutMs?: number;
}

// ─── Container Image ────────────────────────────────────────────────────────

/** A pre-defined or custom Docker image for sandbox containers */
export interface SandboxImage {
  /** Image name (e.g., 'node:20-slim') */
  image: string;
  /** Human-readable label (e.g., 'Node.js 20') */
  label: string;
  /** Package manager / runtime details */
  runtimes: string[];
  /** Install command prefix (e.g., 'npm install') */
  installCommand?: string;
  /** Test command prefix (e.g., 'npm test') */
  testCommand?: string;
  /** Shell to use inside container */
  shell?: string;
}

// ─── Sandbox Config ─────────────────────────────────────────────────────────

/** Complete sandbox configuration */
export interface SandboxConfig {
  /** Whether Docker sandbox is enabled */
  enabled: boolean;
  /** Resource limits */
  limits: Required<ResourceLimits>;
  /** Image to use for sandbox containers */
  image: SandboxImage;
  /** Container working directory */
  workDir: string;
  /** Non-root user to run as */
  containerUser: string;
  /** Timeout for stopping a container gracefully (ms) */
  stopTimeoutMs: number;
}

// ─── Container Status ───────────────────────────────────────────────────────

/** Lifecycle state of a managed container */
export type ContainerStatus = 'created' | 'running' | 'stopped' | 'removed';

/** Track a managed sandbox container */
export interface ManagedContainer {
  /** Container ID (Docker container hash) */
  containerId: string;
  /** Human-readable name (e.g., 'buff-sandbox-abc123') */
  name: string;
  /** Creation timestamp */
  createdAt: number;
  /** Current status */
  status: ContainerStatus;
  /** Resource limits applied */
  limits: ResourceLimits;
  /** Image used */
  image: string;
}

// ─── Execution Result ───────────────────────────────────────────────────────

/** Result of executing a command inside a sandbox container */
export interface SandboxExecResult {
  /** Whether the command exited with code 0 */
  success: boolean;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code */
  exitCode: number;
  /** Execution duration in ms */
  durationMs: number;
  /** Whether the container was killed due to timeout */
  timedOut: boolean;
  /** Error message if execution failed entirely */
  error?: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  memoryLimit: '1g',
  cpuLimit: 1,
  diskLimit: '2g',
  pidsLimit: 100,
  networkAccess: false,
  timeoutMs: 600_000,
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  limits: { ...DEFAULT_RESOURCE_LIMITS },
  image: {
    image: 'node:20-slim',
    label: 'Node.js 20 (slim)',
    runtimes: ['node'],
    installCommand: 'npm install',
    testCommand: 'npm test',
    shell: '/bin/bash',
  },
  workDir: '/workspace',
  containerUser: 'node',
  stopTimeoutMs: 10_000,
};

// ─── Sandbox Configuration Manager ──────────────────────────────────────────

let SANDBOX_CONFIG_PATH = '/tmp/buff-sandbox-config.json';

let cachedConfig: SandboxConfig | null = null;

/**
 * Get the current sandbox configuration.
 * Reads from ~/.buff/sandbox-config.json (if exists), falls back to defaults.
 */
export function getSandboxConfig(): SandboxConfig {
  if (cachedConfig) return { ...cachedConfig };

  try {
    // Lazy init path to avoid module-level side effects
    if (SANDBOX_CONFIG_PATH === '/tmp/buff-sandbox-config.json' && process.env.HOME) {
      SANDBOX_CONFIG_PATH = join(process.env.HOME, '.buff', 'sandbox-config.json');
    }
    if (existsSync(SANDBOX_CONFIG_PATH)) {
      const raw = readFileSync(SANDBOX_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SandboxConfig>;
      cachedConfig = {
        ...DEFAULT_SANDBOX_CONFIG,
        ...parsed,
        limits: { ...DEFAULT_RESOURCE_LIMITS, ...(parsed.limits || {}) },
        image: { ...DEFAULT_SANDBOX_CONFIG.image, ...(parsed.image || {}) },
      };
      return { ...cachedConfig };
    }
  } catch {
    // Fall through to default
  }

  return { ...DEFAULT_SANDBOX_CONFIG };
}

/**
 * Update the sandbox configuration and persist to disk.
 */
/**
 * Reset the sandbox config cache. Useful for testing.
 */
export function resetSandboxConfigCache(): void {
  cachedConfig = null;
}

/**
 * Update the sandbox configuration and persist to disk.
 */
export function setSandboxConfig(config: Partial<SandboxConfig>): SandboxConfig {
  const current = getSandboxConfig();
  const updated: SandboxConfig = {
    ...current,
    ...config,
    limits: { ...current.limits, ...(config.limits || {}) },
    image: { ...current.image, ...(config.image || {}) },
  };

  try {
    const dir = dirname(SANDBOX_CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SANDBOX_CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {
    // Non-critical: config stays in memory
  }

  cachedConfig = updated;
  return { ...updated };
}
