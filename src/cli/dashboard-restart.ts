/**
 * Stale-dashboard detection + restart helpers for `buff dashboard --force`.
 *
 * The stale scenario (v1.56.1 fix): an older dashboard server still running on
 * the port answers newer /api/* routes with the SPA index.html (HTTP 200,
 * text/html) — the "API/SSE mismatch" that made the browser's res.json() throw
 * "Unexpected token '<'". --force detects that mismatch, confirms with the
 * user, kills the stale process, waits for the port to free, and lets the CLI
 * re-bind a fresh server.
 *
 * All helpers are exported pure-ish functions so the logic is unit-testable
 * without launching real servers or killing real processes.
 */

import inquirer from 'inquirer';
import { execSync } from 'node:child_process';

import { logger } from '../utils/logger.js';

// ─── Port probing ───────────────────────────────────────────────────────────

/** What is listening on the port (or nothing). */
export type DashboardPortState =
  | 'unreachable'          // nothing usable responded (connection refused / timeout)
  | 'not-a-dashboard'      // a server is there, but it's not an Agent-Nuvira dashboard
  | 'current-dashboard'    // a dashboard WITH the newer API routes — do NOT touch
  | 'stale-dashboard'      // a dashboard WITHOUT the newer API routes (API/SSE mismatch)
  | 'unknown';             // a dashboard, but the probe was inconclusive — be safe

async function httpProbe(url: string, timeoutMs: number): Promise<{ status: number; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { status: res.status, contentType: res.headers.get('content-type') || '' };
  } catch {
    return null; // connection refused / aborted — nothing usable on the port
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify what's on `host:port`:
 *  1. nothing responds           → 'unreachable'
 *  2. not a dashboard (no JSON   → 'not-a-dashboard' (never kill arbitrary
 *     from /api/models|/api/health)   processes)
 *  3. dashboard, but /api/model-registry (a CURRENT-version route) answers
 *     with SPA HTML instead of JSON → 'stale-dashboard' (the exact mismatch)
 *  4. /api/model-registry answers JSON → 'current-dashboard'
 */
export async function probeDashboardPortState(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<DashboardPortState> {
  const base = `http://${host}:${port}`;

  const root = await httpProbe(`${base}/`, timeoutMs);
  if (!root) return 'unreachable';

  // Is it actually an Agent-Nuvira dashboard? These two API routes exist in
  // EVERY dashboard version (old and new), so a JSON answer proves it's ours.
  const [models, health] = await Promise.all([
    httpProbe(`${base}/api/models`, timeoutMs),
    httpProbe(`${base}/api/health`, timeoutMs),
  ]);
  const isDashboard = [models, health].some((r) => r !== null && r.contentType.includes('application/json'));
  if (!isDashboard) return 'not-a-dashboard';

  // Stale check — /api/model-registry only exists in versions that ship the
  // model registry. An older dashboard answers it with the SPA HTML (200);
  // a current one answers JSON.
  const registry = await httpProbe(`${base}/api/model-registry`, timeoutMs);
  if (registry === null) return 'unknown';
  return registry.contentType.includes('application/json') ? 'current-dashboard' : 'stale-dashboard';
}

// ─── PID discovery / kill ───────────────────────────────────────────────────

/** Find the PID listening on `port` (cross-platform), or null. */
export async function findPidOnPort(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const pid = Number.parseInt(line.trim().split(/\s+/).pop() || '', 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    }
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
    const pid = Number.parseInt(out.trim().split('\n')[0] || '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // lsof/netstat failed or nothing matched
  }
}

/** Gracefully stop a PID (SIGTERM then SIGKILL; taskkill on Windows). */
export async function killPid(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    // Grace window, then force-kill if it hasn't exited.
    await new Promise((r) => setTimeout(r, 400));
    try {
      process.kill(pid, 0); // throws (ESRCH) once the process is gone
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return true;
  } catch {
    return false; // EPERM (not our process) or already gone
  }
}

/** Poll until nothing accepts connections on the port (or timeout). */
export async function waitForPortFree(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 400);
      await fetch(`http://${host}:${port}/`, { signal: controller.signal });
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

// ─── Confirmation ───────────────────────────────────────────────────────────

/**
 * Ask before killing the stale dashboard. Non-interactive (CI / piped) runs
 * skip the prompt — `--force` was explicit consent — and restart immediately.
 */
export async function confirmStaleRestart(port: number): Promise<boolean> {
  if (!process.stdin.isTTY) {
    logger.info('ℹ️  Non-interactive run with --force — restarting the stale dashboard automatically.');
    return true;
  }
  const { restart } = await inquirer.prompt<{ restart: boolean }>([
    {
      type: 'confirm',
      name: 'restart',
      message: `A stale dashboard is running on port ${port}. Restart it now?`,
      default: false,
    },
  ]);
  return restart === true;
}
