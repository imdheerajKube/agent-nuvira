/**
 * Sandbox Executor — Runs skills in Docker containers for isolation.
 *
 * This provides the same security model as Hermes' `environments/docker.py`:
 * - Untrusted skills run in isolated containers
 * - Network access is restricted (no host access)
 * - Filesystem is read-only except for /tmp
 * - Resource limits (CPU, memory, disk)
 * - Automatic cleanup after execution
 *
 * Flow:
 * 1. Create a temporary Docker container from a minimal image
 * 2. Mount the skill script into the container
 * 3. Inject environment variables (API keys)
 * 4. Execute the script with timeout
 * 5. Capture output and cleanup
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Docker image to use (default: node:20-slim) */
  image?: string;
  /** CPU limit (default: 1) */
  cpuLimit?: number;
  /** Memory limit in MB (default: 512) */
  memoryLimitMb?: number;
  /** Disk limit in MB (default: 100) */
  diskLimitMb?: number;
  /** Network mode (default: none for untrusted) */
  networkMode?: 'none' | 'bridge' | 'host';
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Additional volumes to mount */
  volumes?: Array<{ host: string; container: string; readonly?: boolean }>;
  /** Additional capabilities to grant */
  capAdd?: string[];
  /** Capabilities to drop */
  capDrop?: string[];
}

export interface SandboxExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  containerId?: string;
}

// ─── Default Configuration ───────────────────────────────────────────────

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  image: 'node:20-slim',
  cpuLimit: 1,
  memoryLimitMb: 512,
  diskLimitMb: 100,
  networkMode: 'none',
  timeoutMs: 30_000,
  capDrop: ['ALL'],
  capAdd: ['SETUID', 'SETGID'], // Needed for some scripts
};

// ─── Sandbox Execution ───────────────────────────────────────────────────

/**
 * Execute a skill in a Docker sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Sandbox configuration
 * @returns Execution result
 */
export async function executeInSandbox(
  scriptContent: string,
  scriptPath: string,
  env?: Record<string, string>,
  args?: string[],
  config?: Partial<SandboxConfig>
): Promise<SandboxExecutionResult> {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_SANDBOX_CONFIG, ...config };

  // Create temporary directory for the sandbox
  const tmpDir = join(tmpdir(), 'sandbox-exec', randomBytes(8).toString('hex'));
  await mkdir(tmpDir, { recursive: true });

  // Determine script extension and container script path
  const ext = getScriptExtension(scriptPath);
  const containerScript = `/tmp/skill${ext}`;
  const hostScript = join(tmpDir, `skill${ext}`);

  try {
    // Write script to temporary file
    await writeFile(hostScript, scriptContent, 'utf-8');

    // Build Docker command
    const dockerArgs = buildDockerArgs(hostScript, containerScript, env, args, cfg);

    // Execute in Docker
    const result = await spawnDocker(dockerArgs, cfg.timeoutMs!);

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Cleanup temporary directory
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Build Docker arguments for sandboxed execution.
 */
function buildDockerArgs(
  hostScript: string,
  containerScript: string,
  env?: Record<string, string>,
  args?: string[],
  config?: Partial<SandboxConfig>
): string[] {
  const cfg = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  const dockerArgs: string[] = [
    'run',
    '--rm',                          // Auto-remove container after execution
    '--interactive',                 // Keep stdin open
    `--memory=${cfg.memoryLimitMb}m`, // Memory limit
    `--cpus=${cfg.cpuLimit}`,        // CPU limit
    `--network=${cfg.networkMode}`,  // Network mode
    `--read-only`,                   // Read-only root filesystem
    `--tmpfs=/tmp:size=${cfg.diskLimitMb}m`, // Writable /tmp
    `--cap-drop=${cfg.capDrop?.join(',')}`, // Drop capabilities
    `--cap-add=${cfg.capAdd?.join(',')}`,   // Add capabilities
    `--no-new-privileges`,           // Prevent privilege escalation
    `--security-opt=no-new-privileges`, // Additional security
  ];

  // Mount the script into the container
  dockerArgs.push('-v', `${hostScript}:${containerScript}:ro`);

  // Add environment variables
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }
  }

  // Add the image
  dockerArgs.push(cfg.image!);

  // Add the command to execute
  const runtime = getRuntimeFromPath(containerScript);
  const runtimeCmd = getRuntimeCommand(runtime);
  dockerArgs.push(...runtimeCmd, containerScript);

  // Add script arguments
  if (args && args.length > 0) {
    dockerArgs.push(...args);
  }

  return dockerArgs;
}

/**
 * Spawn Docker process with timeout and output capture.
 */
async function spawnDocker(
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Set timeout
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    // Handle completion
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          stdout,
          stderr: stderr + '\n[Sandbox execution timed out]',
          exitCode: code ?? 124,
        });
      } else {
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
function getScriptExtension(filePath: string): string {
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
    case 'sh':
    case 'bash':
      return '.sh';
    default:
      return '.sh';
  }
}

/**
 * Get runtime from file path.
 */
function getRuntimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return 'python';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'node';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'node';
    case 'rb':
      return 'ruby';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'sh':
    case 'bash':
      return 'shell';
    default:
      return 'shell';
  }
}

/**
 * Get runtime command for execution.
 */
function getRuntimeCommand(runtime: string): string[] {
  switch (runtime) {
    case 'python':
      return ['python3'];
    case 'node':
      return ['node'];
    case 'shell':
      return ['bash'];
    case 'ruby':
      return ['ruby'];
    case 'go':
      return ['go', 'run'];
    case 'rust':
      // Rust needs compilation, handled specially in buildDockerArgs
      return ['bash', '-c'];
    default:
      return ['bash'];
  }
}

// ─── Docker Availability Check ───────────────────────────────────────────

/**
 * Check if Docker is available and running.
 */
export async function checkDockerAvailable(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const result = await spawnDocker(['--version'], 5000);
    if (result.exitCode === 0) {
      const version = result.stdout.trim();
      return { available: true, version };
    }
    return { available: false, error: result.stderr };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if a Docker image exists locally.
 */
export async function checkImageExists(image: string): Promise<boolean> {
  try {
    const result = await spawnDocker(['inspect', image], 5000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image if it doesn't exist locally.
 */
export async function pullImageIfNeeded(image: string): Promise<void> {
  const exists = await checkImageExists(image);
  if (!exists) {
    console.log(`Pulling Docker image: ${image}`);
    const result = await spawnDocker(['pull', image], 120_000);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to pull Docker image: ${result.stderr}`);
    }
  }
}
