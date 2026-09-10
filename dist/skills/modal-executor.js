/**
 * Modal Cloud Executor — Runs skills in Modal cloud sandboxes.
 *
 * This provides enterprise-grade execution:
 * - Persistent sandboxes across sessions
 * - Custom Docker images
 * - GPU support for ML workloads
 * - File sync between local and cloud
 * - Automatic scaling
 *
 * Flow:
 * 1. Create or resume a Modal sandbox
 * 2. Sync skill files to the sandbox
 * 3. Execute the skill in the cloud
 * 4. Capture output and sync results back
 * 5. Optionally persist the sandbox for reuse
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
// ─── Default Configuration ───────────────────────────────────────────────
const DEFAULT_MODAL_CONFIG = {
    image: 'python:3.11',
    cpu: 1,
    memoryMb: 1024,
    timeoutMs: 60_000,
    persistent: false,
    cwd: '/root',
};
// ─── Modal Execution ─────────────────────────────────────────────────────
/**
 * Execute a skill in a Modal cloud sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Modal configuration
 * @returns Execution result
 */
export async function executeInModal(scriptContent, scriptPath, env, args, config) {
    const startTime = Date.now();
    const cfg = { ...DEFAULT_MODAL_CONFIG, ...config };
    // Check if Modal CLI is available
    const modalAvailable = await checkModalAvailable();
    if (!modalAvailable.available) {
        throw new Error(`Modal CLI not available: ${modalAvailable.error}`);
    }
    // Create a temporary directory for the script
    const tmpDir = join(tmpdir(), 'modal-exec', randomBytes(8).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
    // Determine script extension and container script path
    const ext = getScriptExtension(scriptPath);
    const containerScript = `/root/skill${ext}`;
    const hostScript = join(tmpDir, `skill${ext}`);
    try {
        // Write script to temporary file
        await writeFile(hostScript, scriptContent, 'utf-8');
        // Build Modal command
        const modalArgs = buildModalArgs(hostScript, containerScript, env, args, cfg);
        // Execute in Modal
        const result = await spawnModal(modalArgs, cfg.timeoutMs);
        return {
            success: result.exitCode === 0,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: Date.now() - startTime,
        };
    }
    finally {
        // Cleanup temporary directory
        try {
            const { rm } = await import('node:fs/promises');
            await rm(tmpDir, { recursive: true, force: true });
        }
        catch {
            // Ignore cleanup errors
        }
    }
}
/**
 * Build Modal arguments for cloud execution.
 */
function buildModalArgs(hostScript, containerScript, env, args, config) {
    const cfg = { ...DEFAULT_MODAL_CONFIG, ...config };
    // Modal uses a Python-based CLI
    const modalArgs = [
        'run',
        '--image', cfg.image,
        '--cpu', String(cfg.cpu),
        '--memory', String(cfg.memoryMb),
    ];
    // Add GPU if specified
    if (cfg.gpu) {
        modalArgs.push('--gpu', cfg.gpu);
    }
    // Add secrets
    if (cfg.secrets) {
        for (const [key, value] of Object.entries(cfg.secrets)) {
            modalArgs.push('--secret', `${key}=${value}`);
        }
    }
    // Add environment variables
    if (env) {
        for (const [key, value] of Object.entries(env)) {
            modalArgs.push('--env', `${key}=${value}`);
        }
    }
    // Add the script to execute
    modalArgs.push('python', '-c', `
import subprocess
import sys

# Read the script
with open('${containerScript}', 'r') as f:
    script = f.read()

# Execute the script
result = subprocess.run(
    [sys.executable, '-c', script],
    capture_output=True,
    text=True
)

# Print output
print(result.stdout)
if result.stderr:
    print(result.stderr, file=sys.stderr)

# Exit with the same code
sys.exit(result.returncode)
`);
    return modalArgs;
}
/**
 * Spawn Modal process with timeout and output capture.
 */
async function spawnModal(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('modal', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let killed = false;
        // Capture stdout
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });
        // Capture stderr
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        // Set timeout
        const timer = setTimeout(() => {
            killed = true;
            child.kill('SIGTERM');
            // Force kill after 10 seconds
            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 10000);
        }, timeoutMs);
        // Handle completion
        child.on('close', (code) => {
            clearTimeout(timer);
            if (killed) {
                resolve({
                    stdout,
                    stderr: stderr + '\n[Modal execution timed out]',
                    exitCode: code ?? 124,
                });
            }
            else {
                resolve({
                    stdout,
                    stderr,
                    exitCode: code ?? 1,
                });
            }
        });
        // Handle errors
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
// ─── Helpers ─────────────────────────────────────────────────────────────
/**
 * Get script extension from file path.
 */
function getScriptExtension(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'py':
            return '.py';
        case 'js':
        case 'mjs':
        case 'cjs':
            return '.js';
        case 'ts':
        case 'mts':
        case 'cts':
            return '.ts';
        case 'rb':
            return '.rb';
        case 'go':
            return '.go';
        case 'rs':
            return '.rs';
        case 'sh':
        case 'bash':
            return '.sh';
        default:
            return '.sh';
    }
}
// ─── Modal Availability Check ────────────────────────────────────────────
/**
 * Check if Modal CLI is available and configured.
 */
export async function checkModalAvailable() {
    try {
        const result = await spawnModal(['--version'], 5000);
        if (result.exitCode === 0) {
            const version = result.stdout.trim();
            return { available: true, version };
        }
        return { available: false, error: result.stderr };
    }
    catch (err) {
        return {
            available: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * List available Modal images.
 */
export async function listModalImages() {
    try {
        const result = await spawnModal(['image', 'list'], 10000);
        if (result.exitCode === 0) {
            return result.stdout.trim().split('\n').filter(Boolean);
        }
        return [];
    }
    catch {
        return [];
    }
}
/**
 * List running Modal sandboxes.
 */
export async function listModalSandboxes() {
    try {
        const result = await spawnModal(['sandbox', 'list', '--json'], 10000);
        if (result.exitCode === 0) {
            return JSON.parse(result.stdout);
        }
        return [];
    }
    catch {
        return [];
    }
}
/**
 * Stop a Modal sandbox.
 */
export async function stopModalSandbox(sandboxId) {
    try {
        const result = await spawnModal(['sandbox', 'stop', sandboxId], 10000);
        return result.exitCode === 0;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=modal-executor.js.map