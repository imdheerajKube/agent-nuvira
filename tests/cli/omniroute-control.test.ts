/**
 * OmniRoute control — probe / status / start / stop.
 *
 * Every OS-boundary is injected (fetch, spawn, pid lookup, signal) so the suite
 * never touches the network and never starts or kills a real gateway. The two
 * rules worth asserting are (a) a 401 means UP — the gateway is running and just
 * wants a token — and (b) `start` distinguishes "not installed" from "would not
 * come up", because those need different fixes.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  probeOmniRoute,
  omnirouteStatus,
  startOmniRoute,
  stopOmniRoute,
  OMNIROUTE_DEFAULT_URL,
} from '../../src/cli/omniroute-control.js';

type FetchFn = typeof fetch;

const noPid = async () => null;

function fetchReturning(status: number): FetchFn {
  return (async () => new Response('{}', { status })) as unknown as FetchFn;
}

function fetchThrowing(err: Error): FetchFn {
  return (async () => {
    throw err;
  }) as unknown as FetchFn;
}

/** A fake detached child that never errors, so `start` proceeds to polling. */
function fakeChild(): ChildProcess {
  return {
    once: () => undefined,
    unref: () => undefined,
  } as unknown as ChildProcess;
}

describe('probeOmniRoute', () => {
  it('reports reachable on 2xx', async () => {
    const r = await probeOmniRoute(OMNIROUTE_DEFAULT_URL, fetchReturning(200));
    expect(r.reachable).toBe(true);
    expect(r.detail).toContain('200');
  });

  it('treats 401 and 403 as UP — an auth-gated gateway is still running', async () => {
    for (const status of [401, 403]) {
      const r = await probeOmniRoute(OMNIROUTE_DEFAULT_URL, fetchReturning(status));
      expect(r.reachable).toBe(true);
      expect(r.detail).toMatch(/auth-gated/i);
    }
  });

  it('reports not reachable on a 5xx', async () => {
    const r = await probeOmniRoute(OMNIROUTE_DEFAULT_URL, fetchReturning(503));
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('503');
  });

  it('never throws — a connection failure is a failed probe with a reason', async () => {
    const r = await probeOmniRoute(OMNIROUTE_DEFAULT_URL, fetchThrowing(new Error('ECONNREFUSED')));
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain('ECONNREFUSED');
  });

  it('words an aborted probe as a timeout', async () => {
    const r = await probeOmniRoute(OMNIROUTE_DEFAULT_URL, fetchThrowing(new Error('The operation was aborted')));
    expect(r.reachable).toBe(false);
    expect(r.detail).toBe('Timed out');
  });
});

describe('omnirouteStatus', () => {
  it('running when the API answers', async () => {
    const s = await omnirouteStatus(OMNIROUTE_DEFAULT_URL, { fetchFn: fetchReturning(200), findPid: noPid });
    expect(s.reachable).toBe(true);
    expect(s.running).toBe(true);
    expect(s.port).toBe(20128);
  });

  it('running when the API is down but a process holds the port', async () => {
    const s = await omnirouteStatus(OMNIROUTE_DEFAULT_URL, {
      fetchFn: fetchThrowing(new Error('ECONNREFUSED')),
      findPid: async () => 777,
    });
    expect(s.reachable).toBe(false);
    expect(s.running).toBe(true);
    expect(s.pid).toBe(777);
  });

  it('not running when both the API and the port are silent', async () => {
    const s = await omnirouteStatus(OMNIROUTE_DEFAULT_URL, {
      fetchFn: fetchThrowing(new Error('ECONNREFUSED')),
      findPid: noPid,
    });
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });
});

describe('startOmniRoute', () => {
  it('is a no-op when it is already up (does not spawn a second process)', async () => {
    const spawnFn = vi.fn() as unknown as typeof import('node:child_process').spawn;
    const r = await startOmniRoute({
      fetchFn: fetchReturning(200),
      findPid: noPid,
      spawnFn,
    });
    expect(r.ok).toBe(true);
    expect(r.started).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns and waits until the gateway answers', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      // First probe (the pre-check) is down; after spawning, the gateway answers.
      return new Response('{}', { status: calls <= 1 ? 503 : 200 });
    }) as unknown as FetchFn;
    const spawnFn = vi.fn(() => fakeChild()) as unknown as typeof import('node:child_process').spawn;

    const r = await startOmniRoute({ fetchFn, findPid: noPid, spawnFn, waitMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(r.started).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('reports "not installed" clearly when the binary is missing (ENOENT)', async () => {
    // A child whose `once('error')` fires immediately, like a real spawn ENOENT.
    const errChild = {
      once: (event: string, cb: (e: Error) => void) => {
        if (event === 'error') setTimeout(() => cb(new Error('spawn omniroute ENOENT')), 0);
      },
      unref: () => undefined,
    } as unknown as ChildProcess;
    const spawnFn = vi.fn(() => errChild) as unknown as typeof import('node:child_process').spawn;

    const r = await startOmniRoute({
      fetchFn: fetchThrowing(new Error('ECONNREFUSED')),
      findPid: noPid,
      spawnFn,
      waitMs: 500,
    });
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.detail).toContain('npm install -g omniroute');
  });

  it('reports "started but did not answer" when it never comes up', async () => {
    const r = await startOmniRoute({
      fetchFn: fetchThrowing(new Error('ECONNREFUSED')),
      findPid: noPid,
      spawnFn: vi.fn(() => fakeChild()) as unknown as typeof import('node:child_process').spawn,
      waitMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.started).toBe(true);
    expect(r.detail).toMatch(/did not answer/i);
  });
});

describe('stopOmniRoute', () => {
  it('stops the process found on the port', async () => {
    const stop = vi.fn(async () => true);
    const r = await stopOmniRoute({ findPidInPort: async () => 1234, stop });
    expect(r).toEqual({ stopped: true, pid: 1234 });
    expect(stop).toHaveBeenCalledWith(1234);
  });

  it('falls back to a command-line match when nothing holds the port', async () => {
    const stop = vi.fn(async () => true);
    const r = await stopOmniRoute({
      findPidInPort: noPid,
      findPidsInCommandLine: () => [555],
      stop,
    });
    expect(r).toEqual({ stopped: true, pid: 555 });
  });

  it('reports nothing to stop rather than signal an unrelated process', async () => {
    const stop = vi.fn(async () => true);
    const r = await stopOmniRoute({ findPidInPort: noPid, findPidsInCommandLine: () => [], stop });
    expect(r.stopped).toBe(false);
    expect(r.reason).toMatch(/no running OmniRoute/i);
    expect(stop).not.toHaveBeenCalled();
  });
});
