/**
 * process-control.ts — find + gracefully stop a running gateway/dashboard.
 *
 * Both `buff gateway start` and `buff dashboard` run in the FOREGROUND of
 * whatever terminal launched them — so "how do I stop it?" used to mean
 * Ctrl+C there, or `pkill -f`. These helpers give a proper answer:
 *
 *   buff gateway stop      → SIGTERM the running `gateway start` process
 *   buff dashboard stop    → SIGTERM the running `dashboard` process
 *
 * and back the dashboard's own Shutdown buttons (POST /api/admin/shutdown).
 *
 * Discovery is two-pronged:
 *   1. Port-based — the gateway binds its webhook receiver (default 8787) and
 *      the dashboard binds its port (default 3030); `findPidOnPort` from the
 *      dashboard-restart helpers locates whatever listens there.
 *   2. Command-line — `ps`/`wmic` match on the exact command (e.g.
 *      `agent-nuvira gateway start`) so a gateway started on a custom port,
 *      or one whose receiver failed to bind, is still found.
 *
 * Stopping is graceful: SIGTERM (both processes handle it — the gateway's
 * start() and the dashboard's serve() both shut down cleanly on SIGTERM),
 * with a grace window before SIGKILL so a slow socket close isn't cut short.
 */

import { execSync } from 'node:child_process';

// ─── PID discovery ──────────────────────────────────────────────────────────

/** Find the PID of a process whose command line matches `pattern`, or null.
 *  Never matches the current process. Cross-platform (ps / wmic). */
export function findPidByCommandLine(pattern: RegExp): number | null {
  try {
    let lines: string[];
    if (process.platform === 'win32') {
      const out = execSync('wmic process get processid,commandline /format:csv', { encoding: 'utf8' });
      lines = out.split(/\r?\n/);
      for (const line of lines) {
        // wmic CSV: "Node,<host>,<pid>,<commandline>"
        const parts = line.split(',');
        if (parts.length < 4) continue;
        const pid = Number.parseInt(parts[2], 10);
        const cmd = parts.slice(3).join(',');
        if (pid !== process.pid && pattern.test(cmd)) return pid;
      }
      return null;
    }
    const out = execSync('ps -eo pid=,command=', { encoding: 'utf8' });
    lines = out.split('\n');
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      if (pid === process.pid) continue;
      if (pattern.test(m[2])) return pid;
    }
    return null;
  } catch {
    return null; // ps/wmic unavailable or failed — port probe still covers it
  }
}

// ─── Stop helpers ───────────────────────────────────────────────────────────

/** Gracefully stop a PID: SIGTERM, wait up to `graceMs`, then SIGKILL. */
export async function stopProcess(pid: number, graceMs = 3000): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0); // throws ESRCH once the process is gone
      } catch {
        return true; // exited cleanly
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return true;
  } catch {
    return false; // EPERM (not ours) or already gone
  }
}

/** Result of a stop attempt. */
export interface StopResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

/**
 * Stop a running gateway: locate the `gateway start` process (command-line
 * match first, then the webhook receiver port, default 8787) and SIGTERM it.
 */
export async function stopGateway(opts?: { port?: number }): Promise<StopResult> {
  const port = opts?.port ?? 8787;
  let pid = findPidByCommandLine(/\bgateway\s+start\b/);
  if (pid === null) {
    const { findPidOnPort } = await import('./dashboard-restart.js');
    pid = await findPidOnPort(port);
  }
  if (pid === null) {
    return { stopped: false, reason: `no running gateway process found (port ${port} or \`gateway start\`)` };
  }
  const ok = await stopProcess(pid);
  return ok ? { stopped: true, pid } : { stopped: false, pid, reason: 'could not signal the gateway process' };
}

/**
 * Stop a running dashboard: locate it on its port (default 3030), falling
 * back to a command-line match for a dashboard started with `--port` /
 * `--host` overrides. The `stop` subcommand itself never matches (its own
 * command line is excluded, and the pattern rejects `dashboard stop`).
 */
export async function stopDashboard(opts?: { port?: number }): Promise<StopResult> {
  const port = opts?.port ?? 3030;
  const { findPidOnPort } = await import('./dashboard-restart.js');
  let pid = await findPidOnPort(port);
  if (pid === null) {
    // Reject the stop invocation itself: `agent-nuvira dashboard stop` would
    // otherwise match `\bdashboard\b`.
    pid = findPidByCommandLine(/\bdashboard(?!\s+stop\b)/);
  }
  if (pid === null) {
    return { stopped: false, reason: `no running dashboard found (port ${port} or \`dashboard\`)` };
  }
  const ok = await stopProcess(pid);
  return ok ? { stopped: true, pid } : { stopped: false, pid, reason: 'could not signal the dashboard process' };
}
