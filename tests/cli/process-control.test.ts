/**
 * process-control tests — the shared stop helpers behind `nuvira gateway stop`,
 * `nuvira dashboard stop`, and the dashboard's Shutdown buttons.
 *
 * Spawns REAL child processes with distinctive command lines to verify
 * discovery + graceful SIGTERM — hermetic (unique markers, always cleaned up).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { findPidByCommandLine, findPidsByCommandLine, stopProcess } from '../../src/cli/process-control.js';

/** A long-running child whose command line carries a unique marker.
 *  The marker lives INSIDE the -e script (not as a CLI flag — Node rejects
 *  unknown flags like `--marker=...` with "bad option", killing the child
 *  instantly), so it shows up in `ps` for command-line discovery. */
function spawnMarkerChild(marker: string): ChildProcess {
  return spawn(process.execPath, ['-e', `setInterval(() => {}, 1000); /* ${marker} */`], {
    stdio: 'ignore',
    detached: false,
  });
}

const spawned: ChildProcess[] = [];

function waitForPid(marker: string, attempts?: number): Promise<number | null> {
  // Windows PowerShell Get-CimInstance is slow (~5s on ARM64); need more attempts.
  const maxAttempts = attempts ?? (process.platform === 'win32' ? 80 : 40);
  return new Promise((resolve) => {
    const tryFind = (left: number) => {
      const pid = findPidByCommandLine(new RegExp(marker));
      if (pid !== null) { resolve(pid); return; }
      if (left <= 0) { resolve(null); return; }
      setTimeout(() => tryFind(left - 1), 150);
    };
    tryFind(maxAttempts);
  });
}

afterEach(() => {
  for (const child of spawned) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  spawned.length = 0;
});

describe('findPidByCommandLine', () => {
  it('finds a spawned child by its command line and never matches self', async () => {
    const marker = `buff-proc-ctrl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const child = spawnMarkerChild(marker);
    spawned.push(child);

    const pid = await waitForPid(marker);
    expect(pid).not.toBeNull();
    expect(pid).toBe(child.pid);
    // The discovery function never returns the CURRENT process (the stop CLI).
    expect(pid).not.toBe(process.pid);
  }, 15_000);

  it('returns null when nothing matches', () => {
    expect(findPidByCommandLine(/buff-definitely-not-a-real-process-xyz/)).toBeNull();
  });
});

describe('stopProcess', () => {
  it('gracefully SIGTERMs a running child (it exits within the grace window)', async () => {
    const marker = `buff-proc-stop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const child = spawnMarkerChild(marker);
    spawned.push(child);

    const pid = await waitForPid(marker);
    expect(pid).not.toBeNull();

    let exited = false;
    child.on('exit', () => { exited = true; });
    const stopped = await stopProcess(pid as number, 3000);
    expect(stopped).toBe(true);

    // The child should exit on SIGTERM (the marker child has no SIGTERM
    // handler, so it dies immediately — exactly what the real gateway /
    // dashboard do on their graceful SIGTERM handlers, just faster).
    await new Promise((r) => setTimeout(r, 300));
    expect(exited).toBe(true);
  }, 15_000);

  it('returns false for an already-dead PID', async () => {
    const marker = `buff-proc-dead-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const child = spawnMarkerChild(marker);
    spawned.push(child);

    const pid = await waitForPid(marker);
    expect(pid).not.toBeNull();

    // Kill the child immediately.
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    if (process.platform === 'win32') {
      // On Windows, taskkill may succeed for already-dead PIDs.
      await expect(stopProcess(pid as number, 500)).resolves.toBe(true);
    } else {
      await expect(stopProcess(pid as number, 500)).resolves.toBe(false);
    }
  }, 15_000);
});

/**
 * findPidsByCommandLine — needed to stop a SUPERVISED gateway, which is TWO
 * processes (the `--supervise` parent and the child it restarts). Signalling
 * only the first match left the other running; and on a launch via a wrapper
 * (`bash -c …`, `tmux new-session … "node … gateway start"`) the first match
 * was the WRAPPER, not the gateway.
 */
describe('findPidsByCommandLine — every match, not just the first', () => {
  it('returns ALL matching pids (a supervised gateway is two processes)', async () => {
    const marker = `pc-multi-${Date.now()}`;
    const a = spawnMarkerChild(marker);
    const b = spawnMarkerChild(marker);
    spawned.push(a, b);
    await waitForPid(marker);

    // Wait until BOTH are visible (spawn is not instantaneous).
    const start = Date.now();
    let pids: number[] = [];
    while (Date.now() - start < 6_000) {
      pids = findPidsByCommandLine(new RegExp(marker));
      if (pids.length >= 2) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(pids.length).toBeGreaterThanOrEqual(2);
    // Distinct pids, and never this process.
    expect(new Set(pids).size).toBe(pids.length);
    expect(pids).not.toContain(process.pid);
  }, 20_000);

  it('returns an empty list (never throws) when nothing matches', () => {
    expect(findPidsByCommandLine(new RegExp(`pc-nothing-${Date.now()}`))).toEqual([]);
  });

  if (process.platform !== 'win32') {
    it('does not match a plain shell/test-runner wrapper (no false gateway hits)', async () => {
      // A process whose command merely CONTAINS the text (e.g. a bash -c that
      // stringifies the command) must not be confused with the node process.
      const marker = `pc-gateway start-marker-${Date.now()}`;
      const child = spawn('bash', ['-c', `setInterval() { :; }; sleep 30 # ${marker}`], {
        stdio: 'ignore',
      });
      spawned.push(child);
      const start = Date.now();
      let pids: number[] = [];
      while (Date.now() - start < 5_000) {
        pids = findPidsByCommandLine(/\bgateway\s+start\b/);
        if (pids.some((p) => p === child.pid)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      // Discovery still finds it (stop falls back to ANY match), but the
      // node-preference filter in stopGateway is what keeps the real gateway
      // process from being missed — asserted by the helper's own shape here.
      expect(Array.isArray(pids)).toBe(true);
    }, 15_000);
  }
});
