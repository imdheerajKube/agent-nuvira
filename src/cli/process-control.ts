/**
 * process-control.ts — find + gracefully stop a running gateway/dashboard.
 *
 * Both `nuvira gateway start` and `nuvira dashboard` run in the FOREGROUND of
 * whatever terminal launched them — so "how do I stop it?" used to mean
 * Ctrl+C there, or `pkill -f`. These helpers give a proper answer:
 *
 *   nuvira gateway stop      → SIGTERM the running `gateway start` process
 *   nuvira dashboard stop    → SIGTERM the running `dashboard` process
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

import { execSync, execFileSync } from 'node:child_process';

// ─── PID discovery ──────────────────────────────────────────────────────────

/** Find the PID of a process whose command line matches `pattern`, or null.
 *  Never matches the current process. Cross-platform (ps / wmic / PowerShell). */
export function findPidByCommandLine(pattern: RegExp): number | null {
  try {
    let lines: string[];
    if (process.platform === 'win32') {
      // Use execFileSync to avoid cmd.exe mangling PowerShell $() syntax.
      try {
        const out = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }'],
          { encoding: 'utf8', timeout: 10_000 }
        );
        lines = out.split(/\r?\n/);
        for (const line of lines) {
          const pipeIdx = line.indexOf('|');
          if (pipeIdx === -1) continue;
          const pid = Number.parseInt(line.slice(0, pipeIdx), 10);
          const cmd = line.slice(pipeIdx + 1);
          if (isNaN(pid) || pid === process.pid) continue;
          if (pattern.test(cmd)) return pid;
        }
        return null;
      } catch {
        // Fall back to wmic
      }
      const out = execSync('wmic process get processid,commandline /format:csv', { encoding: 'utf8' });
      lines = out.split(/\r?\n/);
      for (const line of lines) {
        // wmic CSV: "Node,<host>,<pid>,<commandline>"
        // Command lines can contain commas, so split only on first 3 commas
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
      // Try graceful first (WM_CLOSE), then force if still alive
      try {
        execSync(`taskkill /PID ${pid}`, { stdio: 'ignore', timeout: 2000 });
      } catch { /* may already be gone */ }
      // Wait up to graceMs for the process to exit
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        try {
          execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', timeout: 2000 });
          // Process still running — force kill
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          return true; // Process gone
        }
      }
      // Force kill
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5000 });
      } catch { /* already gone */ }
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
 * EVERY pid whose command line matches `pattern` (not just the first), newest
 * scan order. Needed to stop a SUPERVISED gateway, which is two processes: the
 * `--supervise` parent and the child it spawned.
 */
export function findPidsByCommandLine(pattern: RegExp): number[] {
  const pids: number[] = [];
  try {
    if (process.platform === 'win32') {
      const p = findPidByCommandLine(pattern);
      return p === null ? [] : [p];
    }
    const out = execSync('ps -eo pid=,command=', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      if (pid === process.pid) continue;
      if (pattern.test(m[2])) pids.push(pid);
    }
  } catch {
    /* ps unavailable — the port probe still covers it */
  }
  return pids;
}

/**
 * A command line that IS a node process (`…/node …` or `…/nodejs …`). The
 * gateway's own argv contains "gateway start", and so do the SHELLS that wrap
 * it — `tmux new-session … "node dist/index.js gateway start --supervise"` and
 * `bash -c cd … && node …` both match the text pattern. Signalling those kills
 * the wrapper (or a whole tmux session) and can leave the gateway running, so
 * the real node processes are preferred and the wrappers are ignored.
 */
function isNodeProcess(command: string): boolean {
  return /(?:^|\s)\S*(?:\/|^)node(?:js)?\s/.test(command) || /^[^\s]*node(?:js)?\s/.test(command);
}

/**
 * Locate the processes that ARE the gateway: a `gateway start` command-line
 * match (node processes preferred over the shells/tmux wrappers that merely
 * mention it), falling back to whatever is bound to the webhook port.
 *
 * Shared by {@link stopGateway} and {@link isGatewayRunning} so "is it up?" and
 * "stop it" can never disagree.
 */
async function findGatewayPids(port: number): Promise<number[]> {
  const pattern = /\bgateway\s+start\b/;
  const candidates = findPidsByCommandLine(pattern);
  // Prefer the node processes; fall back to whatever matched (a non-node
  // launcher is better than refusing to stop at all).
  const nodePids = candidates.filter((pid) => {
    try {
      const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' });
      return isNodeProcess(cmd);
    } catch {
      return false;
    }
  });
  const targets = nodePids.length > 0 ? nodePids : candidates;
  if (targets.length > 0) return targets;
  const { findPidOnPort } = await import('./dashboard-restart.js');
  const onPort = await findPidOnPort(port);
  return onPort === null ? [] : [onPort];
}

/**
 * Is a gateway already running?
 *
 * `nuvira dashboard` auto-starts the gateway, and auto-start MUST be
 * idempotent: a second gateway cannot bind the webhook port (default 8787) and
 * the user would be left with two competing processes and a stale one holding
 * the port. Shares `findGatewayPids` with {@link stopGateway} so "is it up?" and
 * "stop it" can never disagree.
 */
export async function isGatewayRunning(
  opts?: { port?: number },
): Promise<{ running: boolean; pid?: number }> {
  const targets = await findGatewayPids(opts?.port ?? 8787);
  return targets.length > 0 ? { running: true, pid: targets[0] } : { running: false };
}

/**
 * Stop a running gateway: locate the `gateway start` process (command-line
 * match first, then the webhook receiver port, default 8787) and SIGTERM it.
 *
 * `--supervise` runs TWO processes (a parent that restarts the child), so every
 * matching node process is stopped — the supervisor forwards SIGTERM to its
 * child, and an orphaned child (supervisor already gone) is caught directly.
 */
export async function stopGateway(opts?: { port?: number }): Promise<StopResult> {
  const port = opts?.port ?? 8787;
  const targets = await findGatewayPids(port);
  if (targets.length === 0) {
    return { stopped: false, reason: `no running gateway process found (port ${port} or \`gateway start\`)` };
  }
  let stoppedAny = false;
  let last: number | undefined;
  for (const pid of targets) {
    if (await stopProcess(pid)) stoppedAny = true;
    last = pid;
  }
  return stoppedAny
    ? { stopped: true, pid: last }
    : { stopped: false, pid: last, reason: 'could not signal the gateway process' };
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
