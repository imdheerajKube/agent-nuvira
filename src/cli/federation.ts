/**
 * Federation command — Connect to and manage remote agent instances.
 *
 * Usage:
 *   buff federation status                — Show connection status and info
 *   buff federation start                 — Start the federation server
 *   buff federation start --port 8374     — Start on a specific port
 *   buff federation start --daemon        — Run in background (detached)
 *   buff federation connect <host>        — Connect to a remote server
 *   buff federation connect <host> --port 8374
 *   buff federation connect <host> --secret mykey
 *   buff federation disconnect            — Disconnect from remote server
 *   buff federation run <goal>            — Run a task on the remote server
 *   buff federation run <goal> --agent writer
 *   buff federation health                — Check remote server health
 *   buff federation a2a start             — Start the A2A server
 *   buff federation a2a discover <url>    — Discover an A2A agent
 *   buff federation a2a status <url>      — Check A2A agent health
 *   buff federation a2a run <url> <goal>  — Delegate task to A2A agent
 */

import { Command } from 'commander';
import { homedir, hostname } from 'node:os';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { startFederationServer } from '../federation/server.js';
import { FederationClient } from '../federation/client.js';
import type { FederationConfig } from '../federation/protocol.js';
import {
  DEFAULT_FEDERATION_CONFIG,
  DEFAULT_FEDERATION_PORT,
} from '../federation/protocol.js';
import { startA2AServer as startA2AServerFn } from '../federation/a2a-server.js';
import { A2A_DEFAULT_PORT, A2A_DEFAULT_HOST } from '../federation/a2a-types.js';
import { discoverAgent, delegateAndWait, checkA2AHealth } from '../federation/a2a-client.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const FEDERATION_CONFIG_PATH = join(homedir(), '.buff', 'federation.json');

// The A2A config is stored alongside federation config for simplicity.

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadConfig(): FederationConfig {
  try {
    if (existsSync(FEDERATION_CONFIG_PATH)) {
      const raw = readFileSync(FEDERATION_CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_FEDERATION_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_FEDERATION_CONFIG };
}

function saveConfig(config: FederationConfig): void {
  try {
    const dir = join(homedir(), '.buff');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(FEDERATION_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Non-critical
  }
}

// ─── FederationCommand ──────────────────────────────────────────────────────

export class FederationCommand extends BaseCommand {
  private client: FederationClient | null = null;

  create(): Command {
    const command = new Command('federation')
      .description('Connect to and manage remote agent instances');

    // ── status ────────────────────────────────────────────────────────────
    command
      .command('status')
      .description('Show federation connection status and configuration')
      .action(async () => {
        await this.showStatus();
      });

    // ── start ─────────────────────────────────────────────────────────────
    command
      .command('start')
      .description('Start the federation server (listens for incoming connections)')
      .option('-p, --port <port>', 'Port to listen on', parseInt, DEFAULT_FEDERATION_PORT)
      .option('-s, --secret <secret>', 'Pre-shared authentication key')
      .option('--host <host>', 'Host to bind to', DEFAULT_FEDERATION_CONFIG.host)
      .option('--daemon', 'Run in background (detached process)', false)
      .action(async (options?: {
        port?: number;
        secret?: string;
        host?: string;
        daemon?: boolean;
      }) => {
        await this.startServer(options || {});
      });

    // ── connect ───────────────────────────────────────────────────────────
    command
      .command('connect')
      .description('Connect to a remote federation server')
      .argument('<host>', 'Remote server hostname or IP address')
      .option('-p, --port <port>', 'Remote server port', parseInt, DEFAULT_FEDERATION_PORT)
      .option('-s, --secret <secret>', 'Pre-shared authentication key')
      .action(async (host: string, options?: { port?: number; secret?: string }) => {
        await this.connectToServer(host, options || {});
      });

    // ── disconnect ────────────────────────────────────────────────────────
    command
      .command('disconnect')
      .description('Disconnect from the remote federation server')
      .action(async () => {
        await this.disconnectFromServer();
      });

    // ── run ───────────────────────────────────────────────────────────────
    command
      .command('run')
      .description('Run a task on the remote federation server')
      .argument('<goal>', 'The task goal to execute remotely')
      .option('-a, --agent <agent>', 'Agent type to run', 'writer')
      .option('-p, --provider <provider>', 'Provider override')
      .option('-m, --model <model>', 'Model override')
      .option('--timeout <ms>', 'Task timeout in ms', parseInt)
      .option('--no-stream', 'Disable progress streaming')
      .action(async (goal: string, options?: {
        agent?: string;
        provider?: string;
        model?: string;
        timeout?: number;
        stream?: boolean;
      }) => {
        await this.runRemoteTask(goal, options || {});
      });

    // ── health ────────────────────────────────────────────────────────────
    command
      .command('health')
      .description('Check the health of the remote federation server')
      .action(async () => {
        await this.checkHealth();
      });

    // ── config ────────────────────────────────────────────────────────────
    command
      .command('config')
      .description('Show or update federation configuration')
      .option('--show', 'Show current config', true)
      .option('--set-secret <secret>', 'Set federation secret')
      .option('--set-port <port>', 'Set federation port', parseInt)
      .action(async (options?: { show?: boolean; setSecret?: string; setPort?: number }) => {
        await this.manageConfig(options || {});
      });

    // ═════════════════════════════════════════════════════════════════════
    //  A2A (Agent-to-Agent) Protocol Subcommands
    // ═════════════════════════════════════════════════════════════════════

    const a2a = command
      .command('a2a')
      .description('A2A (Agent-to-Agent) protocol — discover and connect to external A2A-compliant agents');

    a2a
      .command('discover')
      .description('Discover an A2A-compliant agent and fetch its AgentCard')
      .argument('<url>', 'Base URL of the A2A agent (e.g., http://192.168.1.50:8375)')
      .action(async (url: string) => {
        await this.a2aDiscover(url);
      });

    a2a
      .command('start')
      .description('Start the A2A server (listens for incoming A2A connections)')
      .option('-p, --port <port>', 'Port to listen on', parseInt, A2A_DEFAULT_PORT)
      .option('--host <host>', 'Host to bind to', A2A_DEFAULT_HOST)
      .action(async (options?: { port?: number; host?: string }) => {
        await this.a2aStartServer(options || {});
      });

    a2a
      .command('status')
      .description('Check the health and status of a remote A2A agent')
      .argument('<url>', 'Base URL of the A2A agent')
      .action(async (url: string) => {
        await this.a2aStatus(url);
      });

    a2a
      .command('run')
      .description('Delegate a task to a remote A2A-compliant agent')
      .argument('<url>', 'Base URL of the A2A agent')
      .argument('<goal>', 'The task goal to execute remotely')
      .option('-s, --skill <skill>', 'Skill ID to invoke (e.g., quick-fix, review-code)')
      .option('-a, --agent <agent>', 'Agent type to invoke (e.g., writer, planner)')
      .option('--timeout <ms>', 'Task timeout in ms', parseInt)
      .action(async (url: string, goal: string, options?: { skill?: string; agent?: string; timeout?: number }) => {
        await this.a2aRun(url, goal, options || {});
      });

    return command;
  }

  // ── Action Handlers ──────────────────────────────────────────────────────

  private async showStatus(): Promise<void> {
    const config = loadConfig();

    logger.highlight('═'.repeat(60));
    logger.highlight('  🌐  Federation Status');
    logger.highlight('═'.repeat(60));

    console.log(`\n  Mode: ${config.enabled ? '✅ Enabled' : '⏸️ Disabled'}`);
    console.log(`  Node ID: ${config.nodeId}`);
    if (config.secret) {
      console.log(`  Secret: ${'•'.repeat(Math.min(config.secret.length, 12))}`);
    } else {
      console.log('  Secret: ⚠️ Not set');
    }

    console.log(`\n  📡 Server:`);
    console.log(`     Host: ${config.host}`);
    console.log(`     Port: ${config.port}`);

    console.log(`\n  🎯 Capabilities:`);
    for (const cap of config.capabilities) {
      console.log(`     • ${cap}`);
    }

    console.log(`\n  ⚙️  Settings:`);
    console.log(`     Max concurrent tasks: ${config.maxConcurrentTasks}`);
    console.log(`     Task timeout: ${(config.taskTimeoutMs / 1000 / 60).toFixed(0)} min`);

    if (this.client) {
      console.log(`\n  🔗 Remote Connection:`);
      console.log(`     Status: ${this.client.isConnected() ? '✅ Connected' : '❌ Disconnected'}`);
      if (this.client.getServerId()) {
        console.log(`     Remote server: ${this.client.getServerId()}`);
      }
    }

    console.log('');
  }

  private async startServer(options: {
    port?: number;
    secret?: string;
    host?: string;
    daemon?: boolean;
  }): Promise<void> {
    const config = loadConfig();
    const port = options.port || config.port;
    const secret = options.secret || config.secret || process.env.FEDERATION_SECRET || '';
    const host = options.host || config.host;

    if (!secret) {
      logger.error('Federation secret is required.');
      logger.info('Set it with: buff federation config --set-secret <your-secret>');
      logger.info('Or via: export FEDERATION_SECRET=your-secret');
      return;
    }

    logger.info(`Starting federation server on ${host}:${port}...`);

    const updatedConfig: FederationConfig = {
      ...config,
      enabled: true,
      port,
      secret,
      host,
    };
    saveConfig(updatedConfig);

    try {
      const server = await startFederationServer({
        port,
        secret,
        host,
        nodeId: hostname(),
        capabilities: config.capabilities,
      });

      logger.success(`Federation server running on ${host}:${port}`);
      logger.info('  Press Ctrl+C to stop the server.');

      process.on('SIGINT', () => {
        logger.info('\nShutting down federation server...');
        server.close(() => {
          logger.success('Federation server stopped.');
          process.exit(0);
        });
      });
      process.on('SIGTERM', () => {
        server.close(() => process.exit(0));
      });

      await new Promise<void>(() => {});
    } catch (err) {
      logger.error(`Failed to start federation server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async connectToServer(
    host: string,
    options: { port?: number; secret?: string },
  ): Promise<void> {
    const config = loadConfig();
    let secret = options.secret || config.secret || process.env.FEDERATION_SECRET || '';

    if (!secret) {
      const answer = await inquirer.prompt<{ secret: string }>([
        {
          type: 'password',
          name: 'secret',
          message: 'Enter federation secret:',
          validate: (input: string) => input.length > 0 || 'Secret is required',
        },
      ]);
      secret = answer.secret;
    }

    logger.info(`Connecting to ${host}:${options.port || config.port}...`);

    this.client = new FederationClient({
      host,
      port: options.port || config.port,
      secret,
      nodeId: hostname(),
    });

    this.client.on('connected', () => {
      logger.success('Connected to federation server.');
    });

    this.client.on('error', (err: Error) => {
      logger.error(`Federation error: ${err.message}`);
    });

    this.client.on('task-progress', (event: any) => {
      if (event.progress !== undefined) {
        logger.info(`  Progress: ${event.progress}% — ${event.message || ''}`);
      }
    });

    try {
      const handshake = await this.client.connect();
      logger.success(`Connected to server: ${handshake.serverId}`);
      console.log(`  Session expires: ${new Date(handshake.expiresAt).toLocaleString()}`);
      console.log(`  Server capabilities: ${handshake.capabilities.join(', ')}`);

      saveConfig({
        ...config,
        enabled: true,
        host,
        port: options.port || config.port,
        secret,
      });
    } catch (err) {
      logger.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      this.client = null;
    }
  }

  private async disconnectFromServer(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      logger.success('Disconnected from federation server.');
    } else {
      logger.info('Not currently connected to any federation server.');
    }
  }

  private async runRemoteTask(
    goal: string,
    options: {
      agent?: string;
      provider?: string;
      model?: string;
      timeout?: number;
      stream?: boolean;
    },
  ): Promise<void> {
    if (!this.client || !this.client.isConnected()) {
      logger.error('Not connected to a federation server.');
      logger.info('Connect first: buff federation connect <host>');
      return;
    }

    const agentType = options.agent || 'writer';
    logger.info(`Delegating task to remote server: ${agentType}: ${goal.slice(0, 80)}...`);
    console.log('');

    try {
      const result = await this.client.delegateTask(goal, agentType, {
        provider: options.provider,
        model: options.model,
        timeoutMs: options.timeout,
        streamProgress: options.stream !== false,
      });

      console.log('');
      if (result.success) {
        logger.success('Task completed successfully on remote server.');
      } else {
        logger.error('Task failed on remote server.');
      }

      console.log(`  Summary: ${result.summary}`);
      if (result.details) {
        console.log(`  Details: ${result.details.slice(0, 500)}`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.costUsd) {
        console.log(`  Cost: $${result.costUsd.toFixed(6)}`);
      }
      console.log('');
    } catch (err) {
      logger.error(`Remote task failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async checkHealth(): Promise<void> {
    if (this.client && this.client.isConnected()) {
      try {
        const healthData = await this.client.getHealth();
        this.renderHealth(healthData);
        return;
      } catch {
        // Fall through to unauthenticated health check
      }
    }

    // Try unauthenticated health check
    const config = loadConfig();
    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/federation/health`,
      );
      const data = await response.json() as Record<string, unknown>;
      // Unwrap envelope if present
      const healthData = (data?.type === 'response' ? data.payload : data) as {
        status: string;
        uptime: number;
        activeTasks: number;
        completedTasks: number;
        failedTasks: number;
        version: string;
        loadAverage?: number[];
      };
      this.renderHealth({
        status: (healthData.status || 'unknown') as any,
        uptime: healthData.uptime || 0,
        activeTasks: healthData.activeTasks || 0,
        completedTasks: healthData.completedTasks || 0,
        failedTasks: healthData.failedTasks || 0,
        version: healthData.version || 'unknown',
        loadAverage: healthData.loadAverage,
      });
    } catch {
      logger.error('Could not connect to federation server.');
      logger.info('Is the server running? Start it with: buff federation start');
    }
  }

  private renderHealth(health: {
    status: string;
    uptime: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    version: string;
    loadAverage?: number[];
  }): void {
    const statusEmoji = health.status === 'ok' ? '✅' : health.status === 'degraded' ? '⚠️' : '❌';
    const uptimeMinutes = Math.floor(health.uptime / 1000 / 60);

    logger.highlight('═'.repeat(60));
    logger.highlight(`  🌐  Federation Server Health — ${statusEmoji} ${health.status}`);
    logger.highlight('═'.repeat(60));

    console.log(`\n  Status: ${health.status}`);
    console.log(`  Uptime: ${uptimeMinutes} minutes`);
    console.log(`  Version: ${health.version}`);
    console.log(`  Active tasks: ${health.activeTasks}`);
    console.log(`  Completed: ${health.completedTasks}`);
    console.log(`  Failed: ${health.failedTasks}`);
    if (health.loadAverage) {
      console.log(`  Load: ${health.loadAverage.map((l) => l.toFixed(2)).join(', ')}`);
    }
    console.log('');
  }

  private async manageConfig(options: {
    show?: boolean;
    setSecret?: string;
    setPort?: number;
  }): Promise<void> {
    const config = loadConfig();

    if (options.setSecret) {
      config.secret = options.setSecret;
      saveConfig(config);
      logger.success('Federation secret updated.');
    }

    if (options.setPort) {
      config.port = options.setPort;
      saveConfig(config);
      logger.success(`Federation port updated to ${options.setPort}.`);
    }

    if (options.show || (!options.setSecret && !options.setPort)) {
      logger.highlight('═'.repeat(60));
      logger.highlight('  ⚙️  Federation Configuration');
      logger.highlight('═'.repeat(60));
      console.log(`\n  Enabled: ${config.enabled}`);
      console.log(`  Host: ${config.host}`);
      console.log(`  Port: ${config.port}`);
      console.log(`  Secret: ${config.secret ? '•'.repeat(Math.min(config.secret.length, 12)) : '⚠️ Not set'}`);
      console.log(`  Node ID: ${config.nodeId}`);
      console.log(`  Max tasks: ${config.maxConcurrentTasks}`);
      console.log(`  Task timeout: ${(config.taskTimeoutMs / 1000 / 60).toFixed(0)} min`);
      console.log(`  Capabilities: ${config.capabilities.join(', ')}`);
      console.log('');
      console.log('  Set a value:');
      console.log('    buff federation config --set-secret <your-secret>');
      console.log('    buff federation config --set-port <port>');
      console.log('');
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  A2A Action Handlers
  // ═════════════════════════════════════════════════════════════════════

  private async a2aDiscover(url: string): Promise<void> {
    logger.info(`Discovering A2A agent at ${url}...`);
    console.log('');

    try {
      const result = await discoverAgent(url);

      if (result.success && result.card) {
        const card = result.card;
        logger.highlight('═'.repeat(60));
        logger.highlight(`  🤖  A2A Agent: ${card.name}`);
        logger.highlight('═'.repeat(60));

        console.log(`\n  Name: ${card.name}`);
        console.log(`  Description: ${card.description}`);
        console.log(`  URL: ${card.url}`);
        console.log(`  Version: ${card.version}`);
        if (card.identity?.organization) {
          console.log(`  Organization: ${card.identity.organization}`);
        }
        if (card.identity?.contactEmail) {
          console.log(`  Contact: ${card.identity.contactEmail}`);
        }

        console.log(`\n  🎯 Capabilities (${card.capabilities.length}):`);
        for (const cap of card.capabilities) {
          console.log(`     • ${cap.name}: ${cap.description}`);
        }

        console.log(`\n  ⚡ Skills (${card.skills.length}):`);
        for (const skill of card.skills) {
          console.log(`     • ${skill.id}: ${skill.description}`);
        }

        console.log(`\n  Response time: ${result.responseTimeMs}ms`);
        console.log('');
      } else {
        logger.error(`Discovery failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      logger.error(`Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async a2aStartServer(options: { port?: number; host?: string }): Promise<void> {
    const port = options.port || A2A_DEFAULT_PORT;
    const host = options.host || A2A_DEFAULT_HOST;

    logger.info(`Starting A2A server on ${host}:${port}...`);

    try {
      const server = await startA2AServerFn({
        port,
        host,
        nodeName: hostname(),
      });

      logger.success(`A2A server running on ${host}:${port}`);
      logger.info(`  AgentCard: http://${host}:${port}/.well-known/agent-card`);
      logger.info('  Press Ctrl+C to stop the server.');
      logger.info('');
      logger.info('  Other A2A agents can discover this node and delegate tasks to it.');
      logger.info('  Connect from another node:');
      logger.info(`    buff federation a2a discover http://${host}:${port}`);
      logger.info(`    buff federation a2a run http://${host}:${port} "fix login bug"`);

      process.on('SIGINT', () => {
        logger.info('\nShutting down A2A server...');
        server.close(() => {
          logger.success('A2A server stopped.');
          process.exit(0);
        });
      });
      process.on('SIGTERM', () => {
        server.close(() => process.exit(0));
      });

      await new Promise<void>(() => {});
    } catch (err) {
      logger.error(`Failed to start A2A server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async a2aStatus(url: string): Promise<void> {
    logger.info(`Checking A2A agent health at ${url}...`);

    try {
      const health = await checkA2AHealth(url);
      const statusEmoji = health.status === 'ok' ? '✅' : health.status === 'degraded' ? '⚠️' : '❌';
      const uptimeMinutes = Math.floor(health.uptime / 1000 / 60);

      logger.highlight('═'.repeat(60));
      logger.highlight(`  🤖  A2A Agent Health — ${statusEmoji} ${health.status}`);
      logger.highlight('═'.repeat(60));

      console.log(`\n  Status: ${health.status}`);
      console.log(`  Version: ${health.version}`);
      console.log(`  Uptime: ${uptimeMinutes} minutes`);
      console.log(`  Active tasks: ${health.activeTasks}`);
      console.log(`  Completed: ${health.completedTasks}`);
      console.log(`  Failed: ${health.failedTasks}`);
      console.log('');
    } catch (err) {
      logger.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async a2aRun(
    url: string,
    goal: string,
    options: { skill?: string; agent?: string; timeout?: number },
  ): Promise<void> {
    logger.info(`Delegating task to A2A agent at ${url}...`);
    console.log(`  Goal: ${goal.slice(0, 120)}`);
    if (options.skill) console.log(`  Skill: ${options.skill}`);
    if (options.agent) console.log(`  Agent: ${options.agent}`);
    console.log('');

    try {
      const result = await delegateAndWait(url, {
        goal,
        skillId: options.skill,
        agentType: options.agent,
      }, {
        timeoutMs: options.timeout,
        onProgress: (progress: number, message: string) => {
          if (progress > 0 && progress < 100) {
            logger.info(`  Progress: ${progress}% — ${message}`);
          }
        },
      });

      console.log('');
      if (result.success) {
        logger.success('A2A task completed successfully.');
      } else {
        logger.error('A2A task failed.');
      }

      console.log(`  Summary: ${result.summary}`);
      if (result.details) {
        console.log(`  Details: ${result.details.slice(0, 500)}`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');
    } catch (err) {
      logger.error(`A2A task failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
