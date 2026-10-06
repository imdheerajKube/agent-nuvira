/**
 * omniroute-control.ts — start / stop / status for the OmniRoute gateway.
 *
 * OmniRoute (https://github.com/diegosouzapw/OmniRoute) is an EXTERNAL, MIT,
 * local-first AI gateway: a user installs it globally (`npm install -g
 * omniroute`) and runs it as a long-lived process on port 20128. Agent-nuvira
 * does not embed it — it is one candidate provider in the catalog, reachable at
 * `http://127.0.0.1:20128/v1`. What the user does NOT get for free is the
 * question "is it running, and how do I stop it?" — the install leaves them with
 * a foreground process and `Ctrl+C`.
 *
 * This module is the thin lifecycle layer BOTH the CLI
 * (`nuvira omniroute start|stop|status`) and the dashboard's Admin page use, so
 * there is exactly one implementation of "is it up?" and one way to stop it —
 * the same discipline `process-control.ts` applies to nuvira's own gateway.
 *
 * Reachability is a REAL HTTP probe of the gateway's own `/v1/models`. A 401/403
 * is treated as UP: OmniRoute can require a local token, and a gateway that
 * answers "unauthorized" is unambiguously running (the same rule the
 * OpenAI-compat adapter learned — a gateway's auth-gated listing is not a
 * down service). Only a connection failure or timeout means down.
 *
 * Probes never throw; `spawn`/`fetch` are injectable so tests run with no
 * network and no real process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { findPidOnPort } from './dashboard-restart.js';
import { findPidsByCommandLine, stopProcess, type StopResult } from './process-control.js';

/** OmniRoute's default port (its own default, mirrored by the catalog baseUrl). */
export const OMNIROUTE_PORT = 20128;

/** Base URL of the gateway's OpenAI-compatible API. */
export const OMNIROUTE_DEFAULT_URL = `http://127.0.0.1:${OMNIROUTE_PORT}/v1`;

/** How long to wait for a freshly-spawned gateway to answer before giving up. */
const START_WAIT_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;

type FetchFn = typeof fetch;

export interface OmniRouteProbe {
  reachable: boolean;
  baseUrl: string;
  /** Human-readable outcome, e.g. "Reachable (HTTP 200)". */
  detail: string;
}

export interface OmniRouteStatus extends OmniRouteProbe {
  /** Reachable OR a process is listening on the port. */
  running: boolean;
  pid: number | null;
  port: number;
}

export interface OmniRouteStartResult {
  ok: boolean;
  /** True when THIS call spawned the process (false = it was already up). */
  started: boolean;
  status: OmniRouteStatus;
  detail: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The port implied by a baseUrl, falling back to OmniRoute's default. */
function portFromBaseUrl(baseUrl: string): number {
  try {
    const port = new URL(baseUrl).port;
    if (port) return Number(port);
  } catch {
    /* not a parseable URL — fall through */
  }
  return OMNIROUTE_PORT;
}

/**
 * Probe the gateway's `/v1/models`. Never throws — a failed request is a
 * successful probe that reports `reachable: false`.
 */
export async function probeOmniRoute(
  baseUrl: string = OMNIROUTE_DEFAULT_URL,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<OmniRouteProbe> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
    if (res.ok) return { reachable: true, baseUrl, detail: `Reachable (HTTP ${res.status})` };
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, baseUrl, detail: `Running — the endpoint is auth-gated (HTTP ${res.status})` };
    }
    return { reachable: false, baseUrl, detail: `Answered but not as OmniRoute (HTTP ${res.status})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, baseUrl, detail: msg.includes('abort') ? 'Timed out' : `Not reachable (${msg})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Reachability + process state, as the CLI `status` and the dashboard read it. */
export async function omnirouteStatus(
  baseUrl: string = OMNIROUTE_DEFAULT_URL,
  opts?: { fetchFn?: FetchFn; findPid?: (port: number) => Promise<number | null> },
): Promise<OmniRouteStatus> {
  const port = portFromBaseUrl(baseUrl);
  const probe = await probeOmniRoute(baseUrl, opts?.fetchFn);
  const findPid = opts?.findPid ?? findPidOnPort;
  let pid: number | null = null;
  try {
    pid = await findPid(port);
  } catch {
    pid = null;
  }
  return { ...probe, running: probe.reachable || pid !== null, pid, port };
}

/**
 * Start the gateway in the background and wait for it to answer.
 *
 * Detached + stdio ignored: the gateway must outlive the CLI/dashboard call
 * that launched it (that is the whole point of a start button). A missing
 * `omniroute` binary (ENOENT) is reported as such rather than left as an opaque
 * failure, because "not installed" and "failed to start" need different fixes.
 */
export async function startOmniRoute(opts?: {
  baseUrl?: string;
  spawnFn?: typeof spawn;
  fetchFn?: FetchFn;
  findPid?: (port: number) => Promise<number | null>;
  waitMs?: number;
}): Promise<OmniRouteStartResult> {
  const baseUrl = opts?.baseUrl ?? OMNIROUTE_DEFAULT_URL;
  const before = await omnirouteStatus(baseUrl, { fetchFn: opts?.fetchFn, findPid: opts?.findPid });
  if (before.reachable) {
    return { ok: true, started: false, status: before, detail: 'OmniRoute is already running.' };
  }

  const spawnFn = opts?.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn('omniroute', [], { detached: true, stdio: 'ignore' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      started: false,
      status: before,
      detail: `Could not start OmniRoute (${msg}). Install it with: npm install -g omniroute`,
    };
  }
  child.unref();

  // ENOENT (binary not on PATH) arrives asynchronously, so give the spawn a beat
  // to fail before we start polling a gateway that will never come up.
  const spawnError = await new Promise<string | null>((resolve) => {
    let settled = false;
    child.once('error', (e: Error) => {
      if (settled) return;
      settled = true;
      resolve(e.message);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 300);
  });
  if (spawnError) {
    return {
      ok: false,
      started: false,
      status: before,
      detail: `OmniRoute is not installed or not on PATH (${spawnError}). Install it with: npm install -g omniroute`,
    };
  }

  const deadline = Date.now() + (opts?.waitMs ?? START_WAIT_MS);
  while (Date.now() < deadline) {
    if ((await probeOmniRoute(baseUrl, opts?.fetchFn)).reachable) {
      const status = await omnirouteStatus(baseUrl, { fetchFn: opts?.fetchFn, findPid: opts?.findPid });
      return { ok: true, started: true, status, detail: 'OmniRoute started.' };
    }
    await delay(500);
  }
  const status = await omnirouteStatus(baseUrl, { fetchFn: opts?.fetchFn, findPid: opts?.findPid });
  return {
    ok: false,
    started: true,
    status,
    detail: 'Started the process, but it did not answer within 15s — check the `omniroute` logs.',
  };
}

/**
 * Stop the gateway: the process bound to the port first, then a command-line
 * match (a gateway started on a custom port, or one whose API failed to bind).
 */
export async function stopOmniRoute(opts?: {
  port?: number;
  findPidInPort?: (port: number) => Promise<number | null>;
  findPidsInCommandLine?: (pattern: RegExp) => number[];
  stop?: (pid: number) => Promise<boolean>;
}): Promise<StopResult> {
  const port = opts?.port ?? OMNIROUTE_PORT;
  const findPidInPort = opts?.findPidInPort ?? findPidOnPort;
  const findPidsInCommandLine = opts?.findPidsInCommandLine ?? findPidsByCommandLine;
  const stop = opts?.stop ?? stopProcess;
  let pid = await findPidInPort(port);
  if (pid === null) {
    pid = findPidsInCommandLine(/\bomniroute\b/)[0] ?? null;
  }
  if (pid === null) {
    return { stopped: false, reason: `no running OmniRoute process found (port ${port})` };
  }
  const ok = await stop(pid);
  return ok ? { stopped: true, pid } : { stopped: false, pid, reason: 'could not signal the OmniRoute process' };
}
