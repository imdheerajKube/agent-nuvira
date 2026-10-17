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

import { spawn, spawnSync } from 'node:child_process';
import { writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Where the host script is written before it is mounted into the container.
 *
 * NOT the OS temp dir, which is what this used and why every sandboxed run failed
 * on macOS: `os.tmpdir()` is under /var/folders (or /tmp, a symlink to /private/tmp),
 * and neither is shared with the Docker VM by default — colima shares $HOME, Docker
 * Desktop shares $HOME. A bind mount from an unshared host path does not error: the
 * daemon silently creates an EMPTY DIRECTORY at the target, and the container then
 * fails with `/tmp/skill.sh: Is a directory` (measured: Docker 29.7.2 on aarch64
 * with colima). $HOME is the one location every macOS Docker backend shares.
 *
 * NUVIRA_SANDBOX_DIR overrides it for a machine with a different shared root.
 */
function sandboxHostDir(): string {
  const override = process.env.NUVIRA_SANDBOX_DIR;
  return override && override.trim() ? override.trim() : join(homedir(), '.nuvira', 'sandbox');
}

/**
 * The path INSIDE the container the script is mounted at.
 *
 * Deliberately not under /tmp: the container mounts a tmpfs there, and a bind mount
 * whose target lives inside another mount point is replaced by a directory — the same
 * "Is a directory" failure from the other direction. `/` is the root filesystem, which
 * every image has.
 */
function containerScriptPath(ext: string): string {
  return `/skill${ext}`;
}

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

/**
 * The image a runtime needs, when the caller does not name one.
 *
 * The default image is `node:20-slim`, which has NO python3: a `.py` skill in the
 * sandbox exited 127 with "python3: not found" whatever its code said, because the
 * container was chosen for a runtime it does not contain. `getRuntimeCommand` runs
 * python3 for a `.py` file, so the image has to follow the file.
 */
const RUNTIME_IMAGES: Record<string, string> = {
  python: 'python:3.12-slim',
  node: 'node:20-slim',
  shell: 'node:20-slim',
};

function defaultImageFor(runtime: string): string {
  return RUNTIME_IMAGES[runtime] ?? 'node:20-slim';
}

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

  // The extension decides the RUNTIME, and the runtime decides the image (unless the
  // caller named one), because the default image cannot run every runtime.
  const ext = getScriptExtension(scriptPath);
  const runtime = getRuntimeFromPath(`skill${ext}`);
  const containerScript = containerScriptPath(ext);
  const cfg: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...config,
    image: config?.image ?? defaultImageFor(runtime),
  };

  // Create temporary directory for the sandbox
  const tmpDir = join(sandboxHostDir(), 'sandbox-exec', randomBytes(8).toString('hex'));
  await mkdir(tmpDir, { recursive: true });
  // The REAL path, because a shared root may itself be a symlink (/tmp → /private/tmp)
  // and the Docker VM resolves the path it is given, not the one this process used.
  const sharedDir = await realpath(tmpDir).catch(() => tmpDir);
  const hostScript = join(sharedDir, `skill${ext}`);

  // Named so a timeout can kill the CONTAINER: the docker CLI is a separate process,
  // and killing it leaves the script running inside the VM.
  const containerName = `nuvira-sandbox-${randomBytes(6).toString('hex')}`;

  try {
    // Write script to temporary file
    await writeFile(hostScript, scriptContent, 'utf-8');

    // Build Docker command
    const dockerArgs = buildDockerArgs(hostScript, containerScript, env, args, cfg, containerName);

    // Execute in Docker
    const result = await spawnDocker(dockerArgs, cfg.timeoutMs!, containerName);

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
  config?: Partial<SandboxConfig>,
  name?: string
): string[] {
  const cfg = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  const dockerArgs: string[] = [
    'run',
    '--rm',                          // Auto-remove container after execution
    ...(name ? ['--name', name] : []), // So a timeout can kill THIS container
    '--interactive',                 // Keep stdin open
    `--memory=${cfg.memoryLimitMb}m`, // Memory limit
    `--cpus=${cfg.cpuLimit}`,        // CPU limit
    `--network=${cfg.networkMode}`,  // Network mode
    `--read-only`,                   // Read-only root filesystem
    `--tmpfs=/tmp:size=${cfg.diskLimitMb}m`, // Writable /tmp
    // `--no-new-privileges` is NOT a Docker flag: the only way to ask for it is
    // through `--security-opt`, and a current CLI (29.x) refuses the bare flag with
    // "unknown flag" and exit 125, which failed EVERY sandboxed execution — the
    // stream test asked for this and got "unknown flag: --no-new-privileges" instead
    // of its script's output. `sandbox/manager.ts` already used the correct form.
    `--security-opt=no-new-privileges:true`, // Prevent privilege escalation
  ];

  // ONE FLAG PER CAPABILITY. Docker's `--cap-add` takes a single capability, so a
  // comma-joined list is read as one name and rejected: `--cap-add=SETUID,SETGID`
  // comes back as `invalid CapAdd: unknown capability: "CAP_SETUID,SETGID"` and the
  // container never starts (exit 125). The default config sets capAdd to
  // ['SETUID','SETGID'], so this failed EVERY sandboxed execution — measured with
  // Docker 29.7.2 on aarch64. Only non-empty lists are pushed, because `--cap-add=``
  // is likewise an invalid capability named "CAP_".
  for (const cap of cfg.capDrop ?? []) dockerArgs.push(`--cap-drop=${cap}`);
  for (const cap of cfg.capAdd ?? []) dockerArgs.push(`--cap-add=${cap}`);

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
  timeoutMs: number,
  containerName?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const finish = (payload: { stdout: string; stderr: string; exitCode: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

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
      // Kill the CONTAINER first. SIGTERM to the docker CLI only asks it to stop the
      // container, which it waits for: with `sleep 10` inside, 'close' arrived when
      // the SCRIPT finished, so a 1s timeout took 10s and the caller's 10s budget
      // expired — the timeout never actually timed anything out.
      if (containerName) {
        try {
          spawnSync('docker', ['kill', '--signal=SIGKILL', containerName], { stdio: 'ignore' });
        } catch {
          /* best-effort: the container may have exited on its own */
        }
      }
      child.kill('SIGKILL');
      // 124 is the `timeout(1)` convention the caller expects, rather than the
      // signal-derived code (137/143) the client happens to report.
      finish({ stdout, stderr: stderr + '\n[Sandbox execution timed out]', exitCode: 124 });
    }, timeoutMs);

    // Handle completion
    child.on('close', (code) => {
      if (killed) {
        finish({ stdout, stderr: stderr + '\n[Sandbox execution timed out]', exitCode: 124 });
      } else {
        finish({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    // Handle errors
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
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
 * Check if Docker is available and RUNNING.
 *
 * `docker --version` only proves the CLI is installed — it succeeds with the
 * daemon stopped, and every subsequent `docker run` then dies with exit code
 * 125 ("Cannot connect to the Docker daemon"). Callers trust this answer to
 * decide between the sandbox and a local fallback, so a CLI-only probe made a
 * machine with Docker installed-but-not-running take the sandbox path, fail on
 * every skill, and never fall back.
 *
 * So probe the DAEMON (`docker info`) and keep `--version` only to report the
 * version string. A stopped daemon now reports `available: false` with the
 * daemon's own error, which is exactly what enables the local fallback.
 */
export async function checkDockerAvailable(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  try {
    // 1. Is the CLI here at all? (cheap; gives us the version string)
    const versionResult = await spawnDocker(['--version'], 5000);
    if (versionResult.exitCode !== 0) {
      return { available: false, error: versionResult.stderr.trim() || 'docker CLI not available' };
    }
    const version = versionResult.stdout.trim();

    // 2. Is the DAEMON actually reachable? `docker info` fails (non-zero) when
    //    it is not, which is the distinction that matters to callers.
    const infoResult = await spawnDocker(['info'], 5000);
    if (infoResult.exitCode !== 0) {
      return {
        available: false,
        version,
        error: infoResult.stderr.trim() || 'Docker daemon is not running',
      };
    }

    return { available: true, version };
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
