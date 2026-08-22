/**
 * Docker Tool — Dedicated Docker management commands.
 *
 * Provides structured Docker operations:
 * - Container lifecycle (run, stop, start, restart, rm)
 * - Container interaction (exec, logs, inspect, stats)
 * - Image management (build, pull, push, tag, rmi)
 * - Docker Compose (up, down, ps, logs)
 * - Volume & network management
 * - Disk usage and cleanup
 * - Health monitoring
 *
 * Hermes equivalent: docker-management SKILL.md + hermes-s6-container-supervision
 */

import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface DockerCommandOptions {
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Working directory */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Capture stdout (default: true) */
  captureStdout?: boolean;
  /** Capture stderr (default: true) */
  captureStderr?: boolean;
}

export interface DockerCommandResult {
  /** Exit code */
  exitCode: number;
  /** stdout output */
  stdout: string;
  /** stderr output */
  stderr: string;
  /** Duration in ms */
  durationMs: number;
  /** Whether command succeeded */
  success: boolean;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
  size?: string;
}

export interface DockerImageInfo {
  repository: string;
  tag: string;
  id: string;
  size: string;
  created: string;
}

export interface DockerVolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  scope: string;
}

export interface DockerNetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  containers: Record<string, { name: string; ipv4Address: string }>;
}

export interface DockerDiskUsage {
  images: { count: number; reclaimable: string; totalSize: string };
  containers: { count: number; reclaimable: string; totalSize: string };
  volumes: { count: number; reclaimable: string; totalSize: string };
  buildCache: { count: number; reclaimable: string; totalSize: string };
}

// ─── Docker Tool ──────────────────────────────────────────────────────────

export class DockerTool {
  /**
   * Check if Docker is available.
   */
  async isAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const result = await this.run(['--version']);
      if (result.success) {
        const versionMatch = result.stdout.match(/Docker version (\S+)/);
        return { available: true, version: versionMatch?.[1] };
      }
      return { available: false, error: result.stderr };
    } catch (err) {
      return { available: false, error: String(err) };
    }
  }

  // ─── Container Lifecycle ─────────────────────────────────────────────

  /**
   * Run a container.
   */
  async runContainer(
    image: string,
    options: {
      name?: string;
      detach?: boolean;
      ports?: string[];
      volumes?: string[];
      env?: Record<string, string>;
      network?: string;
      command?: string[];
      remove?: boolean;
    } = {},
  ): Promise<DockerCommandResult> {
    const args = ['run'];
    if (options.detach) args.push('-d');
    if (options.name) args.push('--name', options.name);
    if (options.remove) args.push('--rm');
    if (options.network) args.push('--network', options.network);
    for (const port of options.ports || []) args.push('-p', port);
    for (const vol of options.volumes || []) args.push('-v', vol);
    for (const [k, v] of Object.entries(options.env || {})) args.push('-e', `${k}=${v}`);
    args.push(image);
    if (options.command) args.push(...options.command);
    return this.run(args);
  }

  /**
   * Stop a container.
   */
  async stopContainer(nameOrId: string, timeout?: number): Promise<DockerCommandResult> {
    const args = ['stop'];
    if (timeout) args.push('-t', String(timeout));
    args.push(nameOrId);
    return this.run(args);
  }

  /**
   * Start a stopped container.
   */
  async startContainer(nameOrId: string): Promise<DockerCommandResult> {
    return this.run(['start', nameOrId]);
  }

  /**
   * Restart a container.
   */
  async restartContainer(nameOrId: string, timeout?: number): Promise<DockerCommandResult> {
    const args = ['restart'];
    if (timeout) args.push('-t', String(timeout));
    args.push(nameOrId);
    return this.run(args);
  }

  /**
   * Remove a container.
   */
  async removeContainer(nameOrId: string, force?: boolean): Promise<DockerCommandResult> {
    const args = ['rm'];
    if (force) args.push('-f');
    args.push(nameOrId);
    return this.run(args);
  }

  /**
   * List containers.
   */
  async listContainers(all = false): Promise<DockerContainerInfo[]> {
    const args = ['ps', '--format', '{{json .}}'];
    if (all) args.push('-a');
    const result = await this.run(args);
    if (!result.success) return [];

    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return {
            id: obj.ID,
            name: obj.Names,
            image: obj.Image,
            status: obj.Status,
            state: obj.State,
            ports: obj.Ports,
            created: obj.CreatedAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as DockerContainerInfo[];
  }

  // ─── Container Interaction ───────────────────────────────────────────

  /**
   * Execute a command in a running container.
   */
  async exec(
    containerName: string,
    command: string[],
    options: { interactive?: boolean; tty?: boolean } = {},
  ): Promise<DockerCommandResult> {
    const args = ['exec'];
    if (options.interactive) args.push('-i');
    if (options.tty) args.push('-t');
    args.push(containerName, ...command);
    return this.run(args);
  }

  /**
   * Get container logs.
   */
  async logs(
    containerName: string,
    options: { follow?: boolean; tail?: number; since?: string } = {},
  ): Promise<DockerCommandResult> {
    const args = ['logs'];
    if (options.follow) args.push('-f');
    if (options.tail) args.push('--tail', String(options.tail));
    if (options.since) args.push('--since', options.since);
    args.push(containerName);
    return this.run(args);
  }

  /**
   * Inspect a container.
   */
  async inspectContainer(nameOrId: string): Promise<DockerCommandResult> {
    return this.run(['inspect', nameOrId]);
  }

  /**
   * Get container stats.
   */
  async stats(containerNames?: string[]): Promise<DockerCommandResult> {
    const args = ['stats', '--no-stream', '--format', '{{json .}}'];
    if (containerNames) args.push(...containerNames);
    return this.run(args);
  }

  /**
   * Copy files to/from a container.
   */
  async cp(
    containerName: string,
    src: string,
    dest: string,
  ): Promise<DockerCommandResult> {
    return this.run(['cp', `${containerName}:${src}`, dest]);
  }

  // ─── Image Management ────────────────────────────────────────────────

  /**
   * Build an image.
   */
  async buildImage(
    path: string,
    options: { tag?: string; file?: string; noCache?: boolean } = {},
  ): Promise<DockerCommandResult> {
    const args = ['build'];
    if (options.tag) args.push('-t', options.tag);
    if (options.file) args.push('-f', options.file);
    if (options.noCache) args.push('--no-cache');
    args.push(path);
    return this.run(args);
  }

  /**
   * Pull an image.
   */
  async pullImage(name: string): Promise<DockerCommandResult> {
    return this.run(['pull', name]);
  }

  /**
   * Push an image.
   */
  async pushImage(name: string): Promise<DockerCommandResult> {
    return this.run(['push', name]);
  }

  /**
   * List images.
   */
  async listImages(): Promise<DockerImageInfo[]> {
    const result = await this.run(['images', '--format', '{{json .}}']);
    if (!result.success) return [];

    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return {
            repository: obj.Repository,
            tag: obj.Tag,
            id: obj.ID,
            size: obj.Size,
            created: obj.CreatedAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as DockerImageInfo[];
  }

  /**
   * Remove an image.
   */
  async removeImage(nameOrId: string, force?: boolean): Promise<DockerCommandResult> {
    const args = ['rmi'];
    if (force) args.push('-f');
    args.push(nameOrId);
    return this.run(args);
  }

  // ─── Docker Compose ──────────────────────────────────────────────────

  /**
   * Run docker compose up.
   */
  async composeUp(
    projectDir: string,
    options: { detach?: boolean; build?: boolean; services?: string[] } = {},
  ): Promise<DockerCommandResult> {
    const args = ['compose'];
    args.push('up');
    if (options.detach) args.push('-d');
    if (options.build) args.push('--build');
    if (options.services) args.push(...options.services);
    return this.run(args, { cwd: projectDir });
  }

  /**
   * Run docker compose down.
   */
  async composeDown(
    projectDir: string,
    options: { volumes?: boolean; removeOrphans?: boolean } = {},
  ): Promise<DockerCommandResult> {
    const args = ['compose', 'down'];
    if (options.volumes) args.push('-v');
    if (options.removeOrphans) args.push('--remove-orphans');
    return this.run(args, { cwd: projectDir });
  }

  /**
   * Get docker compose status.
   */
  async composePs(projectDir: string): Promise<DockerCommandResult> {
    return this.run(['compose', 'ps', '--format', '{{json .}}'], { cwd: projectDir });
  }

  // ─── Volumes & Networks ──────────────────────────────────────────────

  /**
   * List volumes.
   */
  async listVolumes(): Promise<DockerVolumeInfo[]> {
    const result = await this.run(['volume', 'ls', '--format', '{{json .}}']);
    if (!result.success) return [];

    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return {
            name: obj.Name,
            driver: obj.Driver,
            mountpoint: obj.Mountpoint,
            labels: obj.Labels || {},
            scope: obj.Scope,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as DockerVolumeInfo[];
  }

  /**
   * List networks.
   */
  async listNetworks(): Promise<DockerNetworkInfo[]> {
    const result = await this.run(['network', 'ls', '--format', '{{json .}}']);
    if (!result.success) return [];

    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return {
            id: obj.ID,
            name: obj.Name,
            driver: obj.Driver,
            scope: obj.Scope,
            containers: {},
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as DockerNetworkInfo[];
  }

  // ─── Disk Usage & Cleanup ────────────────────────────────────────────

  /**
   * Get Docker disk usage.
   */
  async diskUsage(): Promise<DockerDiskUsage | null> {
    const result = await this.run(['system', 'df', '--format', '{{json .}}']);
    if (!result.success) return null;

    const lines = result.stdout.split('\n').filter((l) => l.trim());
    const usage: DockerDiskUsage = {
      images: { count: 0, reclaimable: '0B', totalSize: '0B' },
      containers: { count: 0, reclaimable: '0B', totalSize: '0B' },
      volumes: { count: 0, reclaimable: '0B', totalSize: '0B' },
      buildCache: { count: 0, reclaimable: '0B', totalSize: '0B' },
    };

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.Type?.toLowerCase();
        if (type === 'Images') usage.images = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
        if (type === 'Containers') usage.containers = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
        if (type === 'Local Volumes') usage.volumes = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
        if (type === 'Build Cache') usage.buildCache = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
      } catch { /* ignore */ }
    }

    return usage;
  }

  /**
   * Cleanup Docker resources.
   */
  async cleanup(options: {
    danglingImages?: boolean;
    stoppedContainers?: boolean;
    unusedVolumes?: boolean;
    buildCache?: boolean;
    all?: boolean;
  } = {}): Promise<DockerCommandResult> {
    if (options.all) {
      return this.run(['system', 'prune', '-af', '--volumes']);
    }

    const results: DockerCommandResult[] = [];
    if (options.danglingImages) results.push(await this.run(['image', 'prune', '-f']));
    if (options.stoppedContainers) results.push(await this.run(['container', 'prune', '-f']));
    if (options.unusedVolumes) results.push(await this.run(['volume', 'prune', '-f']));
    if (options.buildCache) results.push(await this.run(['builder', 'prune', '-f']));

    const allSuccess = results.every((r) => r.success);
    return {
      exitCode: allSuccess ? 0 : 1,
      stdout: results.map((r) => r.stdout).join('\n'),
      stderr: results.map((r) => r.stderr).filter(Boolean).join('\n'),
      durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      success: allSuccess,
    };
  }

  // ─── Health Monitoring ───────────────────────────────────────────────

  /**
   * Check container health.
   */
  async checkContainerHealth(containerName: string): Promise<{
    healthy: boolean;
    state: string;
    healthStatus?: string;
    restartCount: number;
  } | null> {
    const result = await this.inspectContainer(containerName);
    if (!result.success) return null;

    try {
      const inspect = JSON.parse(result.stdout);
      const state = inspect[0]?.State || {};
      const health = state.Health || {};

      return {
        healthy: state.Running && (!health.Status || health.Status === 'healthy'),
        state: state.Status || 'unknown',
        healthStatus: health.Status,
        restartCount: state.RestartCount || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Monitor a container with periodic health checks.
   */
  async monitorContainer(
    containerName: string,
    intervalMs: number,
    callback: (health: { healthy: boolean; state: string; healthStatus?: string; restartCount: number }) => void,
  ): Promise<() => void> {
    const timer = setInterval(async () => {
      const health = await this.checkContainerHealth(containerName);
      if (health) callback(health);
    }, intervalMs);

    return () => clearInterval(timer);
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async run(
    args: string[],
    options: DockerCommandOptions = {},
  ): Promise<DockerCommandResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 30_000;

    return new Promise((resolve) => {
      const proc = spawn('docker', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        if (options.captureStdout !== false) stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        if (options.captureStderr !== false) stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
          success: code === 0 && !killed,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: String(err),
          durationMs: Date.now() - startTime,
          success: false,
        });
      });
    });
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: DockerTool | null = null;

export function getDockerTool(): DockerTool {
  if (!_instance) _instance = new DockerTool();
  return _instance;
}

export function resetDockerTool(): void {
  _instance = null;
}
