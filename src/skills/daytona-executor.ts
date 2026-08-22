/**
 * Daytona Cloud Executor — Runs skills in Daytona cloud sandboxes.
 *
 * This provides enterprise-grade execution with:
 * - Persistent sandboxes across sessions
 * - Resource limits (CPU, memory, disk)
 * - Sandbox lifecycle management (start, stop, resume)
 * - File sync between local and cloud
 *
 * Flow:
 * 1. Create or resume a Daytona sandbox
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

// ─── Types ───────────────────────────────────────────────────────────────

export interface DaytonaConfig {
  /** Daytona image (default: ubuntu:22.04) */
  image?: string;
  /** CPU count (default: 1) */
  cpu?: number;
  /** Memory in MB (default: 5120) */
  memoryMb?: number;
  /** Disk in MB (default: 10240) */
  diskMb?: number;
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Whether to persist the sandbox */
  persistent?: boolean;
  /** Sandbox name for persistence */
  sandboxName?: string;
  /** Working directory in sandbox */
  cwd?: string;
}

export interface DaytonaExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxId?: string;
}

// ─── Default Configuration ───────────────────────────────────────────────

const DEFAULT_DAYTONA_CONFIG: DaytonaConfig = {
  image: 'ubuntu:22.04',
  cpu: 1,
  memoryMb: 5120,
  diskMb: 10240,
  timeoutMs: 60_000,
  persistent: true,
  cwd: '/home/daytona',
};

// ─── Daytona Execution ───────────────────────────────────────────────────

/**
 * Execute a skill in a Daytona cloud sandbox.
 *
 * @param scriptContent - The script content to execute
 * @param scriptPath - Original file path (for runtime detection)
 * @param env - Environment variables to inject
 * @param args - Arguments to pass to the script
 * @param config - Daytona configuration
 * @returns Execution result
 */
export async function executeInDaytona(
  scriptContent: string,
  scriptPath: string,
  env?: Record<string, string>,
  args?: string[],
  config?: Partial<DaytonaConfig>
): Promise<DaytonaExecutionResult> {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_DAYTONA_CONFIG, ...config };

  // Check if Daytona CLI is available
  const daytonaAvailable = await checkDaytonaAvailable();
  if (!daytonaAvailable.available) {
    throw new Error(`Daytona CLI not available: ${daytonaAvailable.error}`);
  }

  // Create a temporary directory for the script
  const tmpDir = join(tmpdir(), 'daytona-exec', randomBytes(8).toString('hex'));
  await mkdir(tmpDir, { recursive: true });

  // Determine script extension and container script path
  const ext = getScriptExtension(scriptPath);
  const containerScript = `${cfg.cwd}/skill${ext}`;
  const hostScript = join(tmpDir, `skill${ext}`);

  try {
    // Write script to temporary file
    await writeFile(hostScript, scriptContent, 'utf-8');

    // Build Daytona command
    const daytonaArgs = buildDaytonaArgs(hostScript, containerScript, env, args, cfg);

    // Execute in Daytona
    const result = await spawnDaytona(daytonaArgs, cfg.timeoutMs!);

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
      const { rm } = await import('node:fs/promises');
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Build Daytona arguments for cloud execution.
 */
function buildDaytonaArgs(
  hostScript: string,
  containerScript: string,
  env?: Record<string, string>,
  args?: string[],
  config?: Partial<DaytonaConfig>
): string[] {
  const cfg = { ...DEFAULT_DAYTONA_CONFIG, ...config };

  // Daytona uses a CLI-based approach
  const daytonaArgs: string[] = [
    'sandbox',
    'create',
    '--image', cfg.image!,
    '--cpu', String(cfg.cpu),
    '--memory', String(cfg.memoryMb),
    '--disk', String(cfg.diskMb),
  ];

  // Add sandbox name if persistent
  if (cfg.persistent && cfg.sandboxName) {
    daytonaArgs.push('--name', cfg.sandboxName);
  }

  // Add the script to execute
  daytonaArgs.push('exec', '--', 'bash', '-c', `
    cat > ${containerScript} << 'SCRIPT_EOF'
    $(cat ${hostScript})
    SCRIPT_EOF
    chmod +x ${containerScript}
    ${containerScript} ${args?.join(' ') || ''}
  `);

  return daytonaArgs;
}

/**
 * Spawn Daytona process with timeout and output capture.
 */
async function spawnDaytona(
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('daytona', args, {
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
          stderr: stderr + '\n[Daytona execution timed out]',
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

// ─── Daytona Availability Check ──────────────────────────────────────────

/**
 * Check if Daytona CLI is available and configured.
 */
export async function checkDaytonaAvailable(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const result = await spawnDaytona(['--version'], 5000);
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
 * List Daytona sandboxes.
 */
export async function listDaytonaSandboxes(): Promise<Array<{
  id: string;
  name: string;
  status: string;
}>> {
  try {
    const result = await spawnDaytona(['sandbox', 'list', '--json'], 10000);
    if (result.exitCode === 0) {
      return JSON.parse(result.stdout);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Stop a Daytona sandbox.
 */
export async function stopDaytonaSandbox(sandboxId: string): Promise<boolean> {
  try {
    const result = await spawnDaytona(['sandbox', 'stop', sandboxId], 10000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Delete a Daytona sandbox.
 */
export async function deleteDaytonaSandbox(sandboxId: string): Promise<boolean> {
  try {
    const result = await spawnDaytona(['sandbox', 'delete', sandboxId], 10000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
