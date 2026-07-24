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
// ─── Defaults ───────────────────────────────────────────────────────────────
export const DEFAULT_RESOURCE_LIMITS = {
    memoryLimit: '1g',
    cpuLimit: 1,
    diskLimit: '2g',
    pidsLimit: 100,
    networkAccess: false,
    timeoutMs: 600_000,
};
export const DEFAULT_SANDBOX_CONFIG = {
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
let cachedConfig = null;
/**
 * Get the current sandbox configuration.
 * Reads from ~/.buff/sandbox-config.json (if exists), falls back to defaults.
 */
export function getSandboxConfig() {
    if (cachedConfig)
        return { ...cachedConfig };
    try {
        // Lazy init path to avoid module-level side effects
        if (SANDBOX_CONFIG_PATH === '/tmp/buff-sandbox-config.json' && process.env.HOME) {
            SANDBOX_CONFIG_PATH = join(process.env.HOME, '.buff', 'sandbox-config.json');
        }
        if (existsSync(SANDBOX_CONFIG_PATH)) {
            const raw = readFileSync(SANDBOX_CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            cachedConfig = {
                ...DEFAULT_SANDBOX_CONFIG,
                ...parsed,
                limits: { ...DEFAULT_RESOURCE_LIMITS, ...(parsed.limits || {}) },
                image: { ...DEFAULT_SANDBOX_CONFIG.image, ...(parsed.image || {}) },
            };
            return { ...cachedConfig };
        }
    }
    catch {
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
export function resetSandboxConfigCache() {
    cachedConfig = null;
}
/**
 * Update the sandbox configuration and persist to disk.
 */
export function setSandboxConfig(config) {
    const current = getSandboxConfig();
    const updated = {
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
    }
    catch {
        // Non-critical: config stays in memory
    }
    cachedConfig = updated;
    return { ...updated };
}
//# sourceMappingURL=types.js.map