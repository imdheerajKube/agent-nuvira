/**
 * Sandbox command — Manage Docker sandbox isolation for code execution.
 *
 * Usage:
 *   buff sandbox status             — Check if Docker is available
 *   buff sandbox config             — Show current sandbox config
 *   buff sandbox config --enable    — Enable Docker sandbox mode
 *   buff sandbox config --disable   — Disable Docker sandbox mode
 *   buff sandbox config --memory 2g — Set memory limit
 *   buff sandbox config --cpu 2     — Set CPU limit
 *   buff sandbox config --network   — Enable network access
 *   buff sandbox config --image python:3.12-slim — Set sandbox image
 *   buff sandbox images             — List available pre-defined images
 *   buff sandbox run <command>      — Run a command inside a sandbox container
 *   buff sandbox cleanup            — Destroy all active sandbox containers
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { getSandboxManager } from '../sandbox/manager.js';
import {
  getSandboxConfig,
  setSandboxConfig,
  DEFAULT_RESOURCE_LIMITS,
} from '../sandbox/types.js';
import type { SandboxConfig } from '../sandbox/types.js';
import type { ResourceLimits } from '../sandbox/types.js';
import { BUILTIN_SANDBOX_IMAGES } from '../sandbox/images.js';
import { detectProjectImage } from '../sandbox/images.js';

export class SandboxCommand extends BaseCommand {
  create(): Command {
    const command = new Command('sandbox')
      .description('Manage Docker sandbox isolation for code execution');

    // ── status ────────────────────────────────────────────────────────────────
    command
      .command('status')
      .description('Check Docker availability and sandbox status')
      .action(async () => {
        await this.showStatus();
      });

    // ── config ────────────────────────────────────────────────────────────────
    command
      .command('config')
      .description('Show or update sandbox configuration')
      .option('--enable', 'Enable Docker sandbox mode')
      .option('--disable', 'Disable Docker sandbox mode')
      .option('--memory <limit>', 'Set memory limit (e.g., 512m, 2g)')
      .option('--cpu <count>', 'Set CPU limit', parseFloat)
      .option('--disk <limit>', 'Set disk limit (e.g., 1g, 10g)')
      .option('--timeout <ms>', 'Set command timeout in milliseconds', parseInt)
      .option('--network', 'Enable network access in containers')
      .option('--image <image>', 'Set sandbox Docker image')
      .action(async (options?: {
        enable?: boolean;
        disable?: boolean;
        memory?: string;
        cpu?: number;
        disk?: string;
        timeout?: number;
        network?: boolean;
        image?: string;
      }) => {
        await this.manageConfig(options || {});
      });

    // ── images ────────────────────────────────────────────────────────────────
    command
      .command('images')
      .description('List available pre-defined sandbox images')
      .action(() => {
        this.listImages();
      });

    // ── run ────────────────────────────────────────────────────────────────────
    command
      .command('run')
      .description('Run a command inside a new sandbox container')
      .argument('<command>', 'Command to execute inside the sandbox')
      .option('--image <image>', 'Docker image to use')
      .option('--memory <limit>', 'Memory limit (e.g., 512m)')
      .option('--cpu <count>', 'CPU limit', parseFloat)
      .option('--timeout <ms>', 'Command timeout', parseInt)
      .option('--network', 'Enable network access')
      .option('--project <path>', 'Project directory to mount (default: current dir)')
      .action(async (command: string, options?: {
        image?: string;
        memory?: string;
        cpu?: number;
        timeout?: number;
        network?: boolean;
        project?: string;
      }) => {
        await this.runInSandbox(command, options || {});
      });

    // ── cleanup ───────────────────────────────────────────────────────────────
    command
      .command('cleanup')
      .description('Destroy all active sandbox containers')
      .action(async () => {
        await this.cleanupAll();
      });

    return command;
  }

  private async showStatus(): Promise<void> {
    const manager = getSandboxManager();
    const available = await manager.isDockerAvailable();
    const config = getSandboxConfig();

    logger.highlight('═'.repeat(60));
    logger.highlight('  🐳  Sandbox Status');
    logger.highlight('═'.repeat(60));
    console.log('');

    // Docker availability
    const dockerIcon = available ? '✅' : '❌';
    console.log(`  ${dockerIcon} Docker: ${available ? 'Available' : 'Not available'}`);
    if (!available) {
      const error = manager.getDockerError();
      if (error) console.log(`     Error: ${error}`);
    }

    // Sandbox mode
    const modeIcon = config.enabled ? '✅' : '⏸️';
    console.log(`  ${modeIcon} Sandbox mode: ${config.enabled ? 'Enabled' : 'Disabled'}`);

    // Resource limits
    console.log(`\n  📦 Resource Limits:`);
    console.log(`     Memory: ${config.limits.memoryLimit}`);
    console.log(`     CPU:    ${config.limits.cpuLimit} core(s)`);
    console.log(`     Disk:   ${config.limits.diskLimit}`);
    console.log(`     PIDs:   ${config.limits.pidsLimit}`);
    console.log(`     Network: ${config.limits.networkAccess ? 'Enabled' : 'Disabled'}`);
    console.log(`     Timeout: ${(config.limits.timeoutMs / 1000).toFixed(0)}s`);

    // Image
    console.log(`\n  🖼️  Default image: ${config.image.image} (${config.image.label})`);

    // Active containers
    const containers = manager.getManagedContainers();
    if (containers.length > 0) {
      console.log(`\n  🔗 Active containers: ${containers.length}`);
      for (const c of containers) {
        console.log(`     ${c.name} (${c.image}) — ${c.status}`);
      }
    }

    console.log('');
    logger.highlight('═'.repeat(60));
    console.log('');
  }

  private async manageConfig(options: {
    enable?: boolean;
    disable?: boolean;
    memory?: string;
    cpu?: number;
    disk?: string;
    timeout?: number;
    network?: boolean;
    image?: string;
  }): Promise<void> {
    const updates: Partial<SandboxConfig> = {};
    const limits: Required<import('../sandbox/types.js').ResourceLimits> = { ...DEFAULT_RESOURCE_LIMITS };

    if (options.enable) updates.enabled = true;
    if (options.disable) updates.enabled = false;
    if (options.memory) limits.memoryLimit = options.memory;
    if (options.cpu !== undefined) limits.cpuLimit = options.cpu;
    if (options.disk) limits.diskLimit = options.disk;
    if (options.timeout !== undefined) limits.timeoutMs = options.timeout;
    if (options.network !== undefined) limits.networkAccess = true;

    const imageOption = options.image;
    if (imageOption) {
      // Try to find a matching built-in image
      const builtin = BUILTIN_SANDBOX_IMAGES.find(
        (img) => img.image === imageOption || img.label.toLowerCase().includes(imageOption.toLowerCase()),
      );
      if (builtin) {
        updates.image = builtin;
      } else {
        // Use a custom image
        updates.image = {
          image: imageOption,
          label: imageOption,
          runtimes: ['custom'],
          shell: '/bin/bash',
        };
      }
    }

    // Apply resource limit updates
    if (Object.keys(limits || {}).length > 0) {
      updates.limits = limits;
    }

    if (Object.keys(updates).length === 0) {
      // Just show current config
      const config = getSandboxConfig();
      logger.info('Current sandbox configuration:');
      logger.info(`  Enabled: ${config.enabled}`);
      logger.info(`  Memory: ${config.limits.memoryLimit}`);
      logger.info(`  CPU: ${config.limits.cpuLimit}`);
      logger.info(`  Disk: ${config.limits.diskLimit}`);
      logger.info(`  PIDs: ${config.limits.pidsLimit}`);
      logger.info(`  Network: ${config.limits.networkAccess}`);
      logger.info(`  Timeout: ${config.limits.timeoutMs}ms`);
      logger.info(`  Image: ${config.image.image} (${config.image.label})`);
      logger.info(`  Work dir: ${config.workDir}`);
      logger.info(`  Container user: ${config.containerUser}`);
      return;
    }

    const updated = setSandboxConfig(updates);
    logger.success('Sandbox configuration updated.');
    logger.info(`  Enabled: ${updated.enabled}`);
    if (updates.limits) logger.info(`  Limits: memory=${updated.limits.memoryLimit}, cpu=${updated.limits.cpuLimit}, disk=${updated.limits.diskLimit}`);
    if (updates.image) logger.info(`  Image: ${updated.image.image}`);
  }

  private listImages(): void {
    logger.highlight('═'.repeat(60));
    logger.highlight('  🖼️  Available Sandbox Images');
    logger.highlight('═'.repeat(60));
    console.log('');

    for (const img of BUILTIN_SANDBOX_IMAGES) {
      console.log(`  ${img.image}`);
      console.log(`     Label: ${img.label}`);
      console.log(`     Runtimes: ${img.runtimes.join(', ')}`);
      console.log(`     Install: ${img.installCommand || 'N/A'}`);
      console.log(`     Test: ${img.testCommand || 'N/A'}`);
      console.log('');
    }

    console.log('  Configure: buff sandbox config --image <name>');
    console.log('');
  }

  private async runInSandbox(
    command: string,
    options: {
      image?: string;
      memory?: string;
      cpu?: number;
      timeout?: number;
      network?: boolean;
      project?: string;
    },
  ): Promise<void> {
    const manager = getSandboxManager();
    const available = await manager.isDockerAvailable();

    if (!available) {
      logger.error(`Docker is not available. ${manager.getDockerError()}`);
      logger.info('Install Docker Desktop: https://docs.docker.com/get-docker/');
      return;
    }

    const projectDir = options.project || process.cwd();

    try {
      logger.info('🐳 Creating sandbox container...');
      // Build resource limits from CLI options, filtering undefined values
      const sandboxLimits: Partial<ResourceLimits> = {};
      if (options.memory) sandboxLimits.memoryLimit = options.memory;
      if (options.cpu !== undefined) sandboxLimits.cpuLimit = options.cpu;
      if (options.timeout !== undefined) sandboxLimits.timeoutMs = options.timeout;
      if (options.network) sandboxLimits.networkAccess = true;

      // Use provided image or default from config
      const imageName: string = typeof options.image === 'string'
        ? options.image
        : getSandboxConfig().image.image;
      const containerId = await manager.createContainer(
        imageName,
        Object.keys(sandboxLimits).length > 0 ? sandboxLimits : undefined,
      );

      logger.info(`  Container: ${containerId.slice(0, 12)}...`);

      // Copy project files if requested
      if (options.project || true) {
        logger.info('  Copying project files...');
        await manager.copyProjectToContainer(containerId, projectDir);
      }

      logger.info(`  Running: ${command}`);
      console.log('');

      const result = await manager.runCommand(containerId, command);

      // Display result
      if (result.stdout) {
        console.log(result.stdout);
      }

      if (result.stderr) {
        console.error(result.stderr);
      }

      if (result.timedOut) {
        logger.warn(`Command timed out after ${(options.timeout || 600000) / 1000}s`);
      }

      logger.info(`Exit code: ${result.exitCode} | Duration: ${result.durationMs}ms`);

      // Cleanup
      logger.info('🧹 Cleaning up container...');
      await manager.destroyContainer(containerId);

    } catch (err) {
      logger.error(`Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cleanupAll(): Promise<void> {
    const manager = getSandboxManager();
    const containers = manager.getManagedContainers();

    if (containers.length === 0) {
      logger.info('No active sandbox containers to clean up.');
      return;
    }

    logger.info(`🧹 Cleaning up ${containers.length} sandbox container(s)...`);
    await manager.destroyAll();
    logger.success('All sandbox containers cleaned up.');
  }
}
