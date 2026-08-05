/**
 * Unit tests for `buff dashboard --force` helpers (src/cli/dashboard-restart.ts).
 *
 * Covers the port probe that classifies a running server (stale / current /
 * not-a-dashboard / unreachable / unknown), cross-platform PID discovery and
 * kill, the wait-for-port-free poll, and the confirmation prompt (TTY vs
 * non-interactive auto-restart).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const inquirerMock = (await import('inquirer')).default as { prompt: ReturnType<typeof vi.fn> };
const { probeDashboardPortState, findPidOnPort, killPid, waitForPortFree, confirmStaleRestart } =
  await import('../../src/cli/dashboard-restart.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const jsonResponse = (): Response =>
  new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
const htmlResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>SPA</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
const connRefused = (): Promise<never> =>
  Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── probeDashboardPortState ────────────────────────────────────────────────

describe('probeDashboardPortState', () => {
  it('returns unreachable when nothing responds on the port', async () => {
    fetchSpy.mockImplementation(() => connRefused());
    expect(await probeDashboardPortState('127.0.0.1', 3030)).toBe('unreachable');
  });

  it('returns not-a-dashboard when the server is not an Agent-Nuvira dashboard', async () => {
    // Root answers HTML, but neither /api/models nor /api/health returns JSON.
    fetchSpy.mockImplementation((url: string) =>
      url.includes('/api/') ? Promise.resolve(htmlResponse()) : Promise.resolve(htmlResponse()),
    );
    expect(await probeDashboardPortState('127.0.0.1', 3030)).toBe('not-a-dashboard');
  });

  it('returns current-dashboard when /api/model-registry answers JSON', async () => {
    fetchSpy.mockImplementation((url: string) =>
      url.includes('/api/model-registry') ? Promise.resolve(jsonResponse()) : Promise.resolve(jsonResponse()),
    );
    expect(await probeDashboardPortState('127.0.0.1', 3030)).toBe('current-dashboard');
  });

  it('returns stale-dashboard when /api/model-registry answers SPA HTML (API/SSE mismatch)', async () => {
    // The v1.56.1 bug: an OLD dashboard answers the newer route with index.html.
    fetchSpy.mockImplementation((url: string) =>
      url.includes('/api/model-registry') ? Promise.resolve(htmlResponse()) : Promise.resolve(jsonResponse()),
    );
    expect(await probeDashboardPortState('127.0.0.1', 3030)).toBe('stale-dashboard');
  });

  it('returns unknown when the registry probe is inconclusive (timeout/refused mid-probe)', async () => {
    fetchSpy.mockImplementation((url: string) =>
      url.includes('/api/model-registry') ? connRefused() : Promise.resolve(jsonResponse()),
    );
    expect(await probeDashboardPortState('127.0.0.1', 3030)).toBe('unknown');
  });
});

// ─── findPidOnPort ──────────────────────────────────────────────────────────

describe('findPidOnPort', () => {
  it('parses the PID from lsof on POSIX platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockExecSync.mockReturnValue('4242\n');
    expect(await findPidOnPort(3030)).toBe(4242);
    expect(mockExecSync).toHaveBeenCalledWith('lsof -ti tcp:3030', expect.any(Object));
  });

  it('returns null when lsof finds nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockExecSync.mockImplementation(() => {
      throw new Error('lsof: no process');
    });
    expect(await findPidOnPort(3030)).toBeNull();
  });

  it('parses the PID from netstat LISTENING lines on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExecSync.mockReturnValue(
      'TCP    127.0.0.1:3030    0.0.0.0:0    LISTENING    777\n' +
      'TCP    127.0.0.1:3031    0.0.0.0:0    LISTENING    999\n',
    );
    expect(await findPidOnPort(3030)).toBe(777);
  });
});

// ─── killPid ────────────────────────────────────────────────────────────────

describe('killPid', () => {
  it('sends SIGTERM and force-kills only if still alive on POSIX', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string | number) => {
      // Simulate the process disappearing after SIGTERM: the existence check
      // (signal 0) throws ESRCH, so no SIGKILL is needed.
      if (sig === 0) throw new Error('ESRCH');
      return true;
    }) as any);

    expect(await killPid(4242)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('force-kills when the process survives the grace window', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);

    expect(await killPid(4242)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('uses taskkill on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await killPid(4242)).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('taskkill /PID 4242 /F', expect.any(Object));
  });

  it('returns false when the kill is not permitted (EPERM)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(await killPid(4242)).toBe(false);
  });
});

// ─── waitForPortFree ────────────────────────────────────────────────────────

describe('waitForPortFree', () => {
  it('returns true immediately when the port is already refused', async () => {
    fetchSpy.mockImplementation(() => connRefused());
    expect(await waitForPortFree('127.0.0.1', 3030, 1000)).toBe(true);
  });

  it('returns false when the port never frees within the timeout', async () => {
    fetchSpy.mockResolvedValue(htmlResponse());
    expect(await waitForPortFree('127.0.0.1', 3030, 150)).toBe(false);
  });
});

// ─── confirmStaleRestart ────────────────────────────────────────────────────

describe('confirmStaleRestart', () => {
  afterEach(() => {
    // Restore the isTTY property (vitest defaults to undefined → non-TTY).
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  });

  it('auto-restarts without prompting in non-interactive runs (--force is consent)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    expect(await confirmStaleRestart(3030)).toBe(true);
    expect(inquirerMock.prompt).not.toHaveBeenCalled();
  });

  it('prompts and honors a "yes" on a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    inquirerMock.prompt.mockResolvedValue({ restart: true });
    expect(await confirmStaleRestart(3030)).toBe(true);
    expect(inquirerMock.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: 'confirm', name: 'restart' })]),
    );
  });

  it('prompts and honors a "no" on a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    inquirerMock.prompt.mockResolvedValue({ restart: false });
    expect(await confirmStaleRestart(3030)).toBe(false);
  });
});
