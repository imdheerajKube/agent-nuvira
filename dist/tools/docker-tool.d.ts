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
    containers: Record<string, {
        name: string;
        ipv4Address: string;
    }>;
}
export interface DockerDiskUsage {
    images: {
        count: number;
        reclaimable: string;
        totalSize: string;
    };
    containers: {
        count: number;
        reclaimable: string;
        totalSize: string;
    };
    volumes: {
        count: number;
        reclaimable: string;
        totalSize: string;
    };
    buildCache: {
        count: number;
        reclaimable: string;
        totalSize: string;
    };
}
export declare class DockerTool {
    /**
     * Check if Docker is available.
     */
    isAvailable(): Promise<{
        available: boolean;
        version?: string;
        error?: string;
    }>;
    /**
     * Run a container.
     */
    runContainer(image: string, options?: {
        name?: string;
        detach?: boolean;
        ports?: string[];
        volumes?: string[];
        env?: Record<string, string>;
        network?: string;
        command?: string[];
        remove?: boolean;
    }): Promise<DockerCommandResult>;
    /**
     * Stop a container.
     */
    stopContainer(nameOrId: string, timeout?: number): Promise<DockerCommandResult>;
    /**
     * Start a stopped container.
     */
    startContainer(nameOrId: string): Promise<DockerCommandResult>;
    /**
     * Restart a container.
     */
    restartContainer(nameOrId: string, timeout?: number): Promise<DockerCommandResult>;
    /**
     * Remove a container.
     */
    removeContainer(nameOrId: string, force?: boolean): Promise<DockerCommandResult>;
    /**
     * List containers.
     */
    listContainers(all?: boolean): Promise<DockerContainerInfo[]>;
    /**
     * Execute a command in a running container.
     */
    exec(containerName: string, command: string[], options?: {
        interactive?: boolean;
        tty?: boolean;
    }): Promise<DockerCommandResult>;
    /**
     * Get container logs.
     */
    logs(containerName: string, options?: {
        follow?: boolean;
        tail?: number;
        since?: string;
    }): Promise<DockerCommandResult>;
    /**
     * Inspect a container.
     */
    inspectContainer(nameOrId: string): Promise<DockerCommandResult>;
    /**
     * Get container stats.
     */
    stats(containerNames?: string[]): Promise<DockerCommandResult>;
    /**
     * Copy files to/from a container.
     */
    cp(containerName: string, src: string, dest: string): Promise<DockerCommandResult>;
    /**
     * Build an image.
     */
    buildImage(path: string, options?: {
        tag?: string;
        file?: string;
        noCache?: boolean;
    }): Promise<DockerCommandResult>;
    /**
     * Pull an image.
     */
    pullImage(name: string): Promise<DockerCommandResult>;
    /**
     * Push an image.
     */
    pushImage(name: string): Promise<DockerCommandResult>;
    /**
     * List images.
     */
    listImages(): Promise<DockerImageInfo[]>;
    /**
     * Remove an image.
     */
    removeImage(nameOrId: string, force?: boolean): Promise<DockerCommandResult>;
    /**
     * Run docker compose up.
     */
    composeUp(projectDir: string, options?: {
        detach?: boolean;
        build?: boolean;
        services?: string[];
    }): Promise<DockerCommandResult>;
    /**
     * Run docker compose down.
     */
    composeDown(projectDir: string, options?: {
        volumes?: boolean;
        removeOrphans?: boolean;
    }): Promise<DockerCommandResult>;
    /**
     * Get docker compose status.
     */
    composePs(projectDir: string): Promise<DockerCommandResult>;
    /**
     * List volumes.
     */
    listVolumes(): Promise<DockerVolumeInfo[]>;
    /**
     * List networks.
     */
    listNetworks(): Promise<DockerNetworkInfo[]>;
    /**
     * Get Docker disk usage.
     */
    diskUsage(): Promise<DockerDiskUsage | null>;
    /**
     * Cleanup Docker resources.
     */
    cleanup(options?: {
        danglingImages?: boolean;
        stoppedContainers?: boolean;
        unusedVolumes?: boolean;
        buildCache?: boolean;
        all?: boolean;
    }): Promise<DockerCommandResult>;
    /**
     * Check container health.
     */
    checkContainerHealth(containerName: string): Promise<{
        healthy: boolean;
        state: string;
        healthStatus?: string;
        restartCount: number;
    } | null>;
    /**
     * Monitor a container with periodic health checks.
     */
    monitorContainer(containerName: string, intervalMs: number, callback: (health: {
        healthy: boolean;
        state: string;
        healthStatus?: string;
        restartCount: number;
    }) => void): Promise<() => void>;
    private run;
}
export declare function getDockerTool(): DockerTool;
export declare function resetDockerTool(): void;
//# sourceMappingURL=docker-tool.d.ts.map