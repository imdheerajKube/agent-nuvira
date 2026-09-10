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
// ─── Docker Tool ──────────────────────────────────────────────────────────
export class DockerTool {
    /**
     * Check if Docker is available.
     */
    async isAvailable() {
        try {
            const result = await this.run(['--version']);
            if (result.success) {
                const versionMatch = result.stdout.match(/Docker version (\S+)/);
                return { available: true, version: versionMatch?.[1] };
            }
            return { available: false, error: result.stderr };
        }
        catch (err) {
            return { available: false, error: String(err) };
        }
    }
    // ─── Container Lifecycle ─────────────────────────────────────────────
    /**
     * Run a container.
     */
    async runContainer(image, options = {}) {
        const args = ['run'];
        if (options.detach)
            args.push('-d');
        if (options.name)
            args.push('--name', options.name);
        if (options.remove)
            args.push('--rm');
        if (options.network)
            args.push('--network', options.network);
        for (const port of options.ports || [])
            args.push('-p', port);
        for (const vol of options.volumes || [])
            args.push('-v', vol);
        for (const [k, v] of Object.entries(options.env || {}))
            args.push('-e', `${k}=${v}`);
        args.push(image);
        if (options.command)
            args.push(...options.command);
        return this.run(args);
    }
    /**
     * Stop a container.
     */
    async stopContainer(nameOrId, timeout) {
        const args = ['stop'];
        if (timeout)
            args.push('-t', String(timeout));
        args.push(nameOrId);
        return this.run(args);
    }
    /**
     * Start a stopped container.
     */
    async startContainer(nameOrId) {
        return this.run(['start', nameOrId]);
    }
    /**
     * Restart a container.
     */
    async restartContainer(nameOrId, timeout) {
        const args = ['restart'];
        if (timeout)
            args.push('-t', String(timeout));
        args.push(nameOrId);
        return this.run(args);
    }
    /**
     * Remove a container.
     */
    async removeContainer(nameOrId, force) {
        const args = ['rm'];
        if (force)
            args.push('-f');
        args.push(nameOrId);
        return this.run(args);
    }
    /**
     * List containers.
     */
    async listContainers(all = false) {
        const args = ['ps', '--format', '{{json .}}'];
        if (all)
            args.push('-a');
        const result = await this.run(args);
        if (!result.success)
            return [];
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
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    // ─── Container Interaction ───────────────────────────────────────────
    /**
     * Execute a command in a running container.
     */
    async exec(containerName, command, options = {}) {
        const args = ['exec'];
        if (options.interactive)
            args.push('-i');
        if (options.tty)
            args.push('-t');
        args.push(containerName, ...command);
        return this.run(args);
    }
    /**
     * Get container logs.
     */
    async logs(containerName, options = {}) {
        const args = ['logs'];
        if (options.follow)
            args.push('-f');
        if (options.tail)
            args.push('--tail', String(options.tail));
        if (options.since)
            args.push('--since', options.since);
        args.push(containerName);
        return this.run(args);
    }
    /**
     * Inspect a container.
     */
    async inspectContainer(nameOrId) {
        return this.run(['inspect', nameOrId]);
    }
    /**
     * Get container stats.
     */
    async stats(containerNames) {
        const args = ['stats', '--no-stream', '--format', '{{json .}}'];
        if (containerNames)
            args.push(...containerNames);
        return this.run(args);
    }
    /**
     * Copy files to/from a container.
     */
    async cp(containerName, src, dest) {
        return this.run(['cp', `${containerName}:${src}`, dest]);
    }
    // ─── Image Management ────────────────────────────────────────────────
    /**
     * Build an image.
     */
    async buildImage(path, options = {}) {
        const args = ['build'];
        if (options.tag)
            args.push('-t', options.tag);
        if (options.file)
            args.push('-f', options.file);
        if (options.noCache)
            args.push('--no-cache');
        args.push(path);
        return this.run(args);
    }
    /**
     * Pull an image.
     */
    async pullImage(name) {
        return this.run(['pull', name]);
    }
    /**
     * Push an image.
     */
    async pushImage(name) {
        return this.run(['push', name]);
    }
    /**
     * List images.
     */
    async listImages() {
        const result = await this.run(['images', '--format', '{{json .}}']);
        if (!result.success)
            return [];
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
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    /**
     * Remove an image.
     */
    async removeImage(nameOrId, force) {
        const args = ['rmi'];
        if (force)
            args.push('-f');
        args.push(nameOrId);
        return this.run(args);
    }
    // ─── Docker Compose ──────────────────────────────────────────────────
    /**
     * Run docker compose up.
     */
    async composeUp(projectDir, options = {}) {
        const args = ['compose'];
        args.push('up');
        if (options.detach)
            args.push('-d');
        if (options.build)
            args.push('--build');
        if (options.services)
            args.push(...options.services);
        return this.run(args, { cwd: projectDir });
    }
    /**
     * Run docker compose down.
     */
    async composeDown(projectDir, options = {}) {
        const args = ['compose', 'down'];
        if (options.volumes)
            args.push('-v');
        if (options.removeOrphans)
            args.push('--remove-orphans');
        return this.run(args, { cwd: projectDir });
    }
    /**
     * Get docker compose status.
     */
    async composePs(projectDir) {
        return this.run(['compose', 'ps', '--format', '{{json .}}'], { cwd: projectDir });
    }
    // ─── Volumes & Networks ──────────────────────────────────────────────
    /**
     * List volumes.
     */
    async listVolumes() {
        const result = await this.run(['volume', 'ls', '--format', '{{json .}}']);
        if (!result.success)
            return [];
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
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    /**
     * List networks.
     */
    async listNetworks() {
        const result = await this.run(['network', 'ls', '--format', '{{json .}}']);
        if (!result.success)
            return [];
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
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    // ─── Disk Usage & Cleanup ────────────────────────────────────────────
    /**
     * Get Docker disk usage.
     */
    async diskUsage() {
        const result = await this.run(['system', 'df', '--format', '{{json .}}']);
        if (!result.success)
            return null;
        const lines = result.stdout.split('\n').filter((l) => l.trim());
        const usage = {
            images: { count: 0, reclaimable: '0B', totalSize: '0B' },
            containers: { count: 0, reclaimable: '0B', totalSize: '0B' },
            volumes: { count: 0, reclaimable: '0B', totalSize: '0B' },
            buildCache: { count: 0, reclaimable: '0B', totalSize: '0B' },
        };
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                const type = obj.Type?.toLowerCase();
                if (type === 'Images')
                    usage.images = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
                if (type === 'Containers')
                    usage.containers = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
                if (type === 'Local Volumes')
                    usage.volumes = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
                if (type === 'Build Cache')
                    usage.buildCache = { count: obj.TotalCount || 0, reclaimable: obj.Reclaimable || '0B', totalSize: obj.Size || '0B' };
            }
            catch { /* ignore */ }
        }
        return usage;
    }
    /**
     * Cleanup Docker resources.
     */
    async cleanup(options = {}) {
        if (options.all) {
            return this.run(['system', 'prune', '-af', '--volumes']);
        }
        const results = [];
        if (options.danglingImages)
            results.push(await this.run(['image', 'prune', '-f']));
        if (options.stoppedContainers)
            results.push(await this.run(['container', 'prune', '-f']));
        if (options.unusedVolumes)
            results.push(await this.run(['volume', 'prune', '-f']));
        if (options.buildCache)
            results.push(await this.run(['builder', 'prune', '-f']));
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
    async checkContainerHealth(containerName) {
        const result = await this.inspectContainer(containerName);
        if (!result.success)
            return null;
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
        }
        catch {
            return null;
        }
    }
    /**
     * Monitor a container with periodic health checks.
     */
    async monitorContainer(containerName, intervalMs, callback) {
        const timer = setInterval(async () => {
            const health = await this.checkContainerHealth(containerName);
            if (health)
                callback(health);
        }, intervalMs);
        return () => clearInterval(timer);
    }
    // ─── Internal ────────────────────────────────────────────────────────
    async run(args, options = {}) {
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
            proc.stdout?.on('data', (data) => {
                if (options.captureStdout !== false)
                    stdout += data.toString();
            });
            proc.stderr?.on('data', (data) => {
                if (options.captureStderr !== false)
                    stderr += data.toString();
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
let _instance = null;
export function getDockerTool() {
    if (!_instance)
        _instance = new DockerTool();
    return _instance;
}
export function resetDockerTool() {
    _instance = null;
}
//# sourceMappingURL=docker-tool.js.map