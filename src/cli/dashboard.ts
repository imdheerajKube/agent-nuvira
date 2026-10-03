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
import { envBuff } from '../config/paths';
import { spawn, execSync } from 'node:child_process';
import { openInBrowser } from '../utils/open-url.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BaseCommand, getCliName } from './commands.js';
import {
  probeDashboardPortState,
  findPidOnPort,
  killPid,
  waitForPortFree,
  confirmStaleRestart,
} from './dashboard-restart.js';
import { createDashboardServer } from '../web-dashboard/server.js';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USER,
  ensureDefaultAdmin,
} from '../web-dashboard/src/admin-auth.js';
import { guardRbacAction } from './rbac-guard.js';
import { isGatewayRunning } from './process-control.js';
import type { ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';

/**
 * The platform-appropriate "stop the running dashboard" hint for error
 * output — pkill is POSIX-only, so Windows users get the PowerShell/console
 * equivalent instead (platform independence is a hard product constraint).
 */
function stopProcessHint(): string {
  return process.platform === 'win32'
    ? `taskkill /F /IM node.exe   (or Ctrl+C in the terminal that runs it)`
    : `pkill -f 'agent-nuvira dashboard'`;
}

  // ─── DashboardCommand ───────────────────────────────────────────────────────

  export class DashboardCommand extends BaseCommand {
  private server: ReturnType<typeof createDashboardServer> | null = null;
  /** The gateway we started alongside this dashboard (never a pre-existing one). */
  private gatewayChild: ChildProcess | null = null;

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
      .option('--cwd <dir>', 'Working directory for the dashboard (default: process.cwd())')
      .option('--no-gateway', 'Do not start the messaging gateway alongside the dashboard')
      .option('--keep-gateway', 'Leave the gateway running after the dashboard exits')
      .option('--gateway-port <port>', 'Webhook receiver port for the gateway', (v: string) => parseInt(v, 10), 8787)
      .action(async (options?: {
        port?: number;
        host?: string;
        open?: boolean;
        build?: boolean;
        force?: boolean;
        cwd?: string;
        gateway?: boolean;
        keepGateway?: boolean;
        gatewayPort?: number;
      }) => {
        await this.launchDashboard(options || {});
      });

    command
      .command('stop')
      .description('Stop a running dashboard gracefully (SIGTERM — from any terminal)')
      .option('-p, --port <port>', 'Port the dashboard is bound to', (v: string) => parseInt(v, 10), 3030)
      .action(async (options?: { port?: number }) => {
        await this.stopDashboard(options?.port ?? 3030);
      });

    return command;
  }

  /**
   * Close BOTH the primary and the IPv6-loopback twin listeners (best-effort).
   * The twin shares the same port family-differently, so it must be closed too
   * or a restarted dashboard would hit EADDRINUSE on the ::1 side.
   */
  private closeAllListeners(): void {
    if (!this.server) return;
    try { this.server.server.close(); } catch { /* ignore */ }
    if (this.server.ipv6Twin) {
      try { this.server.ipv6Twin.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Start the messaging gateway alongside the dashboard, unless one is already
   * running.
   *
   * WHY. The gateway is what makes the agent reachable from WhatsApp/Telegram/
   * Slack, and needing a second terminal to get it is exactly the manual cadence
   * a GUI-first user should not have to discover. Starting it here makes one
   * command the whole product.
   *
   * IDEMPOTENT BY CONSTRUCTION. A second gateway cannot bind the webhook port,
   * so an existing one is reused rather than duplicated — and we then record
   * `gatewayChild = null`, which is what guarantees the dashboard never kills a
   * gateway it did not start.
   *
   * CHILD OF THIS PROCESS, deliberately not detached: it dies with the dashboard
   * unless `--keep-gateway` is given, so there is no orphan holding port 8787.
   */
  private async startGateway(port: number): Promise<void> {
    const existing = await isGatewayRunning({ port });
    if (existing.running) {
      logger.info(
        `🌐 Gateway already running${existing.pid ? ` (PID ${existing.pid})` : ''} — reusing it.`,
      );
      return;
    }

    const entry = process.argv[1];
    if (!entry) {
      logger.warn('Could not determine the CLI entry point — start messaging with: nuvira gateway start');
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry, 'gateway', 'start', '--port', String(port)], {
        stdio: 'ignore',
        env: process.env,
      });
    } catch (err) {
      logger.warn(`Could not start the gateway: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.gatewayChild = child;

    // A gateway that cannot bind its port exits within a moment. Reporting
    // "started" for a process that is already dead is the exact kind of claim
    // this product exists to avoid, so wait and check before saying anything.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // `exitCode != null` (loose) is deliberate: a real ChildProcess reports
    // `null` while running and a number once dead, and a test double that omits
    // the field must read as "still running" rather than as a crash.
    if (child.exitCode != null) {
      this.gatewayChild = null;
      logger.warn(
        `Gateway exited immediately (code ${child.exitCode}) — messaging is off. ` +
          `Run \`${getCliName()} gateway status\` to see why.`,
      );
      return;
    }

    logger.info(`🌐 Gateway started (PID ${child.pid}) — messaging channels are live alongside the dashboard.`);
  }

  /**
   * Stop the gateway THIS dashboard started. A pre-existing gateway
   * (`gatewayChild === null`) is never touched — auto-start must not silently
   * take ownership of a process the user started themselves.
   */
  private stopOwnedGateway(): void {
    const child = this.gatewayChild;
    if (!child || child.exitCode != null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.gatewayChild = null;
  }

  private async launchDashboard(options: {
    port?: number;
    host?: string;
    open?: boolean;
    build?: boolean;
    force?: boolean;
    cwd?: string;
    gateway?: boolean;
    keepGateway?: boolean;
    gatewayPort?: number;
  }): Promise<void> {
    // --cwd overrides the dashboard's working directory: the 'current dir'
    // chip in the chat picker reflects process.cwd(), so changing it early
    // makes the dashboard behave as if launched from that directory.
    if (options.cwd) {
      const { resolve } = await import('node:path');
      const target = resolve(options.cwd);
      try {
        process.chdir(target);
      } catch (err) {
        logger.error(`Cannot chdir to --cwd ${target}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const port = options.port || 3030;
    const host = options.host || '127.0.0.1';
    const shouldOpen = options.open !== false;
    const shouldBuild = options.build === true;
    const force = options.force === true;
    // The gateway runs ALONGSIDE the dashboard by default: a GUI-first user
    // should get messaging channels live without discovering a second command.
    const shouldStartGateway = options.gateway !== false;
    const keepGateway = options.keepGateway === true;
    const gatewayPort = options.gatewayPort || 8787;

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
      const outcome = await this.serve(port, host, shouldOpen, force, {
        shouldStartGateway,
        keepGateway,
        gatewayPort,
      });
      if (outcome !== 'restart') return;
      attempts++;
    }
    logger.error(`Could not start the dashboard on port ${port} after several restart attempts.`);
  }

  /**
   * `dashboard stop` — locate a RUNNING dashboard and stop it gracefully
   * (SIGTERM). Works from any terminal, not just the one that launched it:
   * the dashboard's serve() handler shuts down cleanly on SIGTERM. RBAC:
   * system.manage (admin) — stopping a whole server is a system action.
   */
  private async stopDashboard(port: number): Promise<void> {
    if (!guardRbacAction('system.manage')) return;
    const { stopDashboard } = await import('./process-control.js');
    const result = await stopDashboard({ port });
    if (result.stopped) {
      logger.success(`Dashboard stopped (PID ${result.pid})`);
    } else {
      logger.error(`Could not stop the dashboard: ${result.reason ?? 'no running dashboard found'}`);
      process.exitCode = 1;
    }
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
    gateway: { shouldStartGateway: boolean; keepGateway: boolean; gatewayPort: number },
  ): Promise<'running' | 'restart' | 'failed'> {
    const { shouldStartGateway, keepGateway, gatewayPort } = gateway;
    process.env.NUVIRA_DASHBOARD_PORT = String(port);
    process.env.NUVIRA_DASHBOARD_HOST = host;

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
        // Stop the gateway we started, so no orphan holds the webhook port.
        // `--keep-gateway` leaves it up for messaging that must outlive the GUI.
        if (!keepGateway) {
          this.stopOwnedGateway();
          if (shouldStartGateway) logger.info('Gateway stopped with the dashboard (\`--keep-gateway\` leaves it running).');
        }
        if (this.server) {
          this.closeAllListeners();
          this.server = null;
        }
        settle('running');
        process.exit(0);
      };

      // Zero-setup first run: create admin/admin so a GUI-first user can log in
      // without inventing a password first. The account is deliberately
      // crippled until the password is changed (every mutating route returns
      // 403 password_change_required), so a published credential is a doorway,
      // not an open door. No-op once any admin exists.
      const bootstrapped = ensureDefaultAdmin();
      if (bootstrapped) {
        logger.info('');
        logger.info('  ┌─ First run: a default admin account was created ─────────────┐');
        logger.info(`  │  username: ${DEFAULT_ADMIN_USER}`);
        logger.info(`  │  password: ${DEFAULT_ADMIN_PASSWORD}`);
        logger.info('  │                                                            │');
        logger.info('  │  This password is PUBLIC — the dashboard will insist you    │');
        logger.info('  │  change it before it will save anything. Anyone on your      │');
        logger.info('  │  network can sign in until you do.                          │');
        logger.info('  └────────────────────────────────────────────────────────────┘');
        logger.info('');
      }

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

      // PERMANENT "server unreachable" fix: open the DETERMINISTIC IPv4
      // loopback URL. `http://localhost:` resolves to ::1 FIRST on macOS
      // (IPv6 before IPv4), so browsers hit [::1]:port → ECONNREFUSED → the
      // Models page error banner. 127.0.0.1 can never be mis-resolved.
      const url = `http://127.0.0.1:${port}`;

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
        // Gateway LAST: started only once the dashboard actually bound, so a
        // failed start (EADDRINUSE on a stale dashboard) never leaves a stray
        // gateway behind.
        if (shouldStartGateway) {
          void this.startGateway(gatewayPort);
        }
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
                this.closeAllListeners();
                this.server = null;
                settle('restart');
                return;
              }
              this.logEADDRINUSE(port);
              this.closeAllListeners();
              this.server = null;
              settle('failed');
              process.exit(1);
            },
            () => {
              // tryForceRestart threw unexpectedly (inquirer regression, etc.) —
              // never leave the CLI hanging on an unsettled promise.
              this.logEADDRINUSE(port);
              this.closeAllListeners();
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
        this.closeAllListeners();
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
    logger.info(`Stop it first, e.g.:  ${stopProcessHint()}`);
    logger.info(`Or use another port:   agent-nuvira dashboard --port ${Number(port) + 1}`);
    logger.info(`Tip: re-run with --force to detect and restart a stale dashboard automatically.`);
  }

  /**
   * Open the browser to the dashboard URL.
   * Delegates to the shared platform-aware launcher (`utils/open-url.ts`), so
   * the dashboard and the `website` command cannot disagree about how a URL is
   * opened.
   */
  private openBrowser(url: string): void {
    if (!openInBrowser(url)) {
      logger.warn(`Could not auto-open browser. Open manually: ${url}`);
    }
  }
}
