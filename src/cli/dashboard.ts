/**
 * Dashboard command — Launch the Agent-Baba-D Web UI Dashboard.
 *
 * Usage:
 *   buff dashboard                  — Start dashboard on default port (3030)
 *   buff dashboard --port 8080      — Start on a specific port
 *   buff dashboard --host 0.0.0.0   — Listen on all interfaces
 *   buff dashboard --build           — Build the dashboard (npm run build:dashboard) before starting
 *   buff dashboard --no-open        — Don't auto-open browser
 *
 * The dashboard provides:
 * - Real-time system overview with stats
 * - Cost tracking visualization (by provider/model)
 * - Conversation history browser
 * - Model benchmark results
 * - Memory store statistics
 * - System health monitoring
 *
 * Data refreshes automatically via Server-Sent Events every 10 seconds.
 * The server runs entirely on Node.js built-in modules (no Express, no WebSocket packages).
 */

import { Command } from 'commander';
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BaseCommand } from './commands.js';
import { createDashboardServer } from '../web-dashboard/server.js';
import { logger } from '../utils/logger.js';

// ─── DashboardCommand ───────────────────────────────────────────────────────

export class DashboardCommand extends BaseCommand {
  private server: ReturnType<typeof createDashboardServer> | null = null;

  create(): Command {
    const command = new Command('dashboard')
      .description('Launch the web-based dashboard for visualizing agent execution and system status');

    command
      .option('-p, --port <port>', 'Port to listen on', parseInt, 3030)
      .option('--host <host>', 'Host to bind to', '127.0.0.1')
      .option('--no-open', 'Do not auto-open the browser')
      .option('--build', 'Build the dashboard (npm run build:dashboard) before starting')
      .action(async (options?: { port?: number; host?: string; open?: boolean; build?: boolean }) => {
        await this.launchDashboard(options || {});
      });

    return command;
  }

  private async launchDashboard(options: {
    port?: number;
    host?: string;
    open?: boolean;
    build?: boolean;
  }): Promise<void> {
    const port = options.port || 3030;
    const host = options.host || '127.0.0.1';
    const shouldOpen = options.open !== false;
    const shouldBuild = options.build === true;

    // ── Build the dashboard if requested ────────────────────────────────
    if (shouldBuild) {
      logger.info('Building dashboard...');
      const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      try {
        execSync('npm run build:dashboard', {
          cwd: projectRoot,
          stdio: 'inherit',
          timeout: 120_000, // 2 minutes
        });
        logger.success('Dashboard built successfully');
        console.log('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Dashboard build failed: ${msg}`);
        return;
      }
    }

    // Set environment variables for the server
    process.env.BUFF_DASHBOARD_PORT = String(port);
    process.env.BUFF_DASHBOARD_HOST = host;

    logger.highlight('═'.repeat(60));
    logger.highlight('  🌐  Starting Agent-Baba-D Dashboard');
    logger.highlight('═'.repeat(60));
    console.log('');

    // Start the server directly in-process (no subprocess needed)
    // Uses only Node.js built-in modules — tsx not required at runtime
    try {
      this.server = createDashboardServer();

      const url = `http://localhost:${port}`;

      logger.success(`Dashboard running at: ${url}`);
      console.log('  Press Ctrl+C to stop the dashboard.\n');

      // Auto-open browser
      if (shouldOpen) {
        this.openBrowser(url);
      }

      // Keep the process alive until Ctrl+C
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          logger.info('\nShutting down dashboard...');
          if (this.server) {
            this.server.server.close();
            this.server = null;
          }
          resolve();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
    } catch (err) {
      logger.error(`Failed to start dashboard: ${err instanceof Error ? err.message : String(err)}`);
      logger.info('Make sure the dashboard module is available.');
    }
  }

  /**
   * Open the browser to the dashboard URL.
   * Uses the platform-specific command (open, xdg-open, start).
   */
  private openBrowser(url: string): void {
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';

    try {
      const child = spawn(cmd, [url], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
    } catch {
      logger.warn(`Could not auto-open browser. Open manually: ${url}`);
    }
  }
}
