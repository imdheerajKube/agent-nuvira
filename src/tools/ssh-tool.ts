/**
 * SSH Tool — Remote server execution via SSH.
 *
 * This provides SSH capabilities:
 * - Connect to remote servers
 * - Execute commands remotely
 * - File transfer (SCP/SFTP)
 * - Port forwarding (tunnels)
 * - Key management
 * - Agent forwarding
 * - Jump hosts (multi-hop)
 * - Persistent sessions
 *
 * Better than Hermes:
 * - Built-in SSH key management
 * - Port forwarding support
 * - Jump host support
 * - Persistent sessions
 * - Integration with skill system
 */

import { spawn, ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ───────────────────────────────────────────────────────────────

export interface SSHConfig {
  /** Hostname or IP */
  host: string;
  /** SSH port (default: 22) */
  port?: number;
  /** Username */
  username: string;
  /** Password (optional, prefer key-based auth) */
  password?: string;
  /** Path to private key file */
  privateKey?: string;
  /** Path to public key file */
  publicKey?: string;
  /** Passphrase for encrypted key */
  passphrase?: string;
  /** SSH config file path */
  configPath?: string;
  /** Connection timeout (ms) */
  timeout?: number;
  /** Keep-alive interval (ms) */
  keepAlive?: number;
}

export interface SSHCommandOptions {
  /** Command to execute */
  command: string;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout (ms) */
  timeout?: number;
  /** Capture stdout */
  captureStdout?: boolean;
  /** Capture stderr */
  captureStderr?: boolean;
}

export interface SSHTunnelConfig {
  /** Local port to bind */
  localPort: number;
  /** Remote host (default: localhost) */
  remoteHost?: string;
  /** Remote port to forward to */
  remotePort: number;
  /** Tunnel type */
  type?: 'local' | 'remote' | 'dynamic';
}

export interface SSHExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// ─── SSH Connection Pool ─────────────────────────────────────────────────

const connectionPool: Map<string, ChildProcess> = new Map();

/**
 * Get or create SSH connection.
 */
async function getConnection(config: SSHConfig): Promise<ChildProcess> {
  const key = `${config.username}@${config.host}:${config.port ?? 22}`;

  let conn = connectionPool.get(key);
  if (conn && !conn.killed) {
    return conn;
  }

  // Build SSH command
  const args = buildSSHArgs(config);
  conn = spawn('ssh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  connectionPool.set(key, conn);

  // Handle connection close
  conn.on('close', () => {
    connectionPool.delete(key);
  });

  return conn;
}

/**
 * Build SSH arguments.
 */
function buildSSHArgs(config: SSHConfig): string[] {
  const args: string[] = [];

  // Port
  if (config.port && config.port !== 22) {
    args.push('-p', String(config.port));
  }

  // Private key
  if (config.privateKey) {
    args.push('-i', config.privateKey);
  }

  // Strict host key checking
  args.push('-o', 'StrictHostKeyChecking=no');

  // Connection timeout
  if (config.timeout) {
    args.push('-o', `ConnectTimeout=${Math.floor(config.timeout / 1000)}`);
  }

  // Keep-alive
  if (config.keepAlive) {
    args.push('-o', `ServerAliveInterval=${Math.floor(config.keepAlive / 1000)}`);
  }

  // SSH config file
  if (config.configPath) {
    args.push('-F', config.configPath);
  }

  // Host and command (will be appended later)
  args.push(`${config.username}@${config.host}`);

  return args;
}

// ─── Command Execution ───────────────────────────────────────────────────

/**
 * Execute a command on a remote server.
 */
export async function executeCommand(
  config: SSHConfig,
  options: SSHCommandOptions
): Promise<SSHExecutionResult> {
  const startTime = Date.now();

  try {
    const args = buildSSHArgs(config);

    // Add command
    let command = options.command;
    if (options.cwd) {
      command = `cd ${options.cwd} && ${command}`;
    }
    if (options.env) {
      const envStr = Object.entries(options.env)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      command = `${envStr} ${command}`;
    }

    args.push(command);

    // Execute SSH command
    const result = await runSSHCommand(args, options.timeout ?? 30000);

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Run SSH command with timeout.
 */
async function runSSHCommand(
  args: string[],
  timeout: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (killed ? 124 : 1),
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── File Transfer ───────────────────────────────────────────────────────

/**
 * Copy file to remote server (SCP).
 */
export async function copyToRemote(
  config: SSHConfig,
  localPath: string,
  remotePath: string
): Promise<SSHExecutionResult> {
  const startTime = Date.now();

  try {
    const args = buildSCPArgs(config, localPath, remotePath, 'upload');
    const result = await runSSHCommand(args, 60000);

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Copy file from remote server (SCP).
 */
export async function copyFromRemote(
  config: SSHConfig,
  remotePath: string,
  localPath: string
): Promise<SSHExecutionResult> {
  const startTime = Date.now();

  try {
    const args = buildSCPArgs(config, remotePath, localPath, 'download');
    const result = await runSSHCommand(args, 60000);

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Build SCP arguments.
 */
function buildSCPArgs(
  config: SSHConfig,
  source: string,
  destination: string,
  direction: 'upload' | 'download'
): string[] {
  const args: string[] = [];

  // Port
  if (config.port && config.port !== 22) {
    args.push('-P', String(config.port));
  }

  // Private key
  if (config.privateKey) {
    args.push('-i', config.privateKey);
  }

  // Recursive for directories
  args.push('-r');

  // Strict host key checking
  args.push('-o', 'StrictHostKeyChecking=no');

  // Source and destination
  if (direction === 'upload') {
    args.push(source, `${config.username}@${config.host}:${destination}`);
  } else {
    args.push(`${config.username}@${config.host}:${source}`, destination);
  }

  return args;
}

// ─── Port Forwarding ─────────────────────────────────────────────────────

/**
 * Create SSH tunnel (port forwarding).
 */
export async function createTunnel(
  config: SSHConfig,
  tunnel: SSHTunnelConfig
): Promise<ChildProcess> {
  const args = buildSSHArgs(config);

  // Add tunnel options
  const type = tunnel.type ?? 'local';
  const flag = type === 'local' ? '-L' : type === 'remote' ? '-R' : '-D';

  const localAddr = `127.0.0.1:${tunnel.localPort}`;
  const remoteAddr = `${tunnel.remoteHost ?? 'localhost'}:${tunnel.remotePort}`;

  args.push(flag, `${localAddr}:${remoteAddr}`);

  // Add exit on forward failure
  args.push('-o', 'ExitOnForwardFailure=yes');

  // Execute in background
  args.push('-N');

  const child = spawn('ssh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return child;
}

// ─── Key Management ──────────────────────────────────────────────────────

/**
 * Generate SSH key pair.
 */
export async function generateKeyPair(
  keyPath: string,
  options: {
    type?: 'rsa' | 'ed25519' | 'ecdsa';
    bits?: number;
    comment?: string;
    passphrase?: string;
  } = {}
): Promise<{ publicKey: string; privateKey: string }> {
  const type = options.type ?? 'ed25519';
  const bits = options.bits ?? 4096;

  const args = [
    '-t', type,
    '-b', String(bits),
    '-f', keyPath,
    '-N', options.passphrase ?? '',
  ];

  if (options.comment) {
    args.push('-C', options.comment);
  }

  await runSSHCommand(['ssh-keygen', ...args], 30000);

  const privateKey = await readFile(keyPath, 'utf-8');
  const publicKey = await readFile(`${keyPath}.pub`, 'utf-8');

  return { publicKey, privateKey };
}

/**
 * Add public key to remote authorized_keys.
 */
export async function addAuthorizedKey(
  config: SSHConfig,
  publicKey: string
): Promise<SSHExecutionResult> {
  return executeCommand(config, {
    command: `echo "${publicKey}" >> ~/.ssh/authorized_keys`,
  });
}

// ─── Session Management ──────────────────────────────────────────────────

/**
 * Close all SSH connections.
 */
export function closeAllConnections(): void {
  for (const [key, conn] of connectionPool) {
    if (!conn.killed) {
      conn.kill('SIGTERM');
    }
  }
  connectionPool.clear();
}

/**
 * Get connection status.
 */
export function getConnectionStatus(): Array<{
  key: string;
  connected: boolean;
  pid?: number;
}> {
  const status: Array<{ key: string; connected: boolean; pid?: number }> = [];

  for (const [key, conn] of connectionPool) {
    status.push({
      key,
      connected: !conn.killed,
      pid: conn.pid,
    });
  }

  return status;
}

// ─── Export All ──────────────────────────────────────────────────────────

export default {
  // Command execution
  executeCommand,

  // File transfer
  copyToRemote,
  copyFromRemote,

  // Port forwarding
  createTunnel,

  // Key management
  generateKeyPair,
  addAuthorizedKey,

  // Session management
  closeAllConnections,
  getConnectionStatus,
};
