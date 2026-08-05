/**
 * Dashboard command — Launch the Agent-Nuvira Web UI Dashboard.
 *
 * Usage:
 *   agent-nuvira dashboard          — Start dashboard on default port (3030)
 *   agent-nuvira dashboard --port 8080 — Start on a specific port
 *   agent-nuvira dashboard --host 0.0.0.0 — Listen on all interfaces
 *   agent-nuvira dashboard --build  — Build the dashboard before starting
 *   agent-nuvira dashboard --no-open — Don't auto-open browser
 *   agent-nuvira dashboard --force  — Detect a STALE dashboard on the port and
 *                                     offer to restart it (kills + re-binds)
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
import {
  probeDashboardPortState,
  findPidOnPort,
  killPid,
  waitForPortFree,
  confirmStaleRestart,
} from './dashboard-restart.js';
import { createDashboardServer } from '../web-dashboard/server.js';
import { logger } from '../utils/logger.js';

// ─── DashboardCommand ───────────────────────────────────────────────────────

export class DashboardCommand extends BaseCommand {
  private server: ReturnType<typeof createDashboardServer> | null = null;

  create(): Command {
    const command = new Command('dashboard')
      .description('Launch the web-based dashboard for visualizing agent execution and system status');

    command
      // NOTE: not bare `parseInt` — commander invokes the parser as
      // (value, previous), so `parseInt(value, 3030)` treated the default port
      // as a radix and returned NaN, silently breaking `--port <port>`.
      .option('-p, --port <port>', 'Port to listen on', (v: string) => parseInt(v, 10), 3030)
      .option('--host <host>', 'Host to bind to', '127.0.0.1')
      .option('--no-open', 'Do not auto-open the browser')
      .option('--build', 'Build the dashboard (npm run build:dashboard) before starting')
      .option('--force', 'Detect a stale dashboard on the port (API/SSE mismatch) and offer to restart it')
      .action(async (options?: { port?: number; host?: string; open?: boolean; build?: boolean; force?: boolean }) => {
        await this.launchDashboard(options || {});
      });

    return command;
  }

  private async launchDashboard(options: {
    port?: number;
    host?: string;
    open?: boolean;
    build?: boolean;
    force?: boolean;
  }): Promise<void> {
    const port = options.port || 3030;
    const host = options.host || '127.0.0.1';
    const shouldOpen = options.open !== false;
    const shouldBuild = options.build === true;
    const force = options.force === true;

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

    logger.highlight('═'.repeat(60));
    logger.highlight('  🌐  Starting Agent-Nuvira Dashboard');
    logger.highlight('═'.repeat(60));
    console.log('');

    // Start the server directly in-process (no subprocess needed).
    // With --force, an EADDRINUSE from a STALE dashboard is detected, killed
    // (after confirmation) and the bind is retried — up to a few attempts so a
    // pathological loop can't hang the CLI.
    let attempts = 0;
    while (attempts < 3) {
      const outcome = await this.serve(port, host, shouldOpen, force);
      if (outcome !== 'restart') return;
      attempts++;
    }
    logger.error(`Could not start the dashboard on port ${port} after several restart attempts.`);
  }

  /**
   * Bind one server on the port and keep serving until shutdown.
   *
   * Returns:
   *   'running' — bound successfully; stopped via Ctrl+C (SIGINT/SIGTERM)
   *   'restart' — bind failed with EADDRINUSE and --force killed the stale
   *               dashboard; caller should retry
   *   'failed'  — bind failed and nothing was restarted (hint already logged)
   */
  private serve(
    port: number,
    host: string,
    shouldOpen: boolean,
    force: boolean,
  ): Promise<'running' | 'restart' | 'failed'> {
    process.env.BUFF_DASHBOARD_PORT = String(port);
    process.env.BUFF_DASHBOARD_HOST = host;

    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      const settle = (outcome: 'running' | 'restart' | 'failed') => {
        if (settled) return;
        settled = true;
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        resolve(outcome);
      };

      const shutdown = () => {
        logger.info('\nShutting down dashboard...');
        if (this.server) {
          this.server.server.close();
          this.server = null;
        }
        settle('running');
        process.exit(0);
      };

      try {
        // Port/host passed EXPLICITLY: createDashboardServer reads them at
        // call time. (Relying on BUFF_DASHBOARD_PORT env set here is not
        // enough — the server module binds its import-time constants.)
        this.server = createDashboardServer({ port, host });
      } catch (err) {
        logger.error(`Failed to start dashboard: ${err instanceof Error ? err.message : String(err)}`);
        logger.info('Make sure the dashboard module is available.');
        settle('failed');
        return;
      }

      const url = `http://localhost:${port}`;

      // listen() is async: bind errors (EADDRINUSE — e.g. a STALE dashboard
      // from an older version still running on this port) fire as an 'error'
      // event. Without a listener node crashes with an unhandled 'error' event
      // and NO explanation — and the browser stays pointed at the stale
      // instance, whose older API can break newer panels (the JSON-parse
      // errors users reported). Surface a clear, actionable message instead.
      this.server.server.once('listening', () => {
        started = true;
        logger.success(`Dashboard running at: ${url}`);
        console.log('  Press Ctrl+C to stop the dashboard.\n');
        // Auto-open browser only once we're actually serving.
        if (shouldOpen) {
          this.openBrowser(url);
        }
      });

      this.server.server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && force) {
          // Probe + kill + wait are async; drive them, then settle with the
          // outcome so the caller can retry the bind.
          void this.tryForceRestart(port, host).then(
            (restarted) => {
              if (restarted) {
                try { this.server?.server.close(); } catch { /* ignore */ }
                this.server = null;
                settle('restart');
                return;
              }
              this.logEADDRINUSE(port);
              try { this.server?.server.close(); } catch { /* ignore */ }
              this.server = null;
              settle('failed');
              process.exit(1);
            },
            () => {
              // tryForceRestart threw unexpectedly (inquirer regression, etc.) —
              // never leave the CLI hanging on an unsettled promise.
              this.logEADDRINUSE(port);
              try { this.server?.server.close(); } catch { /* ignore */ }
              this.server = null;
              settle('failed');
              process.exit(1);
            },
          );
          return;
        }
        if (err.code === 'EADDRINUSE') {
          this.logEADDRINUSE(port);
        } else if (!started) {
          logger.error(`Failed to start dashboard on ${host}:${port}: ${err.message}`);
        } else {
          // Runtime error after a successful bind — log, keep serving.
          logger.error(`Dashboard server error: ${err.message}`);
          return;
        }
        try { this.server?.server.close(); } catch { /* ignore */ }
        this.server = null;
        settle('failed');
        process.exit(1);
      });

      // Keep the process alive until Ctrl+C
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  /**
   * Detect a stale dashboard on the port and — if the user confirms — stop it.
   *
   * Only ever kills a dashboard whose /api/model-registry answers with SPA HTML
   * (the API/SSE mismatch): a CURRENT dashboard is never touched, and a
   * non-dashboard process is never touched.
   */
  private async tryForceRestart(port: number, host: string): Promise<boolean> {
    const state = await probeDashboardPortState(host, port);
    switch (state) {
      case 'current-dashboard':
        logger.info(`ℹ️  A CURRENT dashboard is already running on port ${port} — not restarting it.`);
        return false;
      case 'not-a-dashboard':
      case 'unknown':
        logger.info(`ℹ️  Port ${port} is not an Agent-Nuvira dashboard — leaving it alone.`);
        return false;
      case 'unreachable':
        // Nothing listening now (the process likely just exited) — retry the bind.
        return true;
      case 'stale-dashboard':
        break; // fall through to the restart flow
    }

    logger.warn(`⚠️  Stale dashboard detected on port ${port} (older version — missing newer API routes).`);
    if (!(await confirmStaleRestart(port))) {
      logger.info('OK — leaving the existing dashboard running.');
      return false;
    }

    const pid = await findPidOnPort(port);
    if (!pid) {
      logger.warn('Could not find the stale dashboard process — please stop it manually.');
      return false;
    }
    logger.info(`Stopping stale dashboard (PID ${pid})...`);
    const killed = await killPid(pid);
    if (!killed) {
      logger.warn('Could not stop the stale dashboard process — please stop it manually.');
      return false;
    }
    // Gate the retry on the port actually freeing — otherwise the caller
    // re-binds straight into EADDRINUSE and hits the confusing "could not find
    // the process" path (the PID is gone by then) instead of a clear timeout.
    const freed = await waitForPortFree(host, port);
    if (!freed) {
      logger.warn('The port did not free within the timeout — please stop the stale dashboard manually and retry.');
      return false;
    }
    return true;
  }

  private logEADDRINUSE(port: number): void {
    logger.error(`Port ${port} is already in use — another dashboard instance is running (possibly an older version).`);
    logger.info(`Stop it first, e.g.:  pkill -f 'agent-nuvira dashboard'`);
    logger.info(`Or use another port:   agent-nuvira dashboard --port ${Number(port) + 1}`);
    logger.info(`Tip: re-run with --force to detect and restart a stale dashboard automatically.`);
  }

  /**
   * Open the browser to the dashboard URL.
   * Uses the platform-specific command (open, xdg-open, start).
   */
  private openBrowser(url: string): void {
    const platform = process.platform;
    const isWindows = platform === 'win32';
    const cmd = isWindows ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';

    try {
      // Windows 'start' is a shell built-in, not an executable — needs shell: true
      // Syntax on Windows: start "" "http://..." (first arg is window title)
      const args = isWindows ? ['', url] : [url];
      const child = spawn(cmd, args, {
        stdio: 'ignore',
        detached: true,
        shell: isWindows,
      });
      child.unref();
    } catch {
      logger.warn(`Could not auto-open browser. Open manually: ${url}`);
    }
  }
}
